import { Phase } from "./phase";
import * as vscode from "vscode";
import { AgentEvent } from "../camel/typing";

export class ChatChain {
    private phases: Phase[] = [];
    public onEvent?: (ev: AgentEvent) => void;
    private chatEnv: Record<string, string> = {};

    constructor(configPath?: string) {
        // Normally parse PhaseConfig.json and default Role configurations here
    }

    addPhase(phase: Phase) {
        this.phases.push(phase);
    }

    /**
     * Orchestrates the entire software development lifecycle
     */
    async execute(taskPrompt: string): Promise<Record<string, string>> {
        const planDescription = this.phases.map((p, i) => `${i + 1}. ${p.phaseName}`).join('\n');
        this.onEvent?.({ 
            type: 'narration', 
            content: `📢 ПЛАН ДІЙ:\n${planDescription}` 
        });

        let currentStateContext = taskPrompt;

        for (let i = 0; i < this.phases.length; i++) {
            const phase = this.phases[i];
            
            // Link the onEvent callback
            phase.onEvent = (ev) => this.onEvent?.(ev);

            // HITL Interceptor BEFORE Coding phase
            if (phase.phaseName === "Coding") {
                const userFeedback = await vscode.window.showInputBox({
                    prompt: "Review the plan/architecture so far. Provide feedback to trigger ArchitectureRevision, or leave empty to proceed to Coding.",
                    placeHolder: "e.g., Change database to PostgreSQL"
                });

                if (userFeedback) {
                    vscode.window.showInformationMessage("Feedback received. Triggering ArchitectureRevision...");
                    
                    // Create ArchitectureRevision phase dynamically
                    const archRevisionPhase = new Phase(
                        "ArchitectureRevision",
                        "Chief Technology Officer",
                        "Chief Executive Officer",
                        "Врахуйте критику людини. Оновіть архітектуру та явно збережіть її у файл system_design.md",
                        `Human Feedback: ${userFeedback}`,
                        3
                    );
                    
                    // Insert before current phase
                    this.phases.splice(i, 0, archRevisionPhase);
                    
                    // Decrement i to execute the newly inserted phase next iteration
                    i--;
                    continue; 
                }
            }

            vscode.window.showInformationMessage(`Starting phase: ${phase.phaseName}`);
            
            const phaseResult = await phase.execute(currentStateContext);
            
            // Store artifact
            this.chatEnv[`${phase.phaseName}_output`] = phaseResult;

            // HITL: Review Plan/Demand Analysis (Usually the first phase)
            if (i === 0 || phase.phaseName.includes("Analysis")) {
                const userFeedback = await vscode.window.showInputBox({
                    prompt: "Перегляньте план/аналіз від CEO. Чи бажаєте внести корективи? (Залиште порожнім для продовження)",
                    placeHolder: "Наприклад: Додай функцію авторизації..."
                });

                if (userFeedback) {
                    this.onEvent?.({ 
                        type: 'narration', 
                        content: `🔄 Отримано фідбек: "${userFeedback}". Коригуємо план...` 
                    });
                    currentStateContext = `User Feedback for correction:\n${userFeedback}\n\nPrevious outputs:\n${phaseResult}\n\nTask:\n${taskPrompt}`;
                    // Continue to next phase with the new context
                } else {
                    currentStateContext = `Previous outputs:\n${phaseResult}\n\nTask:\n${taskPrompt}`;
                }
            } else {
                // Context passes to the next phase
                currentStateContext = `Previous outputs:\n${phaseResult}\n\nTask:\n${taskPrompt}`;
            }

        }
        
        vscode.window.showInformationMessage("ChatChain Execution Finished.");
        return this.chatEnv;
    }
    
    getChatEnv(): Record<string, string> {
        return this.chatEnv;
    }
}
