import axios from 'axios';

async function probePort3001() {
    const baseUrl = "http://10.1.0.138:3001";
    
    console.log(`Probing port 3001 at: ${baseUrl}`);
    
    const endpoints = ["/api/models", "/api/search"];
    
    for (const endpoint of endpoints) {
        try {
            console.log(`Checking ${endpoint}...`);
            const response = await axios.get(`${baseUrl}${endpoint}`, { timeout: 10000 });
            console.log(`  Status: ${response.status}`);
            console.log(`  Content-Type: ${response.headers['content-type']}`);
            if (typeof response.data === 'string') {
                console.log(`  Data (first 100 chars): ${response.data.substring(0, 100).replace(/\n/g, ' ')}`);
            } else {
                console.log(`  Data: ${JSON.stringify(response.data, null, 2).substring(0, 200)}...`);
            }
        } catch (error: any) {
            console.error(`  Error at ${endpoint}: ${error.message}`);
            if (error.response) {
                console.error(`  Response status: ${error.response.status}`);
            }
        }
    }
}

probePort3001();
