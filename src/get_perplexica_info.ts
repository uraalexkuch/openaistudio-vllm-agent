import axios from 'axios';
import * as fs from 'fs';

async function getPerplexicaInfo() {
    const baseUrl = "http://10.1.0.138:3030";
    const info: any = {};
    
    const endpoints = ["/api/providers", "/api/config"];
    
    for (const endpoint of endpoints) {
        try {
            console.log(`Checking ${endpoint}...`);
            const response = await axios.get(`${baseUrl}${endpoint}`, { timeout: 10000 });
            info[endpoint] = response.data;
        } catch (error: any) {
            info[endpoint] = { error: error.message };
        }
    }
    
    fs.writeFileSync('perplexica_info.json', JSON.stringify(info, null, 2));
    console.log("Saved info to perplexica_info.json");
}

getPerplexicaInfo();
