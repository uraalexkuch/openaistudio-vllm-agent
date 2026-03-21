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

export function parseToolCall(responseText: string): ToolCall | null {
    // Flexible: matches <n>tool</n> OR <n>tool</name> — handles model tag inconsistencies
    const regex = /<tool_call>[\s\S]*?<\w+>(.*?)<\/\w+>[\s\S]*?<args>([\s\S]*?)<\/args>[\s\S]*?<\/tool_call>/i;
    const match = responseText.match(regex);
    if (match) {
        try {
            return { name: match[1].trim(), args: JSON.parse(match[2].trim()) };
        } catch (e) {
            return { name: match[1].trim(), args: { query: match[2].trim() } };
        }
    }
    return null;
}


// ── Workspace helpers ─────────────────────────────────────────────────────────

function getWorkspaceRoot(): string {
    return path.resolve(path.join(__dirname, '..', 'workspace'));
}

/**
 * Resolves a user-supplied filename to an absolute path inside workspace/.
 * Prevents path traversal (e.g. "../../../etc/passwd").
 * Normalises forward/back slashes for cross-platform safety.
 * Returns null if the resolved path escapes the workspace root.
 */
function resolveWorkspacePath(filename: string): string | null {
    const root      = getWorkspaceRoot();
    // Normalise separators then resolve relative to workspace root
    const normalised = filename.replace(/\\/g, '/').replace(/^\/+/, '');
    const resolved   = path.resolve(root, normalised);
    // Ensure the resolved path is actually inside workspace/
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
        return null; // path traversal attempt
    }
    return resolved;
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

                const filePath = resolveWorkspacePath(filename);
                if (!filePath) {
                    return `write_file error: filename "${filename}" attempts to escape the workspace directory.`;
                }

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

                const filePath = resolveWorkspacePath(filename);
                if (!filePath) {
                    return `read_file error: filename "${filename}" attempts to escape the workspace directory.`;
                }
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
                const dirPath = subdir ? resolveWorkspacePath(subdir) : root;

                if (!dirPath) return 'list_files error: directory escapes workspace.';
                if (!fs.existsSync(dirPath)) return `list_files: directory "${subdir || '.'}" does not exist.`;

                const entries: string[] = [];
                function walk(dir: string, prefix: string) {
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
                }
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
                const dirPath = resolveWorkspacePath(dirname);
                if (!dirPath) return `make_directory error: directory escapes workspace.`;
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
        "                   Nested paths supported: e.g. \"src/utils/helpers.js\"",
        "",
        "  read_file      — Read a workspace file.",
        "                   Args: {\"filename\": \"src/App.tsx\"}",
        "",
        "  list_files     — List files in workspace (or subdirectory).",
        "                   Args: {\"directory\": \"src\"}  or  {}  for root",
        "",
        "  make_directory — Create a directory (and parents) in workspace.",
        "                   Args: {\"directory\": \"src/components\"}",
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