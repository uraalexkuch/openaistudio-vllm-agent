// Copyright (c) 2026 Юрій Кучеренко.
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
    type:
        | 'step'
        | 'thinking'
        | 'tool_call'
        | 'tool_result'
        | 'answer'
        | 'answer_stream_start'   // FIX: was missing — used in phase.ts
        | 'answer_stream_chunk'   // FIX: was missing from union (implied but not declared)
        | 'answer_stream_end'     // FIX: was missing — used in phase.ts
        | 'error'
        | 'done'
        | 'narration';
    content?: string;
    role?: string;
    model?: string;
    toolName?: string;
    toolArgs?: any;
    ok?: boolean;
    step?: number;
    totalSteps?: number;
}