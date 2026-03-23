import axios from 'axios';

async function testWebSearch() {
    const perplexicaUrl = "http://10.1.0.138:3030";
    const query = "who is the current president of the united states?";

    console.log(`Testing web_search logic for Perplexica 1.12.1 logic for query: "${query}"`);
    try {
        const payload = {
            query,
            sources: ["web"],
            optimizationMode: "balanced",
            chatModel: {
                providerId: "4a2503c9-bb5f-4cf9-8976-87e1c6147710", // DCZ Ollama New
                key: "qwen3-coder:latest"
            },
            embeddingModel: {
                providerId: "ff97a883-e050-4356-bd4e-636b10b06524", // Transformers
                key: "Xenova/all-MiniLM-L6-v2"
            },
            history: [],
            stream: false
        };
        
        console.log("Payload:", JSON.stringify(payload, null, 2));

        const response = await axios.post(`${perplexicaUrl}/api/search`, payload, { timeout: 60000 });

        console.log("Response status:", response.status);
        if (response.data && response.data.message) {
             console.log("Warning/Info Message:", response.data.message);
        }
        console.log("Response data (summary):", JSON.stringify(response.data, null, 2).substring(0, 1000));
    } catch (error: any) {
        console.error("Error executing web_search via Perplexica:");
        if (error.response) {
            console.error(`- Status: ${error.response.status}`);
            console.error("- Response Data:", JSON.stringify(error.response.data, null, 2));
        } else {
            console.error(`- ${error.message}`);
        }
    }
}

testWebSearch();
