// Copyright (c) 2026 Юрій Кучеренко.
import axios from 'axios';
import * as vscode from 'vscode';

export async function web_search(query: string): Promise<string> {
    // FIX: was hardcoded to 'http://localhost:3030'. Now reads from VS Code settings
    // so it respects the user's configured Perplexica URL.
    const config = vscode.workspace.getConfiguration('openaistudio');
    const perplexicaUrl = config.get<string>('perplexicaUrl', 'http://localhost:3001').trim().replace(/\/+$/, '');

    if (!perplexicaUrl) {
        return 'web_search is not configured. Set openaistudio.perplexicaUrl in VS Code settings.';
    }

    try {
        console.log(`Executing web_search for query: "${query}" via ${perplexicaUrl}`);
        const response = await axios.post(`${perplexicaUrl}/api/search`, {
            query,
            sources: ["web"],
            optimizationMode: "balanced",
            chatModel: {
                providerId: "4a2503c9-bb5f-4cf9-8976-87e1c6147710", // DCZ Ollama New
                key: "gpt-oss:latest"
            },
            embeddingModel: {
                providerId: "ff97a883-e050-4356-bd4e-636b10b06524", // Transformers
                key: "Xenova/all-MiniLM-L6-v2"
            },
            history: [],
            stream: false
        }, {
            timeout: 120000 // 120 seconds timeout for Perplexica + Local LLM
        });

        if (response.data) {
            // Perplexica 1.12.1 returns the answer in 'message'
            if (response.data.message) {
                return response.data.message;
            }
            // Older versions or different endpoints might return 'results'
            if (response.data.results) {
                return JSON.stringify(response.data.results.slice(0, 3));
            }
        }
        return "No results found or empty response from Perplexica.";
    } catch (error: any) {
        console.error("Error executing web_search via Perplexica:", error);
        if (error.code === 'ECONNABORTED') {
            return `Error: Web search timed out after 120s. Your local Perplexica/Ollama instance might be too slow.`;
        }
        return `Error executing web_search: ${error.message || error}`;
    }
}