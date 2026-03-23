import axios from 'axios';

async function testWebSearch() {
    const perplexicaUrl = "http://10.1.0.138:3030";
    const query = "What is the capital of Ukraine?";

    console.log(`Executing long-timeout test (120s) for query: "${query}"`);
    try {
        const payload = {
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
        };

        const response = await axios.post(`${perplexicaUrl}/api/search`, payload, { timeout: 120000 });
        console.log("Response status:", response.status);
        console.log("Response data:", JSON.stringify(response.data, null, 2));
    } catch (error: any) {
        if (error.response) {
            console.error(`API Error: ${error.response.status}`);
            console.error("Data:", JSON.stringify(error.response.data, null, 2));
        } else {
            console.error("Connection/Timeout Error:", error.message);
        }
    }
}

testWebSearch();
