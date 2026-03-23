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
        });

        if (response.data && response.data.results) {
            return JSON.stringify(response.data.results.slice(0, 3));
        }
        return "No results found.";
    } catch (error) {
        console.error("Error executing web_search via Perplexica:", error);
        return `Error executing web_search: ${error}`;
    }
}