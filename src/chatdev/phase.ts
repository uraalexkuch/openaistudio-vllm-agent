import { ChatAgent } from "../camel/chat_agent";
import { RoleType } from "../camel/typing";
import { autoLoadSkillsForTask } from "./skills";

export class Phase {
    public phaseName: string;
    private assistantAgent: ChatAgent;
    private userAgent: ChatAgent;
    private maxTurns: number;

    constructor(
        phaseName: string, 
        assistantRole: string, 
        userRole: string, 
        assistantPrompt: string, 
        userPrompt: string, 
        maxTurns = 5
    ) {
        this.phaseName = phaseName;
        this.assistantAgent = new ChatAgent(assistantRole, RoleType.ASSISTANT, assistantPrompt);
        this.userAgent = new ChatAgent(userRole, RoleType.USER, userPrompt);
        this.maxTurns = maxTurns;
    }

    public onEvent?: (ev: any) => void;

    /**
     * Executes a dialogue loop between two agents to solve the phase task.
     */
    async execute(taskPrompt: string): Promise<string> {
        console.log(`Starting Phase: ${this.phaseName}`);
        this.onEvent?.({ type: 'narration', content: `Розпочато фазу: ${this.phaseName}` });
        
        // Отримуємо релевантні навички (skills) для assistantAgent
        const loadedSkills = await autoLoadSkillsForTask(`${this.assistantAgent.getRoleName()} ${taskPrompt}`);
        if (loadedSkills.length > 0) {
            const skillsText = `=== АКТУАЛЬНІ НАВИЧКИ (SKILLS) ===\n${loadedSkills.map(s => `[${s.name}]:\n${s.content}`).join('\n\n')}\n==================================\nВідповідай УКРАЇНСЬКОЮ мовою.`;
            this.assistantAgent.addSystemContext(skillsText);
        }

        this.assistantAgent.addSystemContext("Коли ти повністю виконав свою частину завдання або відповів на питання, обов'язково додай в кінці своєї відповіді слово <DONE>.");
        this.userAgent.addSystemContext("Коли ти перевірив результат і більше не маєш правок або зауважень, обов'язково додай в кінці своєї відповіді слово <DONE>.");

        let currentMessage = taskPrompt;

        let finalCodeOrResult = "";

        for (let turn = 0; turn < this.maxTurns; turn++) {
            this.onEvent?.({ type: 'step', step: turn + 1, totalSteps: this.maxTurns });
            
            // Assistant Agent processes message
            const assistantName = this.assistantAgent.getRoleName();
            const assistantModel = this.assistantAgent.getModelName();
            const actionDesc = turn === 0 ? `аналізує задачу та складає план` : `виконує підзадачу та готує відповідь`;
            
            this.onEvent?.({ 
                type: 'thinking', 
                role: assistantName,
                model: assistantModel,
                content: `[${assistantName}] ${actionDesc}...` 
            });
            
            const assistantResponse = await this.assistantAgent.step(currentMessage);
            
            this.onEvent?.({ 
                type: 'answer', 
                role: assistantName,
                model: assistantModel,
                content: assistantResponse 
            });
            finalCodeOrResult += assistantResponse + "\n";
            
            if (this.checkTermination(assistantResponse)) {
                break;
            }

            // User Agent responds back
            const userName = this.userAgent.getRoleName();
            const userModel = this.userAgent.getModelName();
            this.onEvent?.({ 
                type: 'thinking', 
                role: userName,
                model: userModel,
                content: `[${userName}] перевіряє результат та дає фідбек...` 
            });
            
            currentMessage = await this.userAgent.step(assistantResponse);
            
            this.onEvent?.({ 
                type: 'answer', 
                role: userName,
                model: userModel,
                content: currentMessage 
            });

            if (this.checkTermination(currentMessage)) {
                break;
            }
        }

        
        this.onEvent?.({ type: 'done' });
        return finalCodeOrResult;
    }

    private checkTermination(message: string): boolean {
        // Standard OpenAIStudio termination markers
        return message.includes("<CAMEL_TASK_DONE>") || message.includes("<DONE>");
    }
}
