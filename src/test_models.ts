import axios from 'axios';

async function probeModels() {
    const url = "http://10.1.0.138:3030/api/models";
    console.log(`Probing Models at: ${url}`);
    try {
        const response = await axios.get(url, { timeout: 10000 });
        console.log("Status:", response.status);
        console.log("Content-Type:", response.headers['content-type']);
        if (typeof response.data === 'string') {
            console.log("Data (first 200 chars):", response.data.substring(0, 200));
        } else {
            console.log("Data:", JSON.stringify(response.data, null, 2));
        }
    } catch (error: any) {
        console.error("Error probing models:", error.message);
    }
}

probeModels();
