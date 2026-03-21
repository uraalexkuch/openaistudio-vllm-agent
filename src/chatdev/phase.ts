import { ChatAgent } from "../camel/chat_agent";
import { RoleType } from "../camel/typing";
import { autoLoadSkillsForTask } from "./skills";
import { getToolsDescription } from "./tools";

// Phases where the assistant actively needs to write/read/launch files
const FILE_TOOL_PHASES = new Set(["Coding", "CodeReview", "Documentation", "ArchitectureRevision"]);

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

        // FIX 1: Load skills but inject them as REFERENCE ONLY — not as a conversation to continue.
        // Skills are appended AFTER the role description so the model sees its actual identity first.
        // The framing explicitly tells the model to use skills as patterns, not to respond to them.
        const loadedSkills = await autoLoadSkillsForTask(`${this.assistantAgent.getRoleName()} ${taskPrompt}`);
        if (loadedSkills.length > 0) {
            const skillNames = loadedSkills.map(s => s.name).join(', ');
            console.log(`[Phase:${this.phaseName}] Injecting skills: ${skillNames}`);

            const skillsContext = [
                `=== REFERENCE SKILLS (read-only patterns — do NOT respond to these examples) ===`,
                ...loadedSkills.map(s => `--- SKILL: ${s.name} ---\n${s.content}`),
                `=== END OF REFERENCE SKILLS ===`,
                `Use the patterns above ONLY if they are directly relevant to the current task.`,
                `If no skill is relevant, ignore them entirely.`,
            ].join('\n\n');

            this.assistantAgent.addSystemContext(skillsContext);
        }

        // Inject tool schema for phases that produce/read files.
        // Both assistant AND user get tools in CodeReview: reviewer uses read_file,
        // programmer (userAgent) uses write_file to apply fixes.
        if (FILE_TOOL_PHASES.has(this.phaseName)) {
            this.assistantAgent.addSystemContext(getToolsDescription());
            this.userAgent.addSystemContext(getToolsDescription());
        }

        // FIX 2: Language control — agents reason in English internally but the final
        // user-visible answer must be in Ukrainian (or whatever language the task uses).
        this.assistantAgent.addSystemContext(
            `LANGUAGE RULE: You may think and reason in English internally. ` +
            `Your final response visible in the chat MUST be in Ukrainian (uk-UA) ` +
            `unless the task explicitly uses a different language.`
        );
        this.userAgent.addSystemContext(
            `LANGUAGE RULE: Your feedback and questions MUST be in Ukrainian (uk-UA).`
        );

        // FIX 3: <DONE> instruction injected LAST so it is the most recent context.
        this.assistantAgent.addSystemContext(
            `When you have fully completed your part of the task, append exactly <DONE> at the end of your response.`
        );
        this.userAgent.addSystemContext(
            `When you have reviewed the result and have no more corrections or questions, append exactly <DONE> at the end of your response.`
        );

        // Extract the original user task from the context block.
        // chat_chain passes: "=== SUMMARIES... ===\n...\n\n=== TASK ===\n<original task>"
        // We want to put the original task FIRST so the model always sees it clearly.
        let originalTask = taskPrompt.trim();
        const taskMarker = '=== TASK ===\n';
        const taskIdx = taskPrompt.indexOf(taskMarker);
        if (taskIdx !== -1) {
            originalTask = taskPrompt.substring(taskIdx + taskMarker.length).trim();
        }

        // Wrap the task so the model clearly sees "THIS is what I need to do"
        const wrappedTaskPrompt = [
            `=== ORIGINAL USER TASK ===`,
            originalTask,
            `=== END OF TASK ===`,
            ``,
            `=== YOUR ROLE IN THIS PHASE: ${this.phaseName} ===`,
            `Execute the task above. Do not invent a different task. Do not ask clarifying questions — proceed directly.`,
            taskIdx !== -1 ? `\n=== CONTEXT FROM PREVIOUS PHASES ===\n${taskPrompt.substring(0, taskIdx).trim()}` : '',
        ].filter(Boolean).join('\n');

        let currentMessage = wrappedTaskPrompt;
        let finalCodeOrResult = "";

        for (let turn = 0; turn < this.maxTurns; turn++) {
            this.onEvent?.({ type: 'step', step: turn + 1, totalSteps: this.maxTurns });

            const assistantName  = this.assistantAgent.getRoleName();
            const assistantModel = this.assistantAgent.getModelName();
            const actionDesc = turn === 0 ? `аналізує задачу та складає план` : `виконує підзадачу та готує відповідь`;

            this.onEvent?.({
                type: 'thinking',
                role: assistantName,
                model: assistantModel,
                content: `[${assistantName}] ${actionDesc}...`
            });

            this.onEvent?.({
                type: 'answer_stream_start',
                role: assistantName,
                model: assistantModel
            });

            const assistantResponse = await this.assistantAgent.step(currentMessage, 0.2, (token) => {
                this.onEvent?.({ type: 'answer_stream_chunk', content: token });
            });

            this.onEvent?.({ type: 'answer_stream_end' });
            finalCodeOrResult += assistantResponse + "\n";

            if (this.checkTermination(assistantResponse)) {
                break;
            }

            const userName  = this.userAgent.getRoleName();
            const userModel = this.userAgent.getModelName();
            this.onEvent?.({
                type: 'thinking',
                role: userName,
                model: userModel,
                content: `[${userName}] перевіряє результат та дає фідбек...`
            });

            this.onEvent?.({
                type: 'answer_stream_start',
                role: userName,
                model: userModel
            });

            currentMessage = await this.userAgent.step(assistantResponse, 0.2, (token) => {
                this.onEvent?.({ type: 'answer_stream_chunk', content: token });
            });

            this.onEvent?.({ type: 'answer_stream_end' });

            if (this.checkTermination(currentMessage)) {
                break;
            }
        }

        this.onEvent?.({ type: 'done' });
        return finalCodeOrResult;
    }

    private checkTermination(message: string): boolean {
        return message.includes("<CAMEL_TASK_DONE>") || message.includes("<DONE>");
    }
}