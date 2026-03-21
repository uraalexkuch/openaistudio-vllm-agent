import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as os from 'os';
import axios from 'axios';
import { ChatWebview } from './ui/chat_webview';
import { ChatChain } from './chatdev/chat_chain';
import { Phase } from './chatdev/phase';
import { WorkspaceManager } from './chatdev/workspace';
import { VLLMModelBackend } from './camel/model_backend';

let globalSessionContext = "";
let isExecuting = false;

interface RoleDetail {
    model?: string;
    description?: string;
    skills?: string[];
    systemPrompt: string;
}

type RoleConfig = Record<string, string | RoleDetail> & { roles?: Record<string, RoleDetail> };

const FALLBACK_PIPELINE: Array<{
    phaseName: string;
    assistantRole: string;
    userRole: string;
    maxTurns: number;
    dependsOn: string[];
}> = [
    { phaseName: "Business Analysis",    assistantRole: "Chief Executive Officer",       userRole: "Chief Product Officer",    maxTurns: 2, dependsOn: [] },
    { phaseName: "System Architecture",  assistantRole: "Chief Technology Officer",      userRole: "Chief Executive Officer",  maxTurns: 2, dependsOn: ["Business Analysis"] },
    { phaseName: "Database Optimization",assistantRole: "Database Optimization Expert", userRole: "Chief Technology Officer", maxTurns: 2, dependsOn: ["System Architecture"] },
    { phaseName: "Cyber Security Audit", assistantRole: "Cyber Security Specialist",    userRole: "Chief Technology Officer", maxTurns: 2, dependsOn: ["Database Optimization"] },
    { phaseName: "Implementation",       assistantRole: "Programmer",                    userRole: "Chief Technology Officer", maxTurns: 2, dependsOn: ["Cyber Security Audit"] },
    { phaseName: "Quality Assurance",    assistantRole: "Software Test Engineer",        userRole: "Programmer",               maxTurns: 2, dependsOn: ["Implementation"] },
    { phaseName: "Code Review",          assistantRole: "Code Reviewer",                 userRole: "Programmer",               maxTurns: 4, dependsOn: ["Quality Assurance"] },
    { phaseName: "Project Documentation",assistantRole: "Technical Writer",              userRole: "Chief Executive Officer",  maxTurns: 2, dependsOn: ["Code Review"] },
];

const DEFAULT_USER_ROLE: Record<string, string> = {
    "Chief Executive Officer":      "Chief Product Officer",
    "Chief Technology Officer":     "Chief Executive Officer",
    "Database Optimization Expert": "Chief Technology Officer",
    "Cyber Security Specialist":    "Chief Technology Officer",
    "Programmer":                   "Chief Technology Officer",
    "Software Test Engineer":       "Programmer",
    "Code Reviewer":                "Programmer",
    "Technical Writer":             "Chief Executive Officer",
};

const DEFAULT_MAX_TURNS: Record<string, number> = {
    "Code Reviewer": 4,
    "Programmer":    2,
};
function maxTurnsFor(role: string): number {
    return DEFAULT_MAX_TURNS[role] ?? 2;
}

async function runSetupWizard(config: vscode.WorkspaceConfiguration): Promise<boolean> {
    const missingFields: string[] = [];
    if (!config.get<string>('vllmUrl'))    missingFields.push('vllmUrl');
    if (!config.get<string>('skillsPath')) missingFields.push('skillsPath');

    if (missingFields.length === 0) return true;

    const setup = await vscode.window.showWarningMessage(
        `⚙️ OpenAIStudio: не налаштовано: ${missingFields.join(', ')}. Налаштувати зараз?`,
        { modal: false }, 'Налаштувати', 'Пропустити'
    );
    if (setup !== 'Налаштувати') return true;

    if (!config.get<string>('vllmUrl')) {
        const vllmUrl = await vscode.window.showInputBox({
            title: '🔌 vLLM Server URL',
            prompt: 'Базовий URL БЕЗ /v1. Приклад: http://10.1.0.102:8050',
            placeHolder: 'http://10.1.0.102:8050',
            ignoreFocusOut: true,
        });
        if (vllmUrl) await config.update('vllmUrl', vllmUrl, vscode.ConfigurationTarget.Global);
    }

    if (!config.get<string>('perplexicaUrl')) {
        const perplexicaUrl = await vscode.window.showInputBox({
            title: '🔍 Perplexica URL (веб-пошук)',
            prompt: 'URL Perplexica (залиште порожнім щоб пропустити)',
            placeHolder: 'http://localhost:3001',
            ignoreFocusOut: true,
        });
        if (perplexicaUrl?.trim()) {
            await config.update('perplexicaUrl', perplexicaUrl, vscode.ConfigurationTarget.Global);
        }
    }

    if (!config.get<string>('skillsPath')) {
        const pick = await vscode.window.showInformationMessage(
            '📚 Оберіть директорію з навичками',
            { modal: false }, 'Обрати папку', 'Ввести вручну', 'Пропустити'
        );
        if (pick === 'Обрати папку') {
            const uri = await vscode.window.showOpenDialog({
                canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
            });
            if (uri?.[0]) await config.update('skillsPath', uri[0].fsPath, vscode.ConfigurationTarget.Global);
        } else if (pick === 'Ввести вручну') {
            const skillsPath = await vscode.window.showInputBox({
                prompt: 'Повний шлях до папки з SKILL.md файлами', ignoreFocusOut: true,
            });
            if (skillsPath?.trim()) await config.update('skillsPath', skillsPath, vscode.ConfigurationTarget.Global);
        }
    }

    vscode.window.showInformationMessage('✅ Налаштування збережено!');
    return true;
}

async function syncSkills(context: vscode.ExtensionContext): Promise<void> {
    const config = vscode.workspace.getConfiguration('openaistudio');
    let skillsPath = config.get<string>('skillsPath', '');
    if (!skillsPath) {
        skillsPath = path.join(os.homedir(), 'Documents', 'antigravity-awesome-skills');
        await config.update('skillsPath', skillsPath, vscode.ConfigurationTarget.Global);
    }

    return new Promise<void>((resolve) => {
        cp.exec('git --version', (err) => {
            if (err) {
                vscode.window.showWarningMessage('Git не знайдено.');
                return resolve();
            }
            const needsClone = !fs.existsSync(skillsPath);
            const title = needsClone ? 'OpenAIStudio: Клонування скілів...' : 'OpenAIStudio: Оновлення скілів...';
            vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: false }, async () => {
                const cmd = needsClone
                    ? `git clone https://github.com/sickn33/antigravity-awesome-skills.git "${skillsPath}"`
                    : `git -C "${skillsPath}" pull`;
                return new Promise<void>((innerResolve) => {
                    cp.exec(cmd, (execErr) => {
                        if (execErr) vscode.window.showErrorMessage(`Помилка синхронізації: ${execErr.message}`);
                        else vscode.window.showInformationMessage(`✅ Скіли синхронізовано у: ${skillsPath}`);
                        innerResolve(); resolve();
                    });
                });
            });
        });
    });
}

function loadRoleConfig(extensionPath: string): RoleConfig {
    // Priority: Project root RoleConfig.json, then src/config/RoleConfig.json
    const paths = [
        path.join(extensionPath, 'RoleConfig.json'),
        path.join(extensionPath, 'src', 'config', 'RoleConfig.json')
    ];

    for (const configPath of paths) {
        if (fs.existsSync(configPath)) {
            try {
                const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    console.log(`OpenAIStudio: Loaded RoleConfig from ${configPath}`);
                    return parsed;
                }
            } catch (e) {
                console.warn(`Error parsing ${configPath}:`, e);
            }
        }
    }
    return {};
}

/**
 * Normalizes RoleConfig to extract systemPrompt and optional model for a given role.
 */
function getRoleDetail(config: RoleConfig, roleName: string): { prompt: string, model?: string, skills?: string[] } {
    // 1. Check if "roles" field exists (new structure)
    if (config.roles && config.roles[roleName]) {
        const detail = config.roles[roleName];
        return { prompt: detail.systemPrompt, model: detail.model, skills: detail.skills };
    }
    // 2. Check if the role is a direct key
    const val = (config as any)[roleName];
    if (val) {
        if (typeof val === 'string') return { prompt: val };
        return { prompt: val.systemPrompt, model: val.model, skills: val.skills };
    }
    // 3. Fallback
    return { prompt: `You are the ${roleName}. Append <DONE> when finished.` };
}

async function executeProject(idea: string, context: vscode.ExtensionContext) {
    if (isExecuting) {
        vscode.window.showWarningMessage('⏳ OpenAIStudio: Зачекайте завершення попереднього завдання!');
        ChatWebview.currentPanel?.broadcastEvent({ type: 'error', content: '⏳ Зачекайте або зупиніть поточне завдання.' });
        return;
    }

    isExecuting = true;
    const config  = vscode.workspace.getConfiguration('openaistudio');
    const vllmUrl = config.get<string>('vllmUrl', '');
    if (!vllmUrl) { isExecuting = false; vscode.window.showErrorMessage('❌ vLLM URL не вказано.'); return; }

    const roleConfig = loadRoleConfig(context.extensionPath);

    ChatWebview.createOrShow(context.extensionUri);
    ChatWebview.currentPanel?.notifyStart();

    let fullExecutionPrompt = idea;
    if (globalSessionContext) {
        fullExecutionPrompt = `Історія попередніх сесій:\n${globalSessionContext}\nНове завдання: ${idea}`;
        ChatWebview.currentPanel?.broadcastEvent({ type: 'narration', content: `🔄 Продовження роботи над проектом` });
    } else {
        ChatWebview.currentPanel?.broadcastEvent({ type: 'narration', content: `🚀 Запуск проєкту: ${idea}` });
    }
    ChatWebview.currentPanel?.broadcastEvent({ type: 'narration', content: `🔌 vLLM: ${vllmUrl}` });

    const chatChain = new ChatChain();
    chatChain.onEvent = (ev) => ChatWebview.currentPanel?.broadcastEvent(ev);

    ChatWebview.currentPanel?.broadcastEvent({ type: 'narration', content: `🔍 Аналізую задачу та будую DAG...` });

    // FIX: reset complexity at start of every run
    VLLMModelBackend.currentTaskComplexity = "High";

    interface DagPhase { name: string; role: string; dependsOn: string[]; }
    let dagPhases: DagPhase[] = [];

    // FIX: roles in quotes so model copies them exactly; stronger enforcement
    const availableRoles = Object.keys(roleConfig).map(r => `"${r}"`).join(', ');

    const ceoSystemPrompt = `Your goal is to complete the task: ${idea}\n` +
                "You have access to specialized roles specified in RoleConfig.json.\n" +
                "HEAVY PROJECTS (Complex logic, files, DB, Security): Use 8 roles sequentially: " +
                "Chief Executive Officer -> Chief Technology Officer -> Database Optimization Expert -> Cyber Security Specialist -> Programmer -> Software Test Engineer -> Code Reviewer -> Technical Writer.\n" +
                "LIGHT PROJECTS (Single scripts, simple UI): Use 3 roles: Programmer -> Code Reviewer -> Technical Writer.\n" +
                "Return ONLY valid JSON including 'complexity' ('Low' or 'High') and 'plan' (an array of phases).\n" +
                "Each phase MUST have 'phaseName', 'assistantRole', 'userRole', 'maxTurns', and 'dependsOn'.\n" +
                "IMPORTANT: Respond ONLY with a valid JSON object.";

    let contextForCEO = globalSessionContext;
    if (contextForCEO.length > 2000) contextForCEO = contextForCEO.substring(contextForCEO.length - 2000);
    const ceoUserMsg = `TASK: "${idea}"\n\n${contextForCEO ? `=== PREVIOUS SESSION CONTEXT ===\n${contextForCEO}` : ""}`;

    try {
        const analyzer = new VLLMModelBackend("Chief Executive Officer");
        const response = await analyzer.step([
            { role: "user", content: `${ceoSystemPrompt}\n\n${ceoUserMsg}` }
        ]);

        let cleaned = response.trim();
        const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (fenced) cleaned = fenced[1];

        const parsed = JSON.parse(cleaned);

        if (parsed.complexity) {
            VLLMModelBackend.currentTaskComplexity =
                String(parsed.complexity).toLowerCase() === "low" ? "Low" : "High";
        }

        if (Array.isArray(parsed.phases) && parsed.phases.length > 0) {
            const knownRoles = new Set(Object.keys(roleConfig));

            // FIX: remap unknown/hallucinated roles to nearest known role
            dagPhases = parsed.phases
                .filter((p: any) => p && typeof p.name === 'string' && typeof p.role === 'string')
                .map((p: any) => {
                    let role = p.role.trim();
                    if (!knownRoles.has(role)) {
                        const r = role.toLowerCase();
                        if      (r.includes('frontend') || r.includes('ui') || r.includes('design')) role = 'Frontend Developer';
                        else if (r.includes('backend')  || r.includes('server') || r.includes('api')) role = 'Backend Developer';
                        else if (r.includes('review')   || r.includes('qa')    || r.includes('test')) role = 'Code Reviewer';
                        else if (r.includes('doc')      || r.includes('writer'))                      role = 'Technical Writer';
                        else if (r.includes('architect')|| r.includes('cto')   || r.includes('tech')) role = 'Chief Technology Officer';
                        else                                                                           role = 'Programmer';
                        console.warn(`CEO used unknown role "${p.role.trim()}" → remapped to "${role}"`);
                    }
                    return {
                        name:      p.name.trim(),
                        role,
                        dependsOn: Array.isArray(p.dependsOn) ? p.dependsOn.map((d: any) => String(d).trim()) : [],
                    };
                });

            const planStr = dagPhases.map(p =>
                `  ${p.name} [${p.role}]${p.dependsOn.length ? ` → after: ${p.dependsOn.join(', ')}` : ' (start)'}`
            ).join('\n');
            ChatWebview.currentPanel?.broadcastEvent({
                type: 'narration',
                content: `⚙️ Динамічний DAG (складність: ${VLLMModelBackend.currentTaskComplexity}):\n${planStr}`
            });
        }
    } catch (e) {
        console.error("CEO DAG analysis failed, using fallback pipeline:", e);
        ChatWebview.currentPanel?.broadcastEvent({
            type: 'narration', content: `⚠️ CEO аналіз не вдався — використовую стандартний план.`
        });
    }

    // ── Build phases ──────────────────────────────────────────────────────────
    let plan: Array<{
        phaseName: string;
        assistantRole: string;
        userRole: string;
        maxTurns: number;
        dependsOn: string[];
    }> = [];

    if (dagPhases.length === 0) {
        const isSimpleTask = idea.length < 150 &&
                            !idea.toLowerCase().includes('database') &&
                            !idea.toLowerCase().includes('security') &&
                            !idea.toLowerCase().includes('api') &&
                            !idea.toLowerCase().includes('architecture');

        plan = isSimpleTask ? [
            { phaseName: "Implementation",       assistantRole: "Programmer",       userRole: "Chief Technology Officer", maxTurns: 2, dependsOn: [] },
            { phaseName: "Code Review",          assistantRole: "Code Reviewer",    userRole: "Programmer",               maxTurns: 4, dependsOn: ["Implementation"] },
            { phaseName: "Project Documentation",assistantRole: "Technical Writer", userRole: "Chief Executive Officer",  maxTurns: 2, dependsOn: ["Code Review"] },
        ] : FALLBACK_PIPELINE;

        for (const step of plan) {
            const assistantDetail = getRoleDetail(roleConfig, step.assistantRole);
            const userDetail      = getRoleDetail(roleConfig, step.userRole);
            chatChain.addPhase(
                new Phase(
                    step.phaseName,
                    step.assistantRole,
                    step.userRole,
                    assistantDetail.prompt,
                    userDetail.prompt,
                    step.maxTurns,
                    assistantDetail.model,
                    VLLMModelBackend.currentTaskComplexity,
                    assistantDetail.skills
                ),
                step.dependsOn
            );
        }
    } else {
        for (const p of dagPhases) {
            const assistantDetail = getRoleDetail(roleConfig, p.role); // Use p.role for assistant
            const userRole        = DEFAULT_USER_ROLE[p.role] ?? "Chief Product Officer"; // Determine user role based on assistant
            const userDetail      = getRoleDetail(roleConfig, userRole);

            const phase = new Phase(
                p.name, // Use p.name for phaseName
                p.role, // Use p.role for assistantRole
                userRole,
                assistantDetail.prompt,
                userDetail.prompt,
                maxTurnsFor(p.role), // Use p.role for maxTurns
                assistantDetail.model, // New: Pass model from config
                VLLMModelBackend.currentTaskComplexity,
                assistantDetail.skills
            );
            chatChain.addPhase(phase, p.dependsOn);
        }
    }

    try {
        const env = await chatChain.execute(fullExecutionPrompt);

        globalSessionContext += `\n[Користувач]: ${idea}\n`;
        const phaseKeys = Object.keys(env);
        if (phaseKeys.length > 0) {
            const lastPhase = phaseKeys[phaseKeys.length - 1];
            // Store only the summary (not raw output with file contents)
            // to keep context compact and avoid confusing next run
            let output = env[`${lastPhase}_summary`] || "";
            if (output.length > 1000) output = output.substring(0, 1000) + "…";
            if (output) globalSessionContext += `[Результат (${lastPhase})]:\n${output}\n---\n`;
        }
        // Cap total session context to prevent prompt overflow
        if (globalSessionContext.length > 3000) {
            globalSessionContext = globalSessionContext.substring(globalSessionContext.length - 3000);
        }

        ChatWebview.currentPanel?.broadcastEvent({ type: 'narration', content: "✅ Процес завершено." });
        ChatWebview.currentPanel?.broadcastEvent({ type: 'done' });
    } catch (e: any) {
        ChatWebview.currentPanel?.broadcastEvent({ type: 'error', content: `❌ Помилка: ${e.message}` });
    } finally {
        isExecuting = false;
    }
}

export function activate(context: vscode.ExtensionContext) {
    try {
        console.log('OpenAIStudio_vLLM_Agent: Attempting to activate...');
        vscode.window.showInformationMessage('OpenAIStudio: Активація розширення...');

        context.subscriptions.push(vscode.commands.registerCommand('openaistudio.openSettings', async () => {
            await runSetupWizard(vscode.workspace.getConfiguration('openaistudio'));
        }));
        context.subscriptions.push(vscode.commands.registerCommand('openaistudio.openAgent', () => {
            ChatWebview.createOrShow(context.extensionUri);
        }));
        context.subscriptions.push(vscode.commands.registerCommand('openaistudio.newTask', async () => {
            globalSessionContext = "";
            vscode.window.showInformationMessage('OpenAIStudio: Нове завдання (контекст очищено).');
            ChatWebview.createOrShow(context.extensionUri);
        }));
        context.subscriptions.push(vscode.commands.registerCommand('openaistudio.startTaskFromWebview', async (idea: string) => {
            if (idea) await executeProject(idea, context);
        }));
        context.subscriptions.push(vscode.commands.registerCommand('openaistudio.stopAgent', () => {
            isExecuting = false;
            ChatWebview.currentPanel?.dispose();
        }));

        // Open a specific file from workspace in the default browser
        context.subscriptions.push(vscode.commands.registerCommand('openaistudio.openFileInBrowser', async (filename?: string) => {
            const workspaceFolder = path.join(context.extensionPath, 'workspace');
            let targetFile = filename;

            if (!targetFile) {
                // Let user pick from workspace files
                if (!fs.existsSync(workspaceFolder)) {
                    vscode.window.showWarningMessage('Workspace folder is empty. Run a task first.');
                    return;
                }
                const files = fs.readdirSync(workspaceFolder).filter(f => f.endsWith('.html') || f.endsWith('.htm'));
                if (files.length === 0) {
                    vscode.window.showWarningMessage('No HTML files found in workspace.');
                    return;
                }
                targetFile = files.length === 1 ? files[0] : await vscode.window.showQuickPick(files, {
                    title: 'Оберіть файл для відкриття в браузері'
                }) ?? undefined;
            }

            if (!targetFile) return;

            const filePath = path.join(workspaceFolder, targetFile);
            if (!fs.existsSync(filePath)) {
                vscode.window.showErrorMessage(`File not found: ${filePath}`);
                return;
            }
            const opened = await vscode.env.openExternal(vscode.Uri.file(filePath));
            if (!opened) {
                vscode.window.showTextDocument(vscode.Uri.file(filePath));
            }
        }));

        // Open workspace folder in Explorer
        context.subscriptions.push(vscode.commands.registerCommand('openaistudio.openWorkspace', () => {
            const workspaceFolder = path.join(context.extensionPath, 'workspace');
            if (!fs.existsSync(workspaceFolder)) fs.mkdirSync(workspaceFolder, { recursive: true });
            vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(workspaceFolder));
        }));
        context.subscriptions.push(vscode.commands.registerCommand('openaistudio.syncSkills', async () => {
            await syncSkills(context);
        }));
        context.subscriptions.push(vscode.commands.registerCommand('openaistudio.selectModel', async () => {
            const config  = vscode.workspace.getConfiguration('openaistudio');
            const vllmUrl = config.get<string>('vllmUrl', '');
            if (!vllmUrl) { vscode.window.showErrorMessage('Вкажіть vLLM URL спочатку.'); return; }
            try {
                const resp   = await axios.get(`${vllmUrl}/models`);
                const models = resp.data.data.map((m: any) => m.id);
                const picked = await vscode.window.showQuickPick(models, { title: 'Оберіть модель для vLLM' });
                if (picked) {
                    await config.update('model', picked, vscode.ConfigurationTarget.Global);
                    vscode.window.showInformationMessage(`Модель змінено на: ${picked}`);
                }
            } catch (e) {
                vscode.window.showErrorMessage('Не вдалося отримати список моделей з vLLM.');
            }
        }));

        const editorCommands = [
            { id: 'openaistudio.explainFile',  prompt: 'Поясни структуру та логіку цього файлу:' },
            { id: 'openaistudio.fixSelection', prompt: 'Знайди та виправ помилки у виділеному коді:' },
            { id: 'openaistudio.refactor',     prompt: 'Зроби рефакторинг виділеного коду (Clean Code):' },
            { id: 'openaistudio.writeTests',   prompt: 'Напиши Unit-тести для виділеного коду:' },
            { id: 'openaistudio.implement',    prompt: 'Реалізуй функціонал на основі коментарів у виділеному коді:' }
        ];
        for (const cmd of editorCommands) {
            context.subscriptions.push(vscode.commands.registerCommand(cmd.id, async () => {
                const ws         = new WorkspaceManager(context);
                const fullPrompt = `${cmd.prompt}\n\nКод/Файл:\n${ws.getActiveFileContent()}\n\nКонтекст:\n${ws.gatherContext()}`;
                await executeProject(fullPrompt, context);
            }));
        }
    } catch (error: any) {
        vscode.window.showErrorMessage(`Помилка активації OpenAIStudio: ${error.message}`);
        console.error('Activation error:', error);
    }
}

export function deactivate() {}