import OpenAI from "openai";
import * as vscode from "vscode";
import { ChatMessage } from "./typing";

// Conservative chars-per-token ratio.
// Ukrainian/Cyrillic text tokenises to MORE tokens per character than English,
// so using 3 (instead of the typical English estimate of 4) keeps us safely
// under the context limit even with mixed-language prompts.
const CHARS_PER_TOKEN = 3;

// Extra token buffer to absorb tokeniser rounding and special tokens
// (BOS, EOS, role headers, etc. added by vLLM's chat template).
const TOKENIZER_OVERHEAD = 256;

// Maximum fraction of the context window dedicated to output.
const MAX_OUTPUT_FRACTION = 0.65;

export class VLLMModelBackend {
    public static currentTaskComplexity: string = "High";
    private openai: OpenAI;
    private model: string;
    private maxTokens: number;

    constructor(roleName = "default") {
        const config = vscode.workspace.getConfiguration("openaistudio");
        let rawBaseURL = config.get<string>("vllmUrl", "http://10.1.0.102:8050").trim();
        const apiKey = config.get<string>("apiKey", "EMPTY").trim();
        const defaultModel = config.get<string>("model", "gemma").trim();

        console.log(`VLLMModelBackend: Initializing for role ${roleName}. Default model: ${defaultModel}`);

        const roleLower = roleName.toLowerCase();
        const isComplex = VLLMModelBackend.currentTaskComplexity === "High";

        if (roleLower.includes("chief") || roleLower.includes("executive") || roleLower.includes("analyzer")) {
            this.model = "gemma";
            this.maxTokens = 16384;
        } else if (roleLower.includes("programmer")) {
            this.model = isComplex ? "codestral" : "qwen-code";
            this.maxTokens = 32000;
        } else if (roleLower.includes("reviewer") || roleLower.includes("qa") || roleLower.includes("test")) {
            this.model = "qwen-code";
            this.maxTokens = 32000;
        } else if (roleLower.includes("technology") || roleLower.includes("cto")) {
            this.model = isComplex ? "codestral" : "qwen-code";
            this.maxTokens = 32000;
        } else {
            this.model = defaultModel;
            this.maxTokens = 16384;
        }

        this.model = this.model.trim();

        let base = rawBaseURL.replace(/\/+$/, "").replace(/\/v1$/, "");
        let finalBaseURL: string;
        if (base.toLowerCase().endsWith(this.model.toLowerCase())) {
            finalBaseURL = `${base}/v1`;
        } else {
            finalBaseURL = `${base}/${this.model}/v1`;
        }
        finalBaseURL = finalBaseURL.replace(/([^:]\/)\/+/g, "$1");

        console.log(`VLLMModelBackend: [${roleName}] rawURL: ${rawBaseURL} -> Final URL: ${finalBaseURL}`);
        console.log(`VLLMModelBackend: Using Model: "${this.model}", maxTokens: ${this.maxTokens}`);

        this.openai = new OpenAI({ baseURL: finalBaseURL, apiKey });
    }

    public getModelName(): string {
        return this.model;
    }

    /**
     * Estimates token count from a character count.
     * Uses a conservative ratio so we never underestimate.
     */
    private estimateTokens(chars: number): number {
        return Math.ceil(chars / CHARS_PER_TOKEN) + TOKENIZER_OVERHEAD;
    }

    async step(messages: ChatMessage[], temperature = 0.2, onToken?: (token: string) => void): Promise<string> {
        try {
            let processedMessages: any[] = [];

            // 1. Extract system message
            let systemContent = "";
            let originalMessages = [...messages];
            if (originalMessages.length > 0 && originalMessages[0].role === "system") {
                systemContent = originalMessages[0].content;
                originalMessages.shift();
            }

            // 2. Merge consecutive same-role messages
            for (const msg of originalMessages) {
                if (processedMessages.length > 0 && processedMessages[processedMessages.length - 1].role === msg.role) {
                    processedMessages[processedMessages.length - 1].content += "\n\n" + msg.content;
                } else {
                    processedMessages.push({ role: msg.role, content: msg.content });
                }
            }

            // 3. Inject system message into first user message
            if (systemContent) {
                if (processedMessages.length > 0 && processedMessages[0].role === "user") {
                    processedMessages[0].content = `[SYSTEM]\n${systemContent}\n\n[USER]\n${processedMessages[0].content}`;
                } else {
                    processedMessages.unshift({ role: "user", content: `[SYSTEM]\n${systemContent}` });
                }
            }

            // 4. Ensure starts with 'user'
            if (processedMessages.length > 0 && processedMessages[0].role === "assistant") {
                processedMessages.unshift({ role: "user", content: "Continue." });
            }

            // 5. Truncate input so estimated tokens fit within budget.
            //    Reserve MAX_OUTPUT_FRACTION of the context for output upfront,
            //    so the input budget is the remainder.
            const maxInputTokens = Math.floor(this.maxTokens * (1 - MAX_OUTPUT_FRACTION)) - TOKENIZER_OVERHEAD;
            const maxInputChars  = maxInputTokens * CHARS_PER_TOKEN;

            let totalChars = processedMessages.reduce((sum, m) => sum + m.content.length, 0);

            if (totalChars > maxInputChars) {
                console.warn(`VLLMModelBackend [${this.model}]: Input ${totalChars} chars > budget ${maxInputChars}. Truncating.`);
                while (totalChars > maxInputChars && processedMessages.length > 2) {
                    const removed = processedMessages.splice(1, 1)[0];
                    totalChars -= removed.content.length;
                }
                if (totalChars > maxInputChars) {
                    for (let i = processedMessages.length - 1; i >= 0 && totalChars > maxInputChars; i--) {
                        const originalLen = processedMessages[i].content.length;
                        const newLen = Math.max(0, originalLen - (totalChars - maxInputChars));
                        processedMessages[i].content = processedMessages[i].content.substring(0, newLen);
                        totalChars -= (originalLen - newLen);
                    }
                }
            }

            // 6. Compute output budget from actual (post-truncation) input estimate.
            const estimatedInputTokens = this.estimateTokens(totalChars);
            const availableForOutput   = this.maxTokens - estimatedInputTokens;
            const maxOutputByFraction  = Math.floor(this.maxTokens * MAX_OUTPUT_FRACTION);
            const requestedOutputTokens = Math.max(
                256,
                Math.min(maxOutputByFraction, availableForOutput)
            );

            console.log(
                `VLLMModelBackend [${this.model}]: chars=${totalChars} ` +
                `~estimatedInput=${estimatedInputTokens} tokens, ` +
                `requestedOutput=${requestedOutputTokens} tokens ` +
                `(total budget: ${this.maxTokens})`
            );

            if (onToken) {
                const stream = await this.openai.chat.completions.create({
                    model: this.model,
                    messages: processedMessages,
                    temperature,
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
                    temperature,
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