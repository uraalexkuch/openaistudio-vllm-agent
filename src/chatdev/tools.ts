import { web_search } from "../tools/web_search";
import { delegate_to_expert } from "../tools/delegate_to_expert";
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
            return {
                name: match[1].trim(),
                args: JSON.parse(match[2].trim())
            };
        } catch (e) {
            console.error("Failed to parse tool args", e);
            // Fallback for simple string args
            return {
                name: match[1].trim(),
                args: { query: match[2].trim() }
            };
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
        case "write_file":
            try {
                // Ensure output directory exists or use a workspace
                const workspaceFolder = path.join(__dirname, '..', '..', 'workspace');
                if (!fs.existsSync(workspaceFolder)) fs.mkdirSync(workspaceFolder, { recursive: true });
                fs.writeFileSync(path.join(workspaceFolder, toolCall.args.filename), toolCall.args.content, 'utf8');
                return `File ${toolCall.args.filename} successfully saved.`;
            } catch (err: any) {
                return `Error saving file: ${err.message}`;
            }
        case "read_file":
            try {
                const workspaceFolder = path.join(__dirname, '..', '..', 'workspace');
                const filePath = path.join(workspaceFolder, toolCall.args.filename);
                if (!fs.existsSync(filePath)) {
                    return `Error: File ${toolCall.args.filename} does not exist.`;
                }
                const content = fs.readFileSync(filePath, 'utf8');
                return `File content of ${toolCall.args.filename}:\n${content}`;
            } catch (err: any) {
                return `Error reading file: ${err.message}`;
            }
        default:
            return `Unknown tool: ${toolCall.name}`;
    }
}
