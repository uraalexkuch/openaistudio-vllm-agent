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
    const regex = /<tool_call>[\s\S]*?<name>(.*?)<\/name>[\s\S]*?<args>([\s\S]*?)<\/args>[\s\S]*?<\/tool_call>/i;
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
                const workspaceFolder = path.join(__dirname, '..', '..', 'workspace');
                if (!fs.existsSync(workspaceFolder)) fs.mkdirSync(workspaceFolder, { recursive: true });
                fs.writeFileSync(path.join(workspaceFolder, toolCall.args.filename), toolCall.args.content, 'utf8');
                return `File "${toolCall.args.filename}" saved successfully to workspace.`;
            } catch (err: any) { return `Error saving file: ${err.message}`; }
        }
        case "read_file": {
            try {
                const workspaceFolder = path.join(__dirname, '..', '..', 'workspace');
                const filePath = path.join(workspaceFolder, toolCall.args.filename);
                if (!fs.existsSync(filePath)) return `Error: File "${toolCall.args.filename}" does not exist.`;
                return `File content of "${toolCall.args.filename}":\n${fs.readFileSync(filePath, 'utf8')}`;
            } catch (err: any) { return `Error reading file: ${err.message}`; }
        }
        case "launch_file":
            return await launch_file(toolCall.args.filename);
        case "execute_bash":
            return await executeBashInWorkspace(toolCall.args.command);

        case "verify_file":
            return await verifyFile(toolCall.args.filename);

        default:
            return `Unknown tool: "${toolCall.name}". Available: write_file, read_file, launch_file, execute_bash, verify_file, web_search, delegate_to_expert, save_skill`;
    }
}

export function getToolsDescription(): string {
    return [
        "You have access to tools. To call a tool output EXACTLY this XML (one call per turn):",
        "",
        "<tool_call>",
        "<name>TOOL_NAME</name>",
        '<args>{"arg1": "value1"}</args>',
        "</tool_call>",
        "",
        "Wait for <tool_result> before the next call.",
        "",
        "TOOLS:",
        "  write_file    — Save a file. Args: {\"filename\": \"app.js\", \"content\": \"...\"}" ,
        "  read_file     — Read a file. Args: {\"filename\": \"app.js\"}",
        "  launch_file   — Open HTML in browser. Args: {\"filename\": \"index.html\"}",
        "  execute_bash  — Run a shell command in the workspace directory (25s timeout, 512KB output cap).",
        "                  Args: {\"command\": \"node app.js\"}",
        "                  Use for: node script.js, npm install, npm test, python app.py, compile, lint.",
        "  web_search    — Args: {\"query\": \"...\"}" ,
        "  delegate_to_expert — Args: {\"expert_role\": \"...\", \"task_description\": \"...\"}",
        "",
        "RULES:",
        "1. Filename specified → call write_file with EXACT name.",
        "2. Demo/launch requested → call launch_file AFTER write_file succeeds.",
        "3. NEVER print file content in markdown when filename was specified.",
        "4. After write_file → call verify_file to auto-check the file before launch_file.",
        "5. One tool call per turn.",
    ].join("\n");
}