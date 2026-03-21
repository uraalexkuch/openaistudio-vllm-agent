import { web_search } from "../tools/web_search";
import { delegate_to_expert } from "../tools/delegate_to_expert";
import { launch_file } from "../tools/launch_file";
import { saveSkill } from "./skills";
import * as fs from 'fs';
import * as path from 'path';

export interface ToolCall {
    name: string;
    args: any;
}

export function parseToolCall(responseText: string): ToolCall | null {
    // Regex matches <name>toolname</name> — both tags must be "name".
    // Schema in getToolsDescription() uses the same tag so models output correctly.
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
                if (!fs.existsSync(filePath)) return `Error: File "${toolCall.args.filename}" does not exist in workspace.`;
                return `File content of "${toolCall.args.filename}":\n${fs.readFileSync(filePath, 'utf8')}`;
            } catch (err: any) { return `Error reading file: ${err.message}`; }
        }
        case "launch_file":
            return await launch_file(toolCall.args.filename);
        default:
            return `Unknown tool: "${toolCall.name}". Available: write_file, read_file, launch_file, web_search, delegate_to_expert, save_skill`;
    }
}

export function getToolsDescription(): string {
    return [
        "You have access to tools. To call a tool output EXACTLY this XML (one call per turn, nothing else on that turn):",
        "",
        "<tool_call>",
        "<name>TOOL_NAME</name>",
        '<args>{"arg1": "value1"}</args>',
        "</tool_call>",
        "",
        "After each tool call you will receive a <tool_result> block. Read it before the next action.",
        "",
        "AVAILABLE TOOLS:",
        "",
        "  write_file   — Save content to a file in the workspace.",
        '                 Args: {"filename": "game.html", "content": "<full file content>"}',
        "",
        "  read_file    — Read a file from the workspace.",
        '                 Args: {"filename": "game.html"}',
        "",
        "  launch_file  — Open HTML in the browser, other files in VS Code.",
        '                 Args: {"filename": "game.html"}',
        "",
        "  web_search   — Search the web.",
        '                 Args: {"query": "..."}',
        "",
        "  delegate_to_expert — Sub-delegate a subtask.",
        '                 Args: {"expert_role": "...", "task_description": "..."}',
        "",
        "MANDATORY RULES:",
        "1. Task specifies a filename → call write_file with that EXACT filename.",
        "2. Task says run/launch/demo/запусти/відкрий → call launch_file AFTER write_file succeeds.",
        "3. NEVER print file content in markdown when a filename was specified.",
        "4. One tool call per turn. Wait for <tool_result> before the next call.",
        "5. If write_file returns an error → fix the error before calling launch_file.",
    ].join("\n");
}