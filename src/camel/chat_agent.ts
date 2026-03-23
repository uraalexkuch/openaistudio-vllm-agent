// Copyright (c) 2026 Юрій Кучеренко.
import { VLLMModelBackend } from "./model_backend";
import { ChatMessage, RoleType } from "./typing";
import { parseToolCall, executeTool } from "../chatdev/tools";

export class ChatAgent {
    private roleName: string;
    private roleType: RoleType;
    private systemMessage: ChatMessage;
    private memory: ChatMessage[];
    private backend: VLLMModelBackend;
    private readHistory: Set<string> = new Set();
    public onEvent?: (ev: any) => void;

    constructor(
        roleName: string, 
        roleType: RoleType, 
        systemMessageContent: string, 
        taskComplexity: string = "Low", 
        modelName: string = ""
    ) {
        // Initialize agent with role and model details
        this.roleName = roleName;
        this.roleType = roleType;
        this.systemMessage = { role: "system", content: systemMessageContent };
        this.memory = [this.systemMessage];
        this.backend = new VLLMModelBackend(this.roleName, taskComplexity ?? "Low", modelName);
    }

    addSystemContext(context: string) {
        this.systemMessage.content += `\n\n${context}`;
        if (this.memory[0]?.role === "system") {
            this.memory[0].content = this.systemMessage.content;
        }
    }

    async step(
        incomingMessage: string,
        temperature = 0.2,
        onToken?: (token: string) => void
    ): Promise<string> {
        this.memory.push({ role: "user", content: incomingMessage });

        // FIX: Memory leak prevention - trim memory if it gets too long.
        // Keep system message (index 0) + last 30 messages.
        const MAX_MEMORY = 30;
        if (this.memory.length > MAX_MEMORY + 1) {
            // Remove messages starting from index 1 (after system)
            // number of items to remove = current length - system - max allowed
            const toRemove = this.memory.length - (MAX_MEMORY + 1);
            this.memory.splice(1, toRemove);
        }

        let responseRaw = await this.backend.step(this.memory, temperature, onToken);
        let responseText = stripFakeResults(responseRaw);

        // ── Tool execution loop ───────────────────────────────────────────────
        // Each tool call is executed, result injected, and model called again.
        // Loop continues until model produces a response with no tool call.
        let toolCall = parseToolCall(responseText);
        const MAX_TOOL_ITERATIONS = 10;
        let toolIterations = 0;

        while (toolCall && toolIterations < MAX_TOOL_ITERATIONS) {
            toolIterations++;

            if (toolIterations >= MAX_TOOL_ITERATIONS) {
                this.onEvent?.({
                    type: 'narration',
                    content: `⚠️ Tool loop limit (${MAX_TOOL_ITERATIONS}) reached — stopping to prevent infinite loop.`
                });
                break;
            }

            const toolName = toolCall.name;
            const toolArgs = toolCall.args;

            // Broadcast tool_call event to UI
            this.onEvent?.({
                type: 'tool_call',
                toolName,
                toolArgs,
                role: this.roleName,
            });

            let toolResult: string = "";
            const filePath = toolArgs.filename || toolArgs.file || toolArgs.path;

            // ── Read History Logic ────────────────────────────────────────────────
            // Prevent infinite loops within the SAME turn, but allow re-reading
            // across different turns (since memory may have been trimmed).
            const isReadLoop = toolName === 'read_file' && filePath && this.memory.some(m => 
                m.role === 'assistant' && 
                m.content.includes(`<tool_call><n>read_file</n><args>{"filename": "${filePath}"}</args></tool_call>`)
            );

            if (toolName === 'read_file' && filePath && isReadLoop && toolIterations > 1) {
                toolResult = `FILE [${filePath}] WAS ALREADY READ IN THIS TURN. ` +
                            `Please use the content provided in the previous <tool_result>. ` +
                            `Do NOT try to read it again. Proceed to analysis or other files.`;
            } else {
                if (toolName === 'read_file' && filePath) this.readHistory.add(filePath);
                toolResult = await executeTool(toolCall);
            }

            // Broadcast tool_result event to UI so user sees what happened
            this.onEvent?.({
                type: 'tool_result',
                toolName,
                content: toolResult,
                role: this.roleName,
            });

            // Add the model's tool-call response to memory as assistant turn
            this.memory.push({ role: "assistant", content: responseText });

            // Inject tool result as user turn — clearly formatted
            // "Continue based on this result" nudges the model to proceed
            // (e.g. call launch_file after write_file succeeds)
            this.memory.push({
                role: "user",
                content: `<tool_result>\n${toolResult}\n</tool_result>\nContinue based on this result.`
            });

            // Ask model for next action (may be another tool call or final response)
            this.onEvent?.({
                type: 'answer_stream_start',
                role: this.roleName,
                model: this.backend.getModelName(),
            });

            let nextResponseRaw = await this.backend.step(this.memory, temperature, onToken);
            responseText = stripFakeResults(nextResponseRaw);

            this.onEvent?.({ type: 'answer_stream_end' });

            toolCall = parseToolCall(responseText);
        }

        // Add final response to memory
        this.memory.push({ role: "assistant", content: responseText });

        return responseText;
    }

    getRoleName(): string { return this.roleName; }
    getModelName(): string { return this.backend.getModelName(); }
    getMemory(): ChatMessage[] { return this.memory; }
}

/**
 * Truncates text after XML tool call tags or code blocks to prevent hallucinated results.
 */
function stripFakeResults(text: string): string {
    const xmlEnd = text.indexOf('</tool_call>');
    if (xmlEnd !== -1) return text.substring(0, xmlEnd + 12);

    const jsonEnd = text.match(/```(?:tool_code|json|tool)?\s*\{[\s\S]*?\}\s*```/i);
    if (jsonEnd) {
        const lastIndex = text.indexOf(jsonEnd[0]) + jsonEnd[0].length;
        return text.substring(0, lastIndex);
    }

    const pyCall = text.match(/\b([a-z_]+)\s*\(([^)]*)\)/i);
    if (pyCall) {
        // Truncate after first Python call line
        const idx = text.indexOf(pyCall[0]) + pyCall[0].length;
        return text.substring(0, idx);
    }

    return text;
}