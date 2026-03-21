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
            // CEO/Analyzer only extracts JSON - Mistral is 0.3s layout
            this.model = "mistral";
            this.maxTokens = 4096;
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

    /**
     * Send messages to the vLLM API and return the response text.
     */
    async step(messages: ChatMessage[], temperature = 0.2, onToken?: (token: string) => void): Promise<string> {
        try {
            const requestedOutputTokens = Math.floor(this.maxTokens * 0.7); 
            
            if (onToken) {
                const stream = await this.openai.chat.completions.create({
                    model: this.model,
                    messages: messages as any,
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
                    messages: messages as any,
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
