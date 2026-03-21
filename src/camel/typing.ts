export enum RoleType {
    ASSISTANT = "assistant",
    USER = "user",
    SYSTEM = "system",
    DEFAULT = "default"
}

export enum TaskType {
    OPENAISTUDIO = "openaistudio",
    DEFAULT = "default"
}

export interface ChatMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

export interface AgentEvent {
    type: 'step' | 'thinking' | 'tool_call' | 'tool_result' | 'answer' | 'error' | 'done' | 'narration';
    content?: string;
    role?: string;
    model?: string;
    toolName?: string;
    toolArgs?: any;
    ok?: boolean;
    step?: number;
    totalSteps?: number;
}

