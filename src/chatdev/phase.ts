// Copyright (c) 2026 Юрій Кучеренко.
import { ChatAgent } from "../camel/chat_agent";
import { RoleType } from "../camel/typing";
import { autoLoadSkillsForTask } from "./skills";
import { getToolsDescription } from "./tools";
import { resolveUiLanguage, buildLanguageRule, LangInfo } from '../utils/language_utils';

// Phases where the assistant actively needs to write/read/launch files
const FILE_TOOL_PHASES = new Set([
    // старі назви (залишити для сумісності)
    "Coding", "CodeReview", "Documentation", "ArchitectureRevision",
    // нові назви з пайплайнів
    "Implementation", "Frontend Implementation", "Backend Implementation",
    "Code Review", "Project Documentation",
    // динамічний DAG може генерувати довільні назви — ловимо за підрядком нижче
]);

export class Phase {
    public phaseName: string;
    private assistantAgent: ChatAgent;
    private userAgent: ChatAgent;
    private readonly maxTurns: number;
    private readonly taskComplexity: string;
    private readonly roleSkills?: string[];
    private uiLang: LangInfo;

    constructor(
        phaseName: string,
        assistantRole: string,
        userRole: string,
        assistantPrompt: string,
        userPrompt: string,
        maxTurns?: number,
        assistantModel?: string,
        taskComplexity: string = "High",
        roleSkills?: string[],
        taskText?: string
    ) {
        this.phaseName = phaseName;
        this.taskComplexity = taskComplexity;
        this.roleSkills = roleSkills;
        this.uiLang = resolveUiLanguage(taskText);
        this.assistantAgent = new ChatAgent(assistantRole, RoleType.ASSISTANT, assistantPrompt, this.taskComplexity, assistantModel);
        this.userAgent = new ChatAgent(userRole, RoleType.USER, userPrompt, this.taskComplexity);
        this.maxTurns = maxTurns ?? 5;
    }

    public onEvent?: (ev: any) => void;

    /**
     * Executes a dialogue loop between two agents to solve the phase task.
     */
    async execute(taskPrompt: string): Promise<string> {
        console.log(`Starting Phase: ${this.phaseName}`);
        this.onEvent?.({ type: 'narration', content: `Розпочато фазу: ${this.phaseName}` });

        // FIX 1: Load skills. Priority: Specific skills from RoleConfig, then auto-load.
        let loadedSkills: any[] = [];
        
        if (this.roleSkills && this.roleSkills.length > 0) {
            console.log(`[Phase:${this.phaseName}] Loading specific skills: ${this.roleSkills.join(', ')}`);
            // We'll try to match these names against folders in skillsPath
            const allScored = await autoLoadSkillsForTask(`${this.roleSkills.join(' ')}`, "", 10);
            const currentRoleSkills = this.roleSkills;
            loadedSkills = allScored.filter(s => {
                const lf = s.folderName.toLowerCase();
                const ln = s.name.toLowerCase();
                return currentRoleSkills.some(rs => {
                    const lrs = rs.toLowerCase();
                    return lf === lrs ||
                           lf.endsWith('/' + lrs) ||
                           ln === lrs ||
                           ln.includes(lrs);
                });
            });
        }

        if (loadedSkills.length === 0) {
            // Fallback to auto-load logic if no specific skills or if they failed to load
            loadedSkills = await autoLoadSkillsForTask(`${this.assistantAgent.getRoleName()} ${taskPrompt}`);
        }

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

        // Inject tool schema ONLY for the assistant agent (the one doing the work).
        // userAgent (CTO, CPO reviewing) must NOT get tool descriptions —
        // they were responding AS IF executing tools which breaks the flow entirely.
        // FIX 1: Provide tool descriptions for phases that require file manipulation
        const needsTools = FILE_TOOL_PHASES.has(this.phaseName) ||
            this.phaseName.toLowerCase().includes("implement") ||
            this.phaseName.toLowerCase().includes("coding") ||
            this.phaseName.toLowerCase().includes("review") ||
            this.phaseName.toLowerCase().includes("document");

        if (needsTools) {
            this.assistantAgent.addSystemContext(getToolsDescription());
            // userAgent gets a brief reminder NOT to execute tools
            this.userAgent.addSystemContext(
                `IMPORTANT: You are a reviewer. Do NOT call any tools yourself. ` +
                `Do NOT write <tool_call> or <tool_result> tags. ` +
                `Only read the assistant's output and provide feedback or output <DONE>.`
            );
        }

        // FIX 2: Language control — agents reason in any language internally but the final
        // user-visible answer must be in the resolved UI language.
        const langRule = buildLanguageRule(this.uiLang);
        this.assistantAgent.addSystemContext(langRule);
        this.userAgent.addSystemContext(langRule);

        // Narration about the resolved language
        this.onEvent?.({
            type: 'narration',
            content: `🌐 Мова відповідей: ${this.uiLang.nativeLabel} (${this.uiLang.code})`
        });

        // Wire onEvent so tool_call / tool_result events reach the UI
        this.assistantAgent.onEvent = (ev) => this.onEvent?.(ev);
        this.userAgent.onEvent      = (ev) => this.onEvent?.(ev);

        // FIX 3: <DONE> instruction — explicit: after saving AND launching, output <DONE>
        this.assistantAgent.addSystemContext(
            `When you have fully completed your task (including saving files with write_file ` +
            `AND launching with launch_file if requested), append exactly <DONE> at the very end.`
        );
        this.userAgent.addSystemContext(
            `When you have reviewed the result and have no more corrections, append exactly <DONE> at the very end.`
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

        // Prepare the task prompt based on the role structure
        let promptForAssistant = "";
        let promptForUser      = "";

        const isReviewPhase = this.phaseName.toLowerCase().includes("review");
        const isDocPhase    = this.phaseName.toLowerCase().includes("documentation");
        const isWorkerPhase = !isReviewPhase && !isDocPhase;

        if (isWorkerPhase) {
            promptForAssistant = [
                `=== ORIGINAL USER TASK ===`,
                originalTask,
                `=== END OF TASK ===`,
                ``,
                `=== YOUR ROLE IN THIS PHASE: ${this.phaseName} ===`,
                `Execute the task above. Write code and save files as requested.`,
                `IMPORTANT: If the task specifies an absolute path (e.g., C:\\...), use it EXACTLY for all file operations.`,
                taskIdx !== -1 ? `\n=== CONTEXT FROM PREVIOUS PHASES ===\n${taskPrompt.substring(0, taskIdx).trim()}` : '',
            ].filter(Boolean).join('\n');
            
            promptForUser = `Review the work done by the ${this.assistantAgent.getRoleName()}. ` +
                           `Ensure it fulfills the task: "${originalTask}". ` +
                           `Provide feedback or output <DONE> if complete.`;
        } else if (isReviewPhase) {
            promptForAssistant = [
                `=== ORIGINAL USER TASK ===`,
                originalTask,
                `=== END OF TASK ===`,
                ``,
                `=== YOUR ROLE: ${this.assistantAgent.getRoleName()} (${this.phaseName}) ===`,
                `Your task is to REVIEW the work produced in previous phases. ` +
                `You MUST call read_file to check the current code state before giving feedback.`,
                `Do NOT rewrite the whole project. Provide targeted feedback for the Programmer to fix.`,
                taskIdx !== -1 ? `\n=== CONTEXT & SUMMARIES (previous work) ===\n${taskPrompt.substring(0, taskIdx).trim()}` : '',
            ].filter(Boolean).join('\n');
            
            promptForUser = `I have completed the implementation for the task: "${originalTask}". ` +
                           `Please review the files at their saved locations and provide feedback.`;
        } else if (isDocPhase) {
            promptForAssistant = [
                `=== ORIGINAL USER TASK ===`,
                originalTask,
                `=== END OF TASK ===`,
                ``,
                `=== YOUR ROLE: ${this.assistantAgent.getRoleName()} (${this.phaseName}) ===`,
                `Your task is to document the project. Do NOT write game code. ` +
                `FORBIDDEN: You must NEVER call launch_file or execute_bash. Only use write_file for documentation.`,
                `Create a README.md based on the features and files described in the context.`,
                `IMPORTANT: If the project was saved to an absolute path, reflect this in the documentation.`,
                taskIdx !== -1 ? `\n=== CONTEXT & SUMMARIES ===\n${taskPrompt.substring(0, taskIdx).trim()}` : '',
            ].filter(Boolean).join('\n');
            
            promptForUser = `The project based on task "${originalTask}" is complete. ` +
                           `Please write the technical documentation (README.md).`;
        }

        // Logical Flow: User Agent (CTO/Manager) starts the conversation or prompts the assistant.
        // This restores the "logical sequence" where the assistant responds to a specific prompt.
        let currentMessage = promptForUser || "Please proceed with the task.";
        let finalCodeOrResult = "";

        for (let turn = 0; turn < this.maxTurns; turn++) {
            this.onEvent?.({ type: 'step', step: turn + 1, totalSteps: this.maxTurns });

            const assistantName  = this.assistantAgent.getRoleName();
            const assistantModel = this.assistantAgent.getModelName();
            const userName       = this.userAgent.getRoleName();
            const actionDesc     = turn === 0 ? `аналізує задачу та складає план` : `виконує підзадачу та готує відповідь`;

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

            // The very first turn: assistant gets its specific instructions + the user's opening message
            const payload = turn === 0 
                ? `${promptForAssistant}\n\n=== START CONVERSATION ===\n${userName}: ${currentMessage}`
                : currentMessage;

            const assistantResponse = await this.assistantAgent.step(payload, 0.2, (token) => {
                this.onEvent?.({ type: 'answer_stream_chunk', content: token });
            });

            this.onEvent?.({ type: 'answer_stream_end' });
            finalCodeOrResult += assistantResponse + "\n";

            // Guard: if Code Reviewer outputs <DONE> on the very first turn without
            // having called read_file, it skipped the review. Inject a reminder.
            const isFirstTurn      = turn === 0;
            const calledTool       = assistantResponse.includes('<tool_call>') ||
                assistantResponse.includes('tool_result') ||
                finalCodeOrResult.includes('saved successfully');
            const isReviewer       = assistantName.toLowerCase().includes('reviewer');
            const doneWithoutWork  = isFirstTurn && isReviewer && !calledTool &&
                this.checkTermination(assistantResponse);

            if (doneWithoutWork) {
                // Override: inject a corrective message so reviewer actually reads the file
                this.onEvent?.({ type: 'narration', content: `⚠️ Code Reviewer skipped review — injecting read_file reminder` });
                currentMessage = `You output <DONE> without reading any files. ` +
                    `You MUST call read_file on the saved file(s) first, then provide a real review. ` +
                    `Do NOT output <DONE> until you have actually reviewed the code.`;
                continue; // skip <DONE>, loop again
            }

            if (this.checkTermination(assistantResponse)) {
                break;
            }

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