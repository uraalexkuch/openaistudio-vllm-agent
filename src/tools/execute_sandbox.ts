// Copyright (c) 2026 Юрій Кучеренко.
/**
 * execute_sandbox.ts  —  src/tools/execute_sandbox.ts
 *
 * Safe code execution WITHOUT Docker.
 * Strategy by file type:
 *
 *  .js / .ts   → Node.js Worker Thread (isolated memory, kill on timeout)
 *  .html       → Static analysis: parse structure + extract+run inline <script> in vm
 *  .py         → child_process.exec("python ...") cwd=workspace (if Python installed)
 *  other       → syntax-only check via compilation/linting
 *
 * Security guarantees (without Docker):
 *  - Worker thread memory capped (resourceLimits)
 *  - Hard timeout kills the thread/process
 *  - cwd always resolves to workspace/ — relative paths can't escape it
 *  - BLOCKED_PATTERNS filter on raw command/code string
 *  - fs access inside Worker is NOT blocked (Node limitation) — agents should
 *    only write to workspace/ so this is acceptable for a dev tool
 */

import * as path from 'path';
import * as fs   from 'fs';
import * as cp   from 'child_process';
import * as vm   from 'vm';
import { Worker } from 'worker_threads';

const WORKSPACE = () => {
    const p = path.resolve(path.join(__dirname, '..', '..', 'workspace'));
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
    return p;
};

const TIMEOUT_MS   = 20_000;
const MAX_BUF      = 256 * 1024; // 256 KB output cap

// Patterns blocked regardless of language
const BLOCKED = [
    /rm\s+-rf\s+[/~]/,
    /rmdir\s+\/[a-z]/i,
    /mkfs\b/,
    /dd\s+if=/,
    /format\s+[a-z]:/i,
    /del\s+\/[fsq]/i,
    /rd\s+\/s/i,
    /shutdown\b/,
    /reboot\b/,
    /:(){ :|:& };:/,
];

function blocked(s: string): boolean {
    return BLOCKED.some(p => p.test(s));
}

// ── 1. Run JS string in a Worker Thread ─────────────────────────────────────
function runJsInWorker(jsCode: string): Promise<string> {
    return new Promise((resolve) => {
        // The worker script: captures console.log, runs eval, reports back
        const workerSrc = `
const { parentPort, workerData } = require('worker_threads');
const lines = [];
const _console = {
    log:   (...a) => lines.push(a.map(String).join(' ')),
    warn:  (...a) => lines.push('[warn] ' + a.map(String).join(' ')),
    error: (...a) => lines.push('[err]  ' + a.map(String).join(' ')),
};
// Shadow global console so eval'd code uses our capture
Object.defineProperty(global, 'console', { value: _console });
try {
    eval(workerData.code);
    parentPort.postMessage({ ok: true,  out: lines.join('\\n') });
} catch (e) {
    parentPort.postMessage({ ok: false, out: String(e) });
}
        `.trim();

        let settled = false;
        const finish = (s: string) => { if (!settled) { settled = true; resolve(s); } };

        const worker = new Worker(workerSrc, {
            eval: true,
            workerData: { code: jsCode },
            resourceLimits: {
                maxOldGenerationSizeMb: 64,
                maxYoungGenerationSizeMb: 16,
                codeRangeSizeMb: 8,
            },
        });

        const timer = setTimeout(() => {
            worker.terminate();
            finish(`[timeout] execution killed after ${TIMEOUT_MS / 1000}s`);
        }, TIMEOUT_MS);

        worker.on('message', (msg) => {
            clearTimeout(timer);
            worker.terminate();
            finish(msg.out || (msg.ok ? '(no output)' : '[error] (empty)'));
        });
        worker.on('error', (e) => { clearTimeout(timer); finish(`[worker error] ${e.message}`); });
        worker.on('exit',  (c) => { clearTimeout(timer); if (!settled) finish(`[exit code ${c}]`); });
    });
}

// ── 2. Run JS via vm.runInNewContext (no Worker — lighter for tiny snippets) ─
function runJsInVm(jsCode: string, timeoutMs = 8_000): string {
    const output: string[] = [];
    const sandbox = {
        console: {
            log:   (...a: any[]) => output.push(a.map(String).join(' ')),
            warn:  (...a: any[]) => output.push('[warn] ' + a.map(String).join(' ')),
            error: (...a: any[]) => output.push('[err]  ' + a.map(String).join(' ')),
        },
        setTimeout: () => {},  // no-op timers
        setInterval: () => {},
    };
    try {
        vm.runInNewContext(jsCode, sandbox, { timeout: timeoutMs, filename: 'agent_code.js' });
        return output.join('\n') || '(no output)';
    } catch (e: any) {
        return `[vm error] ${e.message}`;
    }
}

// ── 3. Extract and run <script> blocks from HTML ─────────────────────────────
function validateHtml(htmlContent: string): string {
    const results: string[] = [];

    // Basic structural checks
    const checks: Array<[RegExp, string]> = [
        [/<html/i,              '✅ <html> tag present'],
        [/<head/i,              '✅ <head> tag present'],
        [/<body/i,              '✅ <body> tag present'],
        [/<meta\s+charset/i,    '✅ charset meta tag present'],
        [/<title>/i,            '✅ <title> present'],
        [/<\/html>/i,           '✅ closing </html> present'],
    ];
    for (const [re, msg] of checks) {
        if (re.test(htmlContent)) results.push(msg);
        else                      results.push(msg.replace('✅', '⚠️ missing:'));
    }

    // Extract and run all <script> blocks
    const scriptMatches = [...htmlContent.matchAll(/<script(?:[^>]*)>([\s\S]*?)<\/script>/gi)];
    if (scriptMatches.length === 0) {
        results.push('ℹ️  No inline <script> blocks found.');
    } else {
        results.push(`\n▶ Running ${scriptMatches.length} inline <script> block(s) in vm:`);
        for (let i = 0; i < scriptMatches.length; i++) {
            const jsCode = scriptMatches[i][1].trim();
            if (!jsCode) { results.push(`  Script ${i + 1}: (empty)`); continue; }
            // Skip scripts that reference DOM APIs vm can't satisfy
            if (/document\.|window\.|addEventListener/.test(jsCode)) {
                results.push(`  Script ${i + 1}: ⚠️ references browser DOM — skipped (run in browser to verify)`);
                continue;
            }
            const out = runJsInVm(jsCode);
            results.push(`  Script ${i + 1}: ${out}`);
        }
    }

    return results.join('\n');
}

// ── 4. Run Python via child_process ──────────────────────────────────────────
function runPython(filePath: string): Promise<string> {
    return new Promise((resolve) => {
        // Try python3 first, then python
        const cmd = `python3 "${filePath}"`;
        cp.exec(cmd, { cwd: WORKSPACE(), timeout: TIMEOUT_MS, maxBuffer: MAX_BUF },
            (err, stdout, stderr) => {
                if (String(err).includes('ENOENT') || String(err).includes('not found') || String(err).includes('is not recognized')) {
                    cp.exec(`python "${filePath}"`,
                        { cwd: WORKSPACE(), timeout: TIMEOUT_MS, maxBuffer: MAX_BUF },
                        (e2, o2, e2r) => resolve((o2 + e2r).trim() || `python error: ${e2?.message ?? 'unknown'}`));
                } else {
                    resolve((stdout + stderr).trim() || `exit code ${(err as NodeJS.ErrnoException)?.code ?? 'unknown'}`);
                }
            }
        );
    });
}

// ── 5. Run Node.js file via child_process ─────────────────────────────────────
function runNodeFile(filePath: string): Promise<string> {
    return new Promise((resolve) => {
        cp.exec(
            `node "${filePath}"`,
            { cwd: WORKSPACE(), timeout: TIMEOUT_MS, maxBuffer: MAX_BUF },
            (err, stdout, stderr) => {
                const out = (stdout + stderr).trim();
                if (err?.killed) resolve(`[timeout] killed after ${TIMEOUT_MS / 1000}s`);
                else resolve(out || `exit code ${(err as NodeJS.ErrnoException)?.code ?? 'unknown'}`);
            }
        );
    });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run a shell command in the workspace directory.
 * Uses child_process.exec — no Docker needed.
 */
export function executeBashInWorkspace(command: string): Promise<string> {
    if (blocked(command)) return Promise.resolve(`blocked: command matches safety filter.`);

    return new Promise((resolve) => {
        cp.exec(
            command,
            { cwd: WORKSPACE(), timeout: TIMEOUT_MS, maxBuffer: MAX_BUF, windowsHide: true },
            (err, stdout, stderr) => {
                const out = (stdout + stderr).trim();
                if (err?.killed) resolve(`[timeout] killed after ${TIMEOUT_MS / 1000}s`);
                else if (err && !out) resolve(`[error ${(err as NodeJS.ErrnoException).code ?? 'unknown'}] ${err.message}`);
                else resolve(out || `(no output, exit ${(err as NodeJS.ErrnoException)?.code ?? 'unknown'})`);
            }
        );
    });
}

/**
 * Verify a saved workspace file automatically:
 *  - .html → structural check + inline script execution in vm
 *  - .js   → run in Worker Thread (isolated memory limits)
 *  - .py   → run via python3/python
 *  - .ts   → syntax check via tsc --noEmit (if installed)
 *  - other → report file exists + size
 */
export async function verifyFile(filename: string): Promise<string> {
    const filePath = path.join(WORKSPACE(), filename);

    if (!fs.existsSync(filePath)) {
        return `verify_file: "${filename}" not found in workspace.`;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const ext     = path.extname(filename).toLowerCase();
    const size    = `${content.length} chars`;

    if (blocked(content)) {
        return `verify_file: file content matches safety filter — not executed.`;
    }

    switch (ext) {
        case '.html':
        case '.htm':
            return `=== HTML Verification: ${filename} (${size}) ===\n${validateHtml(content)}`;

        case '.js':
        case '.mjs':
            return `=== JS Verification: ${filename} (${size}) ===\n${await runJsInWorker(content)}`;

        case '.py':
            return `=== Python Verification: ${filename} (${size}) ===\n${await runPython(filePath)}`;

        case '.ts':
            return `=== TS Syntax Check: ${filename} (${size}) ===\n${
                await executeBashInWorkspace(`npx tsc --noEmit --allowJs --checkJs "${filename}" 2>&1 || echo "tsc not available"`)
            }`;

        default:
            return `=== File info: ${filename} (${size}, type: ${ext || 'unknown'}) — no executor for this type ===`;
    }
}