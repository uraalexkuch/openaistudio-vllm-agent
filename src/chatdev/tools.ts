import { web_search } from "../tools/web_search";
import { delegate_to_expert } from "../tools/delegate_to_expert";
import { launch_file } from "../tools/launch_file";
import { saveSkill } from "./skills";
import { executeBashInWorkspace, verifyFile } from "../tools/execute_sandbox";
import * as fs from 'fs';
import * as path from 'path';

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
    // Strip inner <args>...</args> wrapper if present
    const inner = s.replace(/^<args>([\s\S]*?)<\/args>$/i, '$1').trim();
    try { return JSON.parse(inner || '{}'); } catch { return { query: inner }; }
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
            try { return { name, args: JSON.parse(s1[2].trim()) }; }
            catch { return { name, args: { query: s1[2].trim() } }; }
        }
    }

    // Strategy 2: <tool_call>...<known_name>...(optional <args>)...</known_name>...</tool_call>
    const s2re = new RegExp(
        `<tool_call>[\\s\\S]*?<(${knownRe})>([\\s\\S]*?)<\/\\1>[\\s\\S]*?<\/tool_call>`, 'i'
    );
    const s2 = responseText.match(s2re);
    if (s2) {
        return { name: s2[1].trim(), args: tryParseArgs(s2[2]) };
    }

    // Strategy 3: bare <known_name>...</known_name> anywhere
    const s3re = new RegExp(`<(${knownRe})>([\\s\\S]*?)<\/\\1>`, 'i');
    const s3 = responseText.match(s3re);
    if (s3) {
        return { name: s3[1].trim(), args: tryParseArgs(s3[2]) };
    }

    // Strategy 4: self-closing <known_name/> or <known_name attr="..."/>
    const s4re = new RegExp(`<(${knownRe})\\s*(?:[^/]*)?/>`, 'i');
    const s4 = responseText.match(s4re);
    if (s4) {
        return { name: s4[1].trim(), args: {} };
    }

    return null;
}


// ── Workspace helpers ─────────────────────────────────────────────────────────

function getWorkspaceRoot(): string {
    return path.resolve(path.join(__dirname, '..', 'workspace'));
}

/**
 * Resolves a user-supplied filename to an absolute path.
 * If the filename is already absolute (e.g., C:\path\to\file or /path/to/file), it returns it as is.
 * Otherwise, it resolves it relative to the workspace directory.
 * NOTE: Absolute paths are now allowed as per user request to enable full disk interaction.
 */
function resolveToolPath(filename: string): string {
    if (path.isAbsolute(filename)) {
        return filename;
    }
    const root       = getWorkspaceRoot();
    const normalised = filename.replace(/\\/g, '/').replace(/^\/+/, '');
    return path.resolve(root, normalised);
}

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
                const filename = String(toolCall.args.filename ?? '').trim();
                if (!filename) return 'write_file error: "filename" argument is required.';

                const filePath = resolveToolPath(filename);

                // FIX: create all parent directories, not just workspace root
                fs.mkdirSync(path.dirname(filePath), { recursive: true });

                const content = toolCall.args.content ?? '';
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

                const filePath = resolveToolPath(filename);
                if (!fs.existsSync(filePath)) {
                    return `read_file error: "${filename}" does not exist in workspace.`;
                }
                const content = fs.readFileSync(filePath, 'utf8');
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
                const dirPath = subdir ? resolveToolPath(subdir) : root;

                if (!dirPath) return 'list_files error: directory escapes workspace.';
                if (!fs.existsSync(dirPath)) return `list_files: directory "${subdir || '.'}" does not exist.`;

                const entries: string[] = [];
                const walk = (dir: string, prefix: string) => {
                    for (const entry of fs.readdirSync(dir)) {
                        const full = path.join(dir, entry);
                        const rel  = prefix ? `${prefix}/${entry}` : entry;
                        if (fs.statSync(full).isDirectory()) {
                            entries.push(`📁 ${rel}/`);
                            walk(full, rel);
                        } else {
                            const size = fs.statSync(full).size;
                            entries.push(`📄 ${rel} (${(size / 1024).toFixed(1)} KB)`);
                        }
                    }
                };
                walk(dirPath, '');
                return entries.length
                    ? `workspace/${subdir || ''}:\n${entries.join('\n')}`
                    : `workspace/${subdir || ''} is empty.`;
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
        "<tool_call>",
        "<n>TOOL_NAME</n>",
        '<args>{"arg1": "value1"}</args>',
        "</tool_call>",
        "",
        "Wait for <tool_result> before the next call.",
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
        "RULES:",
        "1. Filename specified → call write_file with EXACT name.",
        "   Nested paths like \"src/components/Button.tsx\" are fully supported.",
        "2. Demo/launch/запусти/відкрий requested → call launch_file AFTER write_file succeeds.",
        "3. NEVER print file content in markdown when filename was specified.",
        "4. One tool call per turn — wait for <tool_result> before the next.",
        "5. After launching, append <DONE> to complete the phase.",
    ].join("\n");
}