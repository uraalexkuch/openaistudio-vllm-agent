import * as fs from 'fs';

export class Memory {
    private conversationHistory: string[] = [];

    /**
     * Store logs or critical steps of the OpenAIStudio execution for reviewing later
     */
    public append(logEntry: string): void {
        this.conversationHistory.push(`[${new Date().toISOString()}] ${logEntry}`);
    }

    /**
     * Export all memory to a log file within the workspace
     */
    public saveMemory(absolutePath: string): void {
        const content = this.conversationHistory.join('\n');
        fs.writeFileSync(absolutePath, content, 'utf8');
    }

    public getHistory(): string[] {
        return this.conversationHistory;
    }
    
    public clear(): void {
        this.conversationHistory = [];
    }
}
