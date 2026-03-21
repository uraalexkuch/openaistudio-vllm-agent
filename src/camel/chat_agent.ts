import { VLLMModelBackend } from "./model_backend";
import { ChatMessage, RoleType } from "./typing";
import { parseToolCall, executeTool } from "../chatdev/tools";

export class ChatAgent {
    private roleName: string;
    private roleType: RoleType;
    private systemMessage: ChatMessage;
    private memory: ChatMessage[];
    private backend: VLLMModelBackend;

    constructor(roleName: string, roleType: RoleType, systemMessageContent: string) {
        this.roleName = roleName;
        this.roleType = roleType;
        
        this.systemMessage = {
            role: "system",
            content: systemMessageContent
        };
        
        // Initialize memory with system message
        this.memory = [this.systemMessage];
        this.backend = new VLLMModelBackend(this.roleName);
    }

    /**
     * Дає змогу динамічно додавати контекст (наприклад, skills) до системного промпту
     */
    addSystemContext(context: string) {
        this.systemMessage.content += `\n\n${context}`;
        // Update memory[0]
        if (this.memory[0] && this.memory[0].role === "system") {
            this.memory[0].content = this.systemMessage.content;
        }
    }

    /**
     * Adds a new message from another agent (or user) and asks vLLM for a response.
     */
    async step(incomingMessage: string, temperature = 0.2, onToken?: (token: string) => void): Promise<string> {
        // Add the incoming message to memory
        this.memory.push({
            role: "user",
            content: incomingMessage
        });

        // Request generation from vLLM
        let responseText = await this.backend.step(this.memory, temperature, onToken);

        // Tool retry loop
        let toolCall = parseToolCall(responseText);
        while (toolCall) {
            const toolResult = await executeTool(toolCall);
            
            // Add tool result to memory
            this.memory.push({
                role: "assistant",
                content: responseText
            });
            this.memory.push({
                role: "user", // or system/tool if API supports it, using user for compatible structure
                content: `<tool_result>\n${toolResult}\n</tool_result>\nContinue based on this result.`
            });

            // Call vLLM again
            responseText = await this.backend.step(this.memory, temperature, onToken);
            toolCall = parseToolCall(responseText);
        }

        // Add the agent's final response to memory
        this.memory.push({
            role: "assistant",
            content: responseText
        });

        return responseText;
    }
    
    getRoleName(): string {
        return this.roleName;
    }
    
    getModelName(): string {
        return this.backend.getModelName();
    }
    
    getMemory(): ChatMessage[] {
        return this.memory;
    }
}
