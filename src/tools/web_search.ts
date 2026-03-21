import axios from 'axios';

export async function web_search(query: string): Promise<string> {
    try {
        console.log(`Executing web_search for query: ${query}`);
        // Perplexica endpoint (assuming standard search endpoint for local instance)
        const response = await axios.post('http://localhost:3030/api/search', {
            query: query,
            searchMode: "web"
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
