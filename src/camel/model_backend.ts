import OpenAI from "openai";
import * as vscode from "vscode";
import { ChatMessage } from "./typing";

export class VLLMModelBackend {
    public static currentTaskComplexity: string = "High";
    private openai: OpenAI;
    private model: string;
    private maxTokens: number;

    constructor(roleName = "default") {
        // Read the configuration from VS Code settings
        // 1. Get raw URL from config
        const config = vscode.workspace.getConfiguration("openaistudio");
        let rawBaseURL = config.get<string>("vllmUrl", "http://10.1.0.102:8050").trim();
        const apiKey = config.get<string>("apiKey", "EMPTY").trim();
        const defaultModel = config.get<string>("model", "gemma").trim();

        console.log(`VLLMModelBackend: Initializing for role ${roleName}. Default model: ${defaultModel}`);

        // 2. Dynamic Dispatcher (MODEL_ROUTING)
        const roleLower = roleName.toLowerCase();
        const isComplex = VLLMModelBackend.currentTaskComplexity === "High";

        if (roleLower.includes("chief") || roleLower.includes("executive") || roleLower.includes("analyzer")) {
            // CEO/Analyzer - switching to gemma for 16k context (Mistral is only 4k)
            this.model = "gemma";
            this.maxTokens = 16384;
        } else if (roleLower.includes("programmer")) {
            // Qwen-code is 0.76s, Codestral is 1.96s
            this.model = isComplex ? "codestral" : "qwen-code";
            this.maxTokens = 32000;
        } else if (roleLower.includes("reviewer") || roleLower.includes("qa") || roleLower.includes("test")) {
            this.model = "qwen-code";
            this.maxTokens = 32000;
        } else if (roleLower.includes("technology") || roleLower.includes("cto")) {
            this.model = isComplex ? "codestral" : "qwen-code";
            this.maxTokens = 32000;
        } else {
            // Documenter, CCO, etc.
            this.model = defaultModel; // e.g. gemma
            this.maxTokens = 16384;
        }

        this.model = this.model.trim();

        // 3. Construct dynamic baseURL: http://IP:PORT/<model>/v1
        let base = rawBaseURL.replace(/\/+$/, "").replace(/\/v1$/, "");

        let finalBaseURL: string;
        if (base.toLowerCase().endsWith(this.model.toLowerCase())) {
            finalBaseURL = `${base}/v1`;
        } else {
            finalBaseURL = `${base}/${this.model}/v1`;
        }

        finalBaseURL = finalBaseURL.replace(/([^:]\/)\/+/g, "$1");

        console.log(`VLLMModelBackend: [${roleName}] rawURL: ${rawBaseURL} -> Final URL: ${finalBaseURL}`);
        console.log(`VLLMModelBackend: Using Model: "${this.model}"`);

        this.openai = new OpenAI({
            baseURL: finalBaseURL,
            apiKey: apiKey,
        });

        console.log(`VLLMModelBackend: OpenAI client initialized for ${finalBaseURL}`);
    }

    public getModelName(): string {
        return this.model;
    }

    async step(messages: ChatMessage[], temperature = 0.2, onToken?: (token: string) => void): Promise<string> {
        try {
            // Compatibility Fix: Strictly alternate roles user/assistant.
            // Some vLLM models (Mistral) throw 400 if roles don't alternate or system is present.
            let processedMessages: any[] = [];

            // 1. Handle system message by merging it into the first user message
            let systemContent = "";
            let originalMessages = [...messages];

            if (originalMessages.length > 0 && originalMessages[0].role === "system") {
                systemContent = originalMessages[0].content;
                originalMessages.shift();
            }

            // 2. Merge consecutive messages of the same role
            for (const msg of originalMessages) {
                if (processedMessages.length > 0 && processedMessages[processedMessages.length - 1].role === msg.role) {
                    processedMessages[processedMessages.length - 1].content += "\n\n" + msg.content;
                } else {
                    processedMessages.push({ role: msg.role, content: msg.content });
                }
            }

            // 3. If we had a system message, inject it into the first message (which must be 'user')
            if (systemContent) {
                if (processedMessages.length > 0 && processedMessages[0].role === "user") {
                    processedMessages[0].content = `[SYSTEM]\n${systemContent}\n\n[USER]\n${processedMessages[0].content}`;
                } else {
                    // If no user message yet, or first is assistant (unlikely), prepend a user message
                    processedMessages.unshift({ role: "user", content: `[SYSTEM]\n${systemContent}` });
                }
            }

            // 4. Ensure it starts with 'user' (some backends require this)
            if (processedMessages.length > 0 && processedMessages[0].role === "assistant") {
                processedMessages.unshift({ role: "user", content: "Continue." });
            }

            // 5. Final Safety Truncation: Ensure we don't exceed the model's absolute character limit
            // A rough estimate: 4 chars per token.
            const charLimit = this.maxTokens * 4;
            let totalChars = processedMessages.reduce((sum, m) => sum + m.content.length, 0);

            if (totalChars > charLimit) {
                console.warn(`VLLMModelBackend: Truncating request from ${totalChars} to ${charLimit} chars.`);
                // Keep the most recent messages, but always keep the first one (which contains system instructions now)
                while (totalChars > charLimit && processedMessages.length > 2) {
                    const removed = processedMessages.splice(1, 1)[0];
                    totalChars -= removed.content.length;
                }
                // If still too long, truncate the messages themselves
                if (totalChars > charLimit) {
                    for (let i = processedMessages.length - 1; i >= 0 && totalChars > charLimit; i--) {
                        const originalLen = processedMessages[i].content.length;
                        const newLen = Math.max(0, originalLen - (totalChars - charLimit));
                        processedMessages[i].content = processedMessages[i].content.substring(0, newLen);
                        totalChars -= (originalLen - newLen);
                    }
                }
            }

            // 6. FIX: Dynamically budget output tokens so input + output never exceeds maxTokens.
            //    Estimate input tokens at ~4 chars/token, then leave the remainder for output,
            //    capped at 70% of maxTokens so responses don't exhaust the whole window.
            const CHARS_PER_TOKEN = 4;
            const SAFETY_MARGIN   = 64; // small buffer to absorb tokenizer rounding
            const estimatedInputTokens = Math.ceil(totalChars / CHARS_PER_TOKEN) + SAFETY_MARGIN;
            const availableForOutput   = this.maxTokens - estimatedInputTokens;
            const maxOutputTokens70pct = Math.floor(this.maxTokens * 0.7);
            const requestedOutputTokens = Math.max(
                256,  // always allow at least a short reply
                Math.min(maxOutputTokens70pct, availableForOutput)
            );

            console.log(
                `VLLMModelBackend [${this.model}]: estimatedInput=${estimatedInputTokens} ` +
                `available=${availableForOutput} requestedOutput=${requestedOutputTokens}`
            );

            if (onToken) {
                const stream = await this.openai.chat.completions.create({
                    model: this.model,
                    messages: processedMessages,
                    temperature: temperature,
                    max_tokens: requestedOutputTokens,
                    stream: true
                });

                let fullText = "";
                for await (const chunk of stream) {
                    const token = chunk.choices[0]?.delta?.content || "";
                    fullText += token;
                    onToken(token);
                }
                return fullText;
            } else {
                const response = await this.openai.chat.completions.create({
                    model: this.model,
                    messages: processedMessages,
                    temperature: temperature,
                    max_tokens: requestedOutputTokens
                });
                return response.choices[0].message?.content || "";
            }

        } catch (error) {
            console.error(`Error communicating with vLLM API (Model: ${this.model}):`, error);
            vscode.window.showErrorMessage(`vLLM Error (${this.model}): ${error}`);
            throw error;
        }
    }
}