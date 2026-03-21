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
        default:
            return `Unknown tool: "${toolCall.name}". Available: write_file, read_file, launch_file, web_search, delegate_to_expert, save_skill`;
    }
}

/**
 * Single source of truth for tool schema injected into agent prompts.
 */
export function getToolsDescription(): string {
    return `
You have access to tools. To call a tool output EXACTLY this XML (one per turn, nothing else around it):

<tool_call>
<name>TOOL_NAME</name>
<args>{"arg1": "value1"}</args>
</tool_call>

TOOLS:
  write_file   — Save a file to the workspace.
                 Args: {"filename": "chrestik.html", "content": "<full file content>"}

  read_file    — Read a workspace file.
                 Args: {"filename": "chrestik.html"}

  launch_file  — Open an HTML file in the browser, other files in VS Code.
                 Args: {"filename": "chrestik.html"}

  web_search   — Search the web.
                 Args: {"query": "..."}

  delegate_to_expert — Sub-delegate to a specialist agent.
                 Args: {"expert_role": "...", "task_description": "..."}

MANDATORY RULES (task is NOT complete until these are done):
1. Task names a file → call write_file with that exact name.
2. Task says run/launch/demo/запусти/відкрий → call launch_file after write_file.
3. Never just print code in markdown when a filename was specified.
4. One tool call per turn — wait for <tool_result> before the next.
`.trim();
}