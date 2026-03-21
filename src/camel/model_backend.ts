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
    private model: string;     // API model name sent in request body
    private urlPath: string;   // nginx path segment  (may differ from model name!)
    private maxTokens: number;

    constructor(roleName = "default") {
        const config = vscode.workspace.getConfiguration("openaistudio");
        const rawBaseURL = config.get<string>("vllmUrl", "http://10.1.0.102:8050").trim();
        const apiKey     = config.get<string>("apiKey",  "EMPTY").trim();

        // ── Verified server inventory (2026-03-19) ──────────────────────────
        //
        //  nginx path   │ API model name  │ Max tokens │ Avg latency │ Use for
        //  ─────────────┼─────────────────┼────────────┼─────────────┼──────────────────────
        //  /mistral     │ mistral         │  4 096     │   0.296 s   │ CEO routing (JSON)
        //  /qwen-code   │ qwen3-coder     │ 32 768     │   0.765 s   │ fast coding (Low)
        //  /qwen        │ qwen            │ 16 384     │   0.961 s   │ general reasoning
        //  /codestral   │ codestral       │ 32 768     │   1.969 s   │ heavy coding (High)
        //  /gemma       │ gemma           │ 16 384     │   2.123 s   │ writer / CPO / docs
        //  /bge-m3      │ bge-m3          │  8 192     │   0.022 s   │ embedding only
        //
        // ⚠️  qwen-code path ≠ qwen3-coder model name — kept separate below.
        // ── Configurable overrides ───────────────────────────────────────────
        const modelRouter    = config.get<string>("modelRouter",    "mistral").trim();
        const modelCodeHeavy = config.get<string>("modelCodeHeavy", "codestral").trim();
        const modelCodeLight = config.get<string>("modelCodeLight", "qwen-code").trim();
        const modelGeneral   = config.get<string>("modelGeneral",   "gemma").trim();

        // ── URL-path → API-model-name map ────────────────────────────────────
        // When nginx path and vLLM model id differ, list the mapping here.
        // Format:  "nginx-path-segment": "vllm-model-id"
        const PATH_TO_MODEL: Record<string, string> = {
            "qwen-code": "qwen3-coder",
            // add more if needed, e.g. "deepseek": "deepseek-coder-v2"
        };

        // ── Context window sizes per nginx path ──────────────────────────────
        const PATH_CONTEXT: Record<string, number> = {
            "mistral":    4_096,
            "qwen-code": 32_768,
            "qwen":      16_384,
            "codestral": 32_768,
            "gemma":     16_384,
        };

        const roleLower = roleName.toLowerCase();
        const isComplex = VLLMModelBackend.currentTaskComplexity === "High";

        // ── Role → path assignment ────────────────────────────────────────────
        let chosenPath: string;

        if (roleLower.includes("chief") || roleLower.includes("executive") || roleLower.includes("analyzer")) {
            // Must return JSON fast — mistral wins at 0.296s
            // maxTokens capped at 2048 (well under mistral's 4096 hard limit)
            chosenPath = modelRouter;
        } else if (
            roleLower.includes("programmer") ||
            roleLower.includes("technology") ||
            roleLower.includes("cto")
        ) {
            // Complex: codestral (32k, most capable code model on server)
            // Simple:  qwen-code/qwen3-coder (32k, 0.765s — fast enough)
            chosenPath = isComplex ? modelCodeHeavy : modelCodeLight;
        } else if (
            roleLower.includes("reviewer") ||
            roleLower.includes("qa")       ||
            roleLower.includes("test")     ||
            roleLower.includes("database") ||
            roleLower.includes("security") ||
            roleLower.includes("cyber")
        ) {
            // Same logic: heavy review → codestral, light review → qwen3-coder
            chosenPath = isComplex ? modelCodeHeavy : modelCodeLight;
        } else {
            // Technical Writer, CPO, general roles → gemma
            chosenPath = modelGeneral;
        }

        this.urlPath   = chosenPath.trim();
        this.model     = PATH_TO_MODEL[this.urlPath] ?? this.urlPath; // resolve model id for API body
        this.maxTokens = PATH_CONTEXT[this.urlPath]  ?? 16_384;

        // CEO hard cap: leave room for output within mistral's 4096 total
        if (this.urlPath === "mistral") {
            this.maxTokens = 4_096;
        }

        // ── Build final base URL ──────────────────────────────────────────────
        let base = rawBaseURL.replace(/\/+$/, "").replace(/\/v1$/, "");
        // Avoid doubling the path if the URL already ends with the model path
        let finalBaseURL = base.toLowerCase().endsWith(this.urlPath.toLowerCase())
            ? `${base}/v1`
            : `${base}/${this.urlPath}/v1`;
        finalBaseURL = finalBaseURL.replace(/([^:]\/)\/+/g, "$1");

        console.log(
            `VLLMModelBackend [${roleName}]:\n` +
            `  nginx path : ${finalBaseURL}\n` +
            `  model (body): ${this.model}\n` +
            `  maxTokens  : ${this.maxTokens}\n` +
            `  complexity : ${VLLMModelBackend.currentTaskComplexity}`
        );

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

        } catch (error: any) {
            const errStr = String(error);
            // If 404 with the resolved model name, retry using the URL path itself as model id.
            // Some vLLM nginx proxies expect model == path segment, not the underlying model name.
            if (errStr.includes("404") && this.model !== this.urlPath) {
                console.warn(
                    `VLLMModelBackend: 404 with model="${this.model}". ` +
                    `Retrying with model="${this.urlPath}" (url-path fallback)...`
                );
                const retryBody = {
                    model: this.urlPath,
                    messages: processedMessages,
                    temperature,
                    max_tokens: requestedOutputTokens,
                };
                try {
                    if (onToken) {
                        const stream = await this.openai.chat.completions.create({ ...retryBody, stream: true });
                        let fullText = "";
                        for await (const chunk of stream) {
                            const token = chunk.choices[0]?.delta?.content || "";
                            fullText += token;
                            onToken(token);
                        }
                        return fullText;
                    } else {
                        const response = await this.openai.chat.completions.create(retryBody);
                        return response.choices[0].message?.content || "";
                    }
                } catch (retryError) {
                    console.error(`VLLMModelBackend: Retry also failed:`, retryError);
                    // Fall through to the original error below
                }
            }
            console.error(`Error communicating with vLLM (path=/${this.urlPath} model=${this.model}):`, error);
            vscode.window.showErrorMessage(`vLLM Error [/${this.urlPath} → ${this.model}]: ${error}`);
            throw error;
        }
    }
}