import { VLLMModelBackend } from "./model_backend";
import { ChatMessage, RoleType } from "./typing";
import { parseToolCall, executeTool } from "../chatdev/tools";

export class ChatAgent {
    private roleName: string;
    private roleType: RoleType;
    private systemMessage: ChatMessage;
    private memory: ChatMessage[];
    private backend: VLLMModelBackend;
    public onEvent?: (ev: any) => void;

    constructor(roleName: string, roleType: RoleType, systemMessageContent: string, taskComplexity: string = "Low", modelName?: string) {
        this.roleName = roleName;
        this.roleType = roleType;
        this.systemMessage = { role: "system", content: systemMessageContent };
        this.memory = [this.systemMessage];
        this.backend = new VLLMModelBackend(this.roleName, taskComplexity, modelName);
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

        let responseText = await this.backend.step(this.memory, temperature, onToken);

        // ── Tool execution loop ───────────────────────────────────────────────
        // Each tool call is executed, result injected, and model called again.
        // Loop continues until model produces a response with no tool call.
        let toolCall = parseToolCall(responseText);

        while (toolCall) {
            const toolName = toolCall.name;
            const toolArgs = toolCall.args;

            // Broadcast tool_call event to UI
            this.onEvent?.({
                type: 'tool_call',
                toolName,
                toolArgs,
                role: this.roleName,
            });

            const toolResult = await executeTool(toolCall);

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

            responseText = await this.backend.step(this.memory, temperature, onToken);

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