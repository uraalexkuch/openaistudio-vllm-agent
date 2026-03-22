// Copyright (c) 2026 Юрій Кучеренко.
import { web_search } from "../tools/web_search";
import { delegate_to_expert } from "../tools/delegate_to_expert";
import { launch_file } from "../tools/launch_file";
import { saveSkill } from "./skills";
import { executeBashInWorkspace, verifyFile } from "../tools/execute_sandbox";
import * as fs from 'fs';
import * as path from 'path';
import { resolveToolPath, getWorkspaceRoot } from "../utils/path_utils";

export interface ToolCall {
    name: string;
    args: any;
}

// All tool names the system knows about — used for fallback bare-tag parsing
const KNOWN_TOOL_NAMES = [
    'write_file', 'read_file', 'list_files', 'make_directory',
    'launch_file', 'execute_bash', 'verify_file',
    'web_search', 'delegate_to_expert', 'save_skill',
].join('|');

function tryParseArgs(raw: string): any {
    const s = raw.trim();
    if (!s) return {};
    // Відкидаємо обгортку <args>...</args>, якщо вона є
    const inner = s.replace(/^<args>([\s\S]*?)<\/args>$/i, '$1').trim();
    
    try { 
        return JSON.parse(inner || '{}'); 
    } catch {
        // === РЕЖИМ ПОРЯТУНКУ (MANUAL EXTRACTION) ===
        let filename = "";
        let content = "";
        let hasData = false;

        // 1. Надійно витягуємо filename
        const fnMatch = inner.match(/"filename"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (fnMatch) {
            filename = fnMatch[1].replace(/\\\\/g, '\\');
            hasData = true;
        }

        // 2. Витягуємо content, стійко до "зламаних" лапок всередині коду
        const contentStartMatch = inner.match(/"content"\s*:\s*"/);
        if (contentStartMatch) {
            const startIdx = contentStartMatch.index! + contentStartMatch[0].length;
            
            // Шукаємо закриваючі лапки З КІНЦЯ рядка (зазвичай це " } або "\n})
            const tailMatch = inner.substring(startIdx).match(/"\s*\}?\s*$/);
            let endIdx = tailMatch ? (startIdx + tailMatch.index!) : inner.lastIndexOf('"');
            
            // Якщо лапок не знайдено (наприклад, генерація обірвалась через ліміт токенів)
            if (endIdx <= startIdx) {
                endIdx = inner.length;
            }

            let rawContent = inner.substring(startIdx, endIdx);

            // EDGE CASE: Що, якщо модель написала "filename" ПІСЛЯ "content"?
            // e.g. {"content": "...code...", "filename": "test.ts"}
            const reversedOrderMatch = rawContent.match(/",\s*"filename"\s*:\s*"[^"]*$/);
            if (reversedOrderMatch) {
                // Відрізаємо хвіст з filename від нашого контенту
                rawContent = rawContent.substring(0, reversedOrderMatch.index);
                
                // Якщо ми раніше не зловили filename, ловимо його зараз
                if (!filename) {
                    const lateFnMatch = reversedOrderMatch[0].match(/"filename"\s*:\s*"((?:[^"\\]|\\.)*)"/);
                    if (lateFnMatch) filename = lateFnMatch[1].replace(/\\\\/g, '\\');
                }
            }

            content = rawContent
                .replace(/\\n/g, '\n')
                .replace(/\\t/g, '\t')
                .replace(/\\"/g, '"')
                .replace(/\\r/g, '')
                .replace(/\\\\/g, '\\');
            hasData = true;
        }

        if (hasData) {
            return { filename, content };
        }

        // Якщо взагалі нічого не знайшли, повертаємо як є
        return { query: inner };
    }
}

/**
 * Multi-strategy tool call parser.
 * Handles all formats observed in production:
 *   1. <tool_call><n>name</n><args>{}</args></tool_call>  — standard
 *   2. <tool_call><name>...</name></tool_call>            — tag IS name, with/without <args>
 *   3. <name>...</name>                                   — bare tag, no tool_call wrapper
 *   4. <name/>  <name attr="v"/>                          — self-closing
 */
export function parseToolCall(responseText: string): ToolCall | null {
    const knownRe = KNOWN_TOOL_NAMES;

    // Strategy 1: standard <tool_call><anyTag>name</anyTag><args>{}</args></tool_call>
    const s1 = responseText.match(/<tool_call>[\s\S]*?<\w+>([\s\S]*?)<\/\w+>[\s\S]*?<args>([\s\S]*?)<\/args>[\s\S]*?<\/tool_call>/i);
    if (s1) {
        const name = s1[1].trim();
        if (name) {
            // ВИПРАВЛЕНО: Тепер використовуємо tryParseArgs замість прямого JSON.parse, 
            // щоб задіяти логіку порятунку (manual extraction) для write_file
            return { name, args: tryParseArgs(s1[2]) };
        }
    }

    // Strategy 2: <tool_call>...<known_name>...(optional <args>)...</known_name>...</tool_call>
    // FIX: more tolerant to extra tags/whitespace after closing tag
    const s2re = new RegExp(
        `<tool_call>[\\s\\S]*?<(${knownRe})>([\\s\\S]*?)<\/\\1>[\\s\\S]*?<\/tool_call>`, 'i'
    );
    const s2 = responseText.match(s2re);
    if (s2) {
        return { name: s2[1].trim(), args: tryParseArgs(s2[2]) };
    }

    // Strategy 2b: <tool_call><name>...<args>...</args></args></tool_call> (extra closing tag)
    const s2bRe = new RegExp(`<tool_call>\\s*<(${knownRe})>\\s*<args>([\\s\\S]*?)<\\/args>\\s*<\\/args>\\s*<\\/\\1>\\s*<\\/tool_call>`, 'i');
    const s2b = responseText.match(s2bRe);
    if (s2b) return { name: s2b[1].trim(), args: tryParseArgs(s2b[2]) };

    // Strategy 2c: <tool_call><known_name>...<args>...</args></tool_call> (missing closing name tag)
    const s2cRe = new RegExp(`<tool_call>\\s*<(${knownRe})>\\s*<args>([\\s\\S]*?)<\\/args>\\s*<\\/tool_call>`, 'i');
    const s2c = responseText.match(s2cRe);
    if (s2c) return { name: s2c[1].trim(), args: tryParseArgs(s2c[2]) };

    // Strategy 3: bare <known_name>...</known_name> anywhere
    // FIX: ensure we don't match tags inside markdown code blocks
    const s3re = new RegExp(`<(${knownRe})>([\\s\\S]*?)<\/\\1>`, 'gi');
    let match;
    while ((match = s3re.exec(responseText)) !== null) {
        const fullMatch = match[0];
        const matchIndex = match.index;
        
        // Simple check: is this match inside a ``` block?
        const textBefore = responseText.substring(0, matchIndex);
        const codeBlockCount = (textBefore.match(/```/g) || []).length;
        if (codeBlockCount % 2 === 0) {
            return { name: match[1].trim(), args: tryParseArgs(match[2]) };
        }
    }

    // Strategy 4: self-closing <known_name/> or <known_name attr="..."/>
    const s4re = new RegExp(`<(${knownRe})\\s*(?:[^/]*)?/>`, 'i');
    const s4 = responseText.match(s4re);
    if (s4) {
        return { name: s4[1].trim(), args: {} };
    }

    // Strategy 5: ```tool_code ... ``` or ```python ... ``` with write_file patterns
    const pythonBlock = responseText.match(
        /```(?:tool_code|python)\s*([\s\S]*?)```/i
    );
    if (pythonBlock) {
        const code = pythonBlock[1];
        // Match open('filename', 'w') and f.write("""content""")
        const openMatch = code.match(
            /open\(\s*["']([^"']+)["']\s*,\s*["']w["']/
        );
        const contentMatch = code.match(
            /(?:f\.write|content\s*=)\s*(?:"""|\(""")([\s\S]*?)(?:"""\)|""")/
        );
        if (openMatch && contentMatch) {
            return {
                name: 'write_file',
                args: {
                    filename: openMatch[1],
                    content: contentMatch[1],
                }
            };
        }
    }

    // Strategy 5b: gemma Python-style call — list_files({"directory": "..."})
    const pyCallRe = new RegExp(
        `(?:^|\\n)\\s*(${knownRe})\\s*\\(([^)]*)\\)`, 'i'
    );
    const s5b = responseText.match(pyCallRe);
    if (s5b) {
        const name = s5b[1].trim();
        const rawArgs = s5b[2].trim();
        if (!rawArgs) return { name, args: {} };
        // ВИПРАВЛЕНО: Аналогічно пропускаємо через tryParseArgs
        return { name, args: tryParseArgs(rawArgs) };
    }

    // Strategy 6: bare JSON {"name": "list_files", "arguments": {...}}
    const jsonFmtRe = /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"(?:arguments|args)"\s*:\s*(\{[\s\S]*?\})\s*\}/;
    const s6 = responseText.match(jsonFmtRe);
    if (s6) {
        const name = s6[1].trim();
        if (KNOWN_TOOL_NAMES.split('|').includes(name)) {
            try { return { name, args: JSON.parse(s6[2]) }; } catch {}
        }
    }

    // Strategy 7: ```tool_code { "name": "...", "arguments": {...} } ```
    const toolCodeJson = responseText.match(/```(?:tool_code|tool|json)?\s*(\{[\s\S]*?"name"[\s\S]*?\})\s*```/i);
    if (toolCodeJson) {
        try {
            const obj = JSON.parse(toolCodeJson[1]);
            const name = String(obj.name ?? obj.tool ?? '').trim();
            const args = obj.arguments ?? obj.args ?? {};
            if (name && KNOWN_TOOL_NAMES.split('|').includes(name)) return { name, args };
        } catch {}
    }

    // Strategy 8: bare tool name + JSON on next line
    const s8re = new RegExp(`(?:^|\\n)\\s*(${knownRe})\\s*\\n\\s*(\\{[\\s\\S]*?\\})`, 'i');
    const s8 = responseText.match(s8re);
    if (s8) {
        try {
            return { name: s8[1].trim(), args: JSON.parse(s8[2]) };
        } catch {}
    }

    return null;
}


// ── Workspace helpers — now using src/utils/path_utils ───────────────────────

export async function executeTool(toolCall: ToolCall): Promise<string> {
    switch (toolCall.name) {
        case "web_search":
            return await web_search(toolCall.args.query);
        case "delegate_to_expert":
            return await delegate_to_expert(toolCall.args.expert_role, toolCall.args.task_description);
        case "save_skill":
            return await saveSkill(toolCall.args.name, toolCall.args.description, toolCall.args.content);

        case "write_file": {
            try {
                let filename = String(toolCall.args.filename ?? '').trim();
                let content  = toolCall.args.content ?? '';

                // Fallback: recovery if args were wrapped in {query: "...JSON..."}
                if (!filename && toolCall.args.query) {
                    try {
                        const recovered = JSON.parse(toolCall.args.query);
                        filename = String(recovered.filename ?? '').trim();
                        content  = recovered.content ?? '';
                    } catch {
                        // ignore and fall through to missing filename error
                    }
                }

                if (!filename) return 'write_file error: "filename" argument is required.';

                const filePath = resolveToolPath(filename);

                // FIX: create all parent directories, not just workspace root
                fs.mkdirSync(path.dirname(filePath), { recursive: true });

                fs.writeFileSync(filePath, content, 'utf8');

                const sizeKb = (Buffer.byteLength(content, 'utf8') / 1024).toFixed(1);
                return `File "${filename}" saved successfully. Path: ${filePath} (${sizeKb} KB)`;
            } catch (err: any) {
                return `write_file error: ${err.message}`;
            }
        }

        case "read_file": {
            try {
                const filename = String(toolCall.args.filename ?? '').trim();
                if (!filename) return 'read_file error: "filename" argument is required.';

                const filePath = resolveToolPath(filename, true);
                if (!fs.existsSync(filePath)) {
                    return `read_file error: "${filename}" does not exist in workspace.`;
                }
                const content = fs.readFileSync(filePath, 'utf8');
                const MAX_READ_CHARS = 8000; // ~2700 tokens
                if (content.length > MAX_READ_CHARS) {
                    return `=== ${filename} (first ${MAX_READ_CHARS} characters of ${content.length}) ===\n` +
                           content.substring(0, MAX_READ_CHARS) + '\n…[truncated]';
                }
                return `=== ${filename} ===\n${content}`;
            } catch (err: any) {
                return `read_file error: ${err.message}`;
            }
        }

        case "list_files": {
            // List files in workspace (or a subdirectory)
            try {
                const root    = getWorkspaceRoot();
                const subdir  = toolCall.args.directory ? String(toolCall.args.directory).trim() : '';
                const dirPath = subdir ? resolveToolPath(subdir, true) : root;

                if (!dirPath) return 'list_files error: directory escapes workspace.';
                if (!fs.existsSync(dirPath)) return `list_files: directory "${subdir || '.'}" does not exist.`;

                const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '__pycache__', '.adminjs', '.venv', 'venv']);
                const entries: string[] = [];
                let totalCount = 0;

                const walk = (dir: string, prefix: string, depth = 0) => {
                    if (depth > 5) return; // limit depth to prevent infinite loops or huge outputs
                    try {
                        const items = fs.readdirSync(dir);
                        for (const entry of items) {
                            if (SKIP_DIRS.has(entry)) continue; 
                            totalCount++;
                            const full = path.join(dir, entry);
                            const rel  = prefix ? `${prefix}/${entry}` : entry;
                            try {
                                if (fs.statSync(full).isDirectory()) {
                                    entries.push(`📁 ${rel}/`);
                                    walk(full, rel, depth + 1);
                                } else {
                                    const size = fs.statSync(full).size;
                                    entries.push(`📄 ${rel} (${(size / 1024).toFixed(1)} KB)`);
                                }
                            } catch (e: any) {
                                entries.push(`⚠️ ${rel} (exception: ${e.code || 'error'})`);
                            }
                        }
                    } catch (e: any) {
                        entries.push(`⚠️ ${prefix || dir} (access denied: ${e.code || 'error'})`);
                    }
                };
                walk(dirPath, '');

                const MAX_ENTRIES = 200;
                if (entries.length > MAX_ENTRIES) {
                    const shown = entries.slice(0, MAX_ENTRIES);
                    shown.push(`…(shown ${MAX_ENTRIES} of ${entries.length} files total)`);
                    const isAbsolutePath = subdir && path.isAbsolute(subdir);
                    const displayPrefix = isAbsolutePath ? subdir : `workspace/${subdir || ''}`;
                    return `${displayPrefix}:\n${shown.join('\n')}`;
                }
                const isAbsolutePath = subdir && path.isAbsolute(subdir);
                const displayPrefix = isAbsolutePath ? subdir : `workspace/${subdir || ''}`;
                return entries.length
                    ? `${displayPrefix}:\n${entries.join('\n')}`
                    : `${displayPrefix} is empty.`;
            } catch (err: any) {
                return `list_files error: ${err.message}`;
            }
        }

        case "make_directory": {
            try {
                const dirname = String(toolCall.args.directory ?? '').trim();
                if (!dirname) return 'make_directory error: "directory" argument is required.';
                const dirPath = resolveToolPath(dirname);
                fs.mkdirSync(dirPath, { recursive: true });
                return `Directory "${dirname}" created (path: ${dirPath}).`;
            } catch (err: any) {
                return `make_directory error: ${err.message}`;
            }
        }

        case "launch_file":
            return await launch_file(toolCall.args.filename);
        case "execute_bash":
            return await executeBashInWorkspace(toolCall.args.command);
        case "verify_file":
            return await verifyFile(toolCall.args.filename);

        default:
            return `Unknown tool: "${toolCall.name}". Available: write_file, read_file, list_files, make_directory, launch_file, execute_bash, verify_file, web_search, delegate_to_expert, save_skill`;
    }
}

export function getToolsDescription(): string {
    return [
        "You have access to tools. To call a tool output EXACTLY this XML (one call per turn):",
        "",
        "CORRECT (only accepted format):",
        "<tool_call>",
        "<n>list_files</n>",
        '<args>{"directory": "src"}</args>',
        "</tool_call>",
        "",
        "Wait for <tool_result> before the next call.",
        "",
        "WRONG - will be ignored:",
        "  <tool_call><list_files><args>{...}</args></args></tool_call>  (double tags)",
        "  {\"name\": \"list_files\", \"arguments\": {...}}                   (JSON format)",
        "  ```tool_code\n{...}\n```                                     (code block)",
        "",
        "TOOLS:",
        "  write_file     — Save a file (creates parent dirs automatically).",
        "                   Args: {\"filename\": \"src/components/App.tsx\", \"content\": \"...\"}",
        "                   Nested paths AND absolute paths (C:\\... or /...) supported.",
        "",
        "  read_file      — Read a workspace file or an absolute path.",
        "                   Args: {\"filename\": \"src/App.tsx\"} or {\"filename\": \"C:\\Users\\...\"}",
        "",
        "  list_files     — List files in workspace (or any directory).",
        "                   Args: {\"directory\": \"src\"} or {\"directory\": \"D:\\Dev\\...\"}",
        "",
        "  make_directory — Create a directory (and parents) in workspace or at absolute path.",
        "                   Args: {\"directory\": \"src/components\"} or {\"directory\": \"/tmp/test\"}",
        "",
        "  launch_file    — Open HTML in browser, other files in VS Code.",
        "                   Args: {\"filename\": \"index.html\"}",
        "",
        "  execute_bash   — Run a shell command in workspace (25s timeout).",
        "                   Args: {\"command\": \"npm install\"}",
        "",
        "  verify_file    — Check HTML structure / run JS / run .py.",
        "                   Args: {\"filename\": \"index.html\"}",
        "",
        "  web_search     — Args: {\"query\": \"...\"}",
        "",
        "  delegate_to_expert — Args: {\"expert_role\": \"...\", \"task_description\": \"...\"}",
        "",
        "",
        "PROJECT ANALYST MANDATORY RULES:",
        "1. You MUST call tools to read actual files.",
        "2. Do NOT write documentation based on assumptions or imagination.",
        "3. Do NOT invent file contents or dependencies.",
        "4. FIRST call list_files, THEN read_file for each key file found.",
        "5. ONLY THEN write your analysis based on ACTUAL file contents.",
        "",
        "RULES:",
        "1. Filename specified → call write_file with EXACT name.",
        "   Nested paths like \"src/components/Button.tsx\" are fully supported.",
        "2. Demo/launch/запусти/відкрий requested → call launch_file AFTER write_file succeeds.",
        "3. NEVER print file content in markdown when filename was specified.",
        "4. One tool call per turn — wait for <tool_result> before the next.",
        "5. After launching, append <DONE> to complete the phase.",
        `DOCUMENTATION RULES:`,
        `- Read at most 5 files before writing documentation.`,
        `- After reading 3+ files you have enough context to write.`,
        `- If you already read a file → DO NOT read it again.`,
        `- Write documentation FIRST, improve later if needed.`,
        ``,
        `=== CORRECT FORMAT ===`,
        "7. NEVER use: ```tool_code {\"name\": \"list_files\", \"arguments\": {...}}```",
        "8. NEVER use: {\"name\": \"list_files\", \"arguments\": {...}}",
        "9. ALWAYS use ONLY this XML format:",
        `   <tool_call><n>list_files</n><args>{\"directory\": \"...\"}</args></tool_call>`,
        ``,
        "GEMMA-SPECIFIC REMINDER:",
        "If you are using gemma model — these formats are REJECTED:",
        "  WRONG: ```tool_code",
        "  WRONG: list_files({\"directory\": \"...\"})",
        "  WRONG: {\"name\": \"list_files\", \"arguments\": {...}}",
        "CORRECT (only this):",
        "  <tool_call><n>list_files</n><args>{\"directory\": \"...\"}</args></tool_call>",
        "10. Any other format will be IGNORED and the task will fail.",
        "11. Python os.makedirs(), open(), write() — FORBIDDEN. Use write_file tool instead.",
    ].join("\n");
}