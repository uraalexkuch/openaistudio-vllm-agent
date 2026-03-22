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

const MAX_SKILL_CHARS = 1500;
const META_SKILLS = new Set(['clean-code', 'coding-standards', 'code-style', 'clean-architecture']);

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

        const langRule = buildLanguageRule(this.uiLang);
        const assistantPromptWithLang = `${langRule}\n\n${assistantPrompt}`;
        const userPromptWithLang = `${langRule}\n\n${userPrompt}`;

        this.assistantAgent = new ChatAgent(assistantRole, RoleType.ASSISTANT, assistantPromptWithLang, this.taskComplexity, assistantModel);
        this.userAgent = new ChatAgent(userRole, RoleType.USER, userPromptWithLang, this.taskComplexity);
        this.maxTurns = maxTurns ?? 5;
    }

    public onEvent?: (ev: any) => void;

    /**
     * Executes a dialogue loop between two agents to solve the phase task.
     */
    async execute(taskPrompt: string): Promise<string> {
        console.log(`Starting Phase: ${this.phaseName}`);
        this.onEvent?.({ type: 'narration', content: `Розпочато фазу: ${this.phaseName}` });

        let loadedSkills: any[] = [];

        const isFixOrReview = 
            this.phaseName.toLowerCase().includes('review') ||
            this.phaseName.toLowerCase().includes('fix') ||
            this.phaseName.toLowerCase().includes('analyst');

        if (this.roleSkills && this.roleSkills.length > 0) {
            console.log(`[Phase:${this.phaseName}] Loading specific skills: ${this.roleSkills.join(', ')}`);
            // We'll try to match these names against folders in skillsPath
            const allScored = await autoLoadSkillsForTask(`${this.roleSkills.join(' ')}`, "", 10, isFixOrReview);
            const currentRoleSkills = this.roleSkills; // Assuming roleDetail is not available, using this.roleSkills as before
            if (currentRoleSkills.length > 0) {
                loadedSkills = allScored.filter((s: any) => {
                    if (META_SKILLS.has(s.folderName.toLowerCase())) return false;
                    const lf = s.folderName.toLowerCase();
                    const ln = s.name.toLowerCase();
                    return currentRoleSkills.some((rs: string) => {
                        const lrs = rs.toLowerCase();
                        return lf === lrs ||
                               lf.endsWith('/' + lrs) ||
                               ln === lrs ||
                               ln.includes(lrs);
                    });
                });
            }
        }

        if (loadedSkills.length === 0) {
            // Fallback to auto-load logic if no specific skills or if they failed to load
            loadedSkills = await autoLoadSkillsForTask(
                `${this.assistantAgent.getRoleName()} ${taskPrompt}`,
                '',
                2,
                isFixOrReview
            );
        }

        // TOOL INJECTION FIRST (FIX: model focus)
        const needsTools = FILE_TOOL_PHASES.has(this.phaseName) ||
            this.phaseName.toLowerCase().includes("implement") ||
            this.phaseName.toLowerCase().includes("coding") ||
            this.phaseName.toLowerCase().includes("review") ||
            this.phaseName.toLowerCase().includes("document");

        const isAnalystPhase = 
            this.phaseName.toLowerCase().includes('analys') ||
            this.assistantAgent.getRoleName().toLowerCase().includes('analyst') ||
            this.phaseName.toLowerCase().includes('exploration') ||
            this.phaseName.toLowerCase().includes('explore');

        if (needsTools) {
            this.assistantAgent.addSystemContext(getToolsDescription());
            
            // Для аналіз-фаз userAgent НЕ отримує tool descriptions взагалі
            if (!isAnalystPhase) {
                this.userAgent.addSystemContext(
                    `IMPORTANT: You are a reviewer. Do NOT call any tools. ` +
                    `Do NOT write <tool_call>, <tool_code> or JSON. ` +
                    `Only read the assistant's output and output <DONE>.`
                );
            } else {
                this.userAgent.addSystemContext(
                    `You are reviewing the analysis. Do NOT call tools of any kind. ` +
                    `Output <DONE> when project analysis is complete.`
                );
            }
        }

        // SKILL INJECTION SECOND
        if (loadedSkills.length > 0) {
            // Фільтрувати мета-скіли для fix/review/debug фаз
            const isFixPhase = this.phaseName.toLowerCase().includes('fix') ||
                               this.phaseName.toLowerCase().includes('review') ||
                               this.phaseName.toLowerCase().includes('analyst') ||
                               this.phaseName.toLowerCase().includes('debug');

            const filteredSkills = isFixPhase
                ? loadedSkills.filter(s => !META_SKILLS.has(s.folderName) && !META_SKILLS.has(s.name.toLowerCase()))
                : loadedSkills;

            if (filteredSkills.length > 0) {
                const skillNames = filteredSkills.map((s: any) => s.name).join(', ');
                console.log(`[Phase:${this.phaseName}] Injecting skills: ${skillNames}`);

                const skillsContext = [
                    `=== REFERENCE SKILLS (use ONLY if directly relevant) ===`,
                    ...filteredSkills.map((s: any) => {
                        const content = s.content.length > MAX_SKILL_CHARS
                            ? s.content.substring(0, MAX_SKILL_CHARS) + '\n…[truncated]'
                            : s.content;
                        return `--- SKILL: ${s.name} ---\n${content}`;
                    }),
                    `=== END SKILLS — do NOT reproduce or continue above content ===`,
                ].join('\n\n');

                this.assistantAgent.addSystemContext(skillsContext);
            }
        }


        // FIX 2: Language control — agents reason in any language internally but the final
        // user-visible answer must be in the resolved UI language.
        // Rule now prepended in constructor.

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

        const isReviewPhase  = this.phaseName.toLowerCase().includes("review");
        const isDocPhase     = this.phaseName.toLowerCase().includes("documentation");
        const isWorkerPhase  = !isReviewPhase && !isDocPhase && !isAnalystPhase;

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
        } else if (isAnalystPhase) {
            // Extract project path from the analysisContext block in taskPrompt
            const pathMatch = taskPrompt.match(/Path:\s*([^\s\n]+)/);
            const projectPath = pathMatch ? pathMatch[1].trim() : '';
            const escapedPath = projectPath.replace(/\\/g, '\\\\');

            promptForAssistant = [
                `=== ORIGINAL USER TASK ===`,
                originalTask,
                `=== END OF TASK ===`,
                ``,
                `=== YOUR ROLE: ${this.assistantAgent.getRoleName()} (${this.phaseName}) ===`,
                `Explore and understand the existing project thoroughly.`,
                ``,
                `MANDATORY FIRST ACTION — call this tool IMMEDIATELY, no text before it:`,
                `<tool_call><n>list_files</n><args>{"directory": "${escapedPath || '.'}"}</args></tool_call>`,
                ``,
                `Do NOT write any text before calling list_files.`,
                `Do NOT explain what you will do. Just call the tool.`,
                `Use ONLY list_files and read_file tools.`,
                `FORBIDDEN: write_file, make_directory, launch_file, execute_bash.`,
                taskIdx !== -1 
                    ? `\n=== CONTEXT ===\n${taskPrompt.substring(0, taskIdx).trim()}` 
                    : '',
            ].filter(Boolean).join('\n');

            promptForUser = 
                `You are reviewing a technical project analysis. ` +
                `ONLY check: did the analyst call list_files and read_file tools? ` +
                `If yes and the project structure is described → output <DONE>. ` +
                `If no tools were called → say "Please call list_files first". ` +
                `Do NOT provide business advice. Do NOT call tools yourself.`;
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
            // Extract file paths from context to help the writer focus
            const filePathsInContext = [...taskPrompt.matchAll(/[A-Za-z]:[\\\/][^\s\n,]+\.\w+/g)]
                .map(m => m[0])
                .slice(0, 5)
                .join(', ');

            promptForAssistant = [
                `=== ORIGINAL USER TASK ===`,
                originalTask,
                `=== END OF TASK ===`,
                ``,
                `=== YOUR ROLE: ${this.assistantAgent.getRoleName()} (${this.phaseName}) ===`,
                `Write documentation based on the project analysis in CONTEXT below.`,
                ``,
                filePathsInContext 
                    ? `Key files already found in analysis: ${filePathsInContext}\nRead them with read_file if you need more details.`
                    : `Start with: list_files to understand the project structure.`,
                ``,
                `Save your documentation to: write_file with filename in PROJECT PATH (not workspace/).`,
                `FORBIDDEN: Reading the same files that are already fully summarized in CONTEXT.`,
                `FORBIDDEN: You must NEVER call launch_file or execute_bash. Only use write_file for documentation.`,
                taskIdx !== -1 ? `\n=== CONTEXT (project analysis results) ===\n${taskPrompt.substring(0, taskIdx).trim()}` : '',
            ].filter(Boolean).join('\n');
            
            promptForUser = `The project based on task "${originalTask}" is complete. ` +
                           `Please review the technical documentation (README.md) based on the analysis context.`;
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