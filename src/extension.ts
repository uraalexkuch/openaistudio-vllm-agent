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

// FIX: RoleConfig.json is a flat map of roleName → systemPrompt string.
// Previously the code did JSON.parse(raw).roles which always returned undefined
// because the file has no "roles" wrapper key — so every agent got a generic fallback.
type RoleConfig = Record<string, string>;

// Ordered pipeline — roles must exist in RoleConfig.json
// ── Static PIPELINE — used as FALLBACK if CEO analysis fails ─────────────────
// CEO normally returns a dynamic DAG (see executeProject).
// This fallback ensures the system works even if the model returns garbage.
const FALLBACK_PIPELINE: Array<{
    phaseName: string;
    assistantRole: string;
    userRole: string;
    maxTurns: number;
    dependsOn: string[];
}> = [
    { phaseName: "System Architecture",   assistantRole: "Chief Technology Officer",     userRole: "Chief Product Officer",    maxTurns: 2, dependsOn: [] },
    { phaseName: "Coding",                assistantRole: "Programmer",                   userRole: "Chief Technology Officer", maxTurns: 2, dependsOn: ["System Architecture"] },
    { phaseName: "CodeReview",            assistantRole: "Code Reviewer",                userRole: "Programmer",               maxTurns: 4, dependsOn: ["Coding"] },
    { phaseName: "Documentation",         assistantRole: "Technical Writer",             userRole: "Chief Product Officer",    maxTurns: 2, dependsOn: ["CodeReview"] },
];

// ── Role → default userRole counterpart ──────────────────────────────────────
// When CEO defines a phase with only an assistantRole, we pick a sensible reviewer.
const DEFAULT_USER_ROLE: Record<string, string> = {
    "Programmer":                   "Chief Technology Officer",
    "Chief Technology Officer":     "Chief Product Officer",
    "Code Reviewer":                "Programmer",
    "Technical Writer":             "Chief Product Officer",
    "Database Optimization Expert": "Chief Technology Officer",
    "Cyber Security Specialist":    "Chief Technology Officer",
};

// ── maxTurns per role ─────────────────────────────────────────────────────────
const DEFAULT_MAX_TURNS: Record<string, number> = {
    "Code Reviewer": 4,
    "Programmer":    2,
};
function maxTurnsFor(role: string): number {
    return DEFAULT_MAX_TURNS[role] ?? 2;
}


/**
 * Opens a step-by-step configuration wizard at first launch or when settings are missing.
 */
async function runSetupWizard(config: vscode.WorkspaceConfiguration): Promise<boolean> {
    const missingFields: string[] = [];
    if (!config.get<string>('vllmUrl'))      missingFields.push('vllmUrl');
    if (!config.get<string>('model'))        missingFields.push('model');
    if (!config.get<string>('skillsPath'))   missingFields.push('skillsPath (навички)');

    if (missingFields.length === 0) return true;

    const setup = await vscode.window.showWarningMessage(
        `⚙️ OpenAIStudio: не налаштовано ${missingFields.length} параметри: ${missingFields.join(', ')}. Налаштувати зараз?`,
        { modal: false },
        'Налаштувати', 'Пропустити'
    );

    if (setup !== 'Налаштувати') return true;

    if (!config.get<string>('vllmUrl')) {
        const vllmUrl = await vscode.window.showInputBox({
            title: '🔌 Крок 1/4 — vLLM Server URL',
            prompt: 'Введіть URL вашого локального сервера vLLM (OpenAI-сумісний)',
            placeHolder: 'Наприклад: http://10.1.0.102:8050/v1',
            ignoreFocusOut: true,
        });
        if (vllmUrl) {
            await config.update('vllmUrl', vllmUrl, vscode.ConfigurationTarget.Global);
        }
    }

    if (!config.get<string>('model')) {
        const model = await vscode.window.showInputBox({
            title: '🤖 Крок 2/4 — Назва моделі за замовчуванням',
            prompt: 'Назва моделі яку обслуговує vLLM (для більшості ролей)',
            placeHolder: 'Наприклад: qwen2.5-coder:32b або codestral',
            ignoreFocusOut: true,
        });
        if (model) {
            await config.update('model', model, vscode.ConfigurationTarget.Global);
        }
    }

    if (!config.get<string>('perplexicaUrl')) {
        const perplexicaUrl = await vscode.window.showInputBox({
            title: '🔍 Крок 3/4 — Perplexica URL (веб-пошук)',
            prompt: 'URL локального сервера Perplexica для веб-пошуку агентів',
            placeHolder: 'Наприклад: http://localhost:3001 (залиште порожнім, щоб пропустити)',
            ignoreFocusOut: true,
        });
        if (perplexicaUrl && perplexicaUrl.trim()) {
            await config.update('perplexicaUrl', perplexicaUrl, vscode.ConfigurationTarget.Global);
        }
    }

    if (!config.get<string>('skillsPath')) {
        const pickFolder = await vscode.window.showInformationMessage(
            '📚 Крок 4/4 — Оберіть директорію з навичками',
            { modal: false },
            'Обрати папку', 'Ввести вручну', 'Пропустити'
        );

        if (pickFolder === 'Обрати папку') {
            const folderUri = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                title: 'Оберіть директорію зі скілами',
            });
            if (folderUri && folderUri[0]) {
                await config.update('skillsPath', folderUri[0].fsPath, vscode.ConfigurationTarget.Global);
            }
        } else if (pickFolder === 'Ввести вручну') {
            const skillsPath = await vscode.window.showInputBox({
                title: 'Шлях до директорії навичок',
                prompt: 'Повний шлях до папки з SKILL.md файлами',
                placeHolder: 'Наприклад: C:\\Users\\User\\Documents\\antigravity-awesome-skills',
                ignoreFocusOut: true,
            });
            if (skillsPath && skillsPath.trim()) {
                await config.update('skillsPath', skillsPath, vscode.ConfigurationTarget.Global);
            }
        }
    }

    vscode.window.showInformationMessage('✅ Налаштування збережено!');
    return true;
}

/** Sync skills from repository */
async function syncSkills(context: vscode.ExtensionContext): Promise<void> {
    const config = vscode.workspace.getConfiguration('openaistudio');
    let skillsPath = config.get<string>('skillsPath', '');

    if (!skillsPath) {
        const docsPath = path.join(os.homedir(), 'Documents', 'antigravity-awesome-skills');
        skillsPath = docsPath;
        await config.update('skillsPath', skillsPath, vscode.ConfigurationTarget.Global);
    }

    return new Promise<void>((resolve) => {
        cp.exec('git --version', (err) => {
            if (err) {
                vscode.window.showWarningMessage('Git не знайдено. Скіли не можуть бути синхронізовані автоматично.');
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
                        if (execErr) {
                            vscode.window.showErrorMessage(`Помилка синхронізації: ${execErr.message}`);
                        } else {
                            vscode.window.showInformationMessage(`✅ Скіли синхронізовано у: ${skillsPath}`);
                        }
                        innerResolve();
                        resolve();
                    });
                });
            });
        });
    });
}

/** Loads and returns the role config map (flat: roleName → systemPrompt). */
function loadRoleConfig(extensionPath: string): RoleConfig {
    const configPath = path.join(extensionPath, 'src', 'config', 'RoleConfig.json');
    if (!fs.existsSync(configPath)) {
        console.warn('RoleConfig.json not found at', configPath);
        return {};
    }
    try {
        const raw = fs.readFileSync(configPath, 'utf8');
        // FIX: RoleConfig.json is a plain { "RoleName": "system prompt", ... } object.
        // The old code did JSON.parse(raw).roles which always returned undefined
        // because there is no "roles" wrapper key in the file.
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as RoleConfig;
        }
        console.warn('RoleConfig.json has unexpected shape:', typeof parsed);
        return {};
    } catch (e) {
        vscode.window.showWarningMessage(`RoleConfig.json parse error: ${e}`);
        return {};
    }
}

/** Executes the full project pipeline with a given idea */
async function executeProject(idea: string, context: vscode.ExtensionContext) {
    if (isExecuting) {
        vscode.window.showWarningMessage('⏳ OpenAIStudio: Зачекайте завершення попереднього завдання!');
        ChatWebview.currentPanel?.broadcastEvent({ type: 'error', content: '⏳ Зачекайте завершення попереднього завдання або зупиніть його (команда Stop All Agents).' });
        return;
    }

    isExecuting = true;
    const config = vscode.workspace.getConfiguration('openaistudio');
    const vllmUrl = config.get<string>('vllmUrl', '');
    if (!vllmUrl) {
        isExecuting = false;
        vscode.window.showErrorMessage('❌ vLLM URL не вказано.');
        return;
    }

    const roleConfig = loadRoleConfig(context.extensionPath);

    ChatWebview.createOrShow(context.extensionUri);
    ChatWebview.currentPanel?.notifyStart();

    let fullExecutionPrompt = idea;
    if (globalSessionContext) {
        fullExecutionPrompt = `Історія попередніх сесій та контекст проекту:\n${globalSessionContext}\nНове завдання користувача: ${idea}`;
        ChatWebview.currentPanel?.broadcastEvent({ type: 'narration', content: `🔄 Продовження роботи над проектом` });
    } else {
        ChatWebview.currentPanel?.broadcastEvent({ type: 'narration', content: `🚀 Запуск проєкту: ${idea}` });
    }
    ChatWebview.currentPanel?.broadcastEvent({ type: 'narration', content: `🔌 vLLM: ${vllmUrl}` });

    const chatChain = new ChatChain();
    chatChain.onEvent = (ev) => ChatWebview.currentPanel?.broadcastEvent(ev);

    ChatWebview.currentPanel?.broadcastEvent({ type: 'narration', content: `🔍 Аналізую задачу та будую DAG...` });

    // Reset complexity before each run
    VLLMModelBackend.currentTaskComplexity = "High";

    // ── Dynamic DAG interface ─────────────────────────────────────────────────
    interface DagPhase {
        name:       string;   // unique phase name, e.g. "Frontend Coding"
        role:       string;   // assistantRole, e.g. "Programmer"
        dependsOn:  string[]; // names of phases that must complete first
    }

    // ── CEO prompt — returns full DAG graph ───────────────────────────────────
    let dagPhases: DagPhase[] = [];

    const availableRoles = Object.keys(roleConfig).join(', ');

    const ceoSystemPrompt = `You are a senior software architect. Analyze the task and return a JSON execution plan.
Return ONLY valid JSON — no markdown, no explanation.

Available roles: ${availableRoles}

Response format:
{
  "complexity": "Low" | "High",
  "phases": [
    { "name": "<unique phase name>", "role": "<role from available roles>", "dependsOn": [] },
    { "name": "<phase2>",            "role": "<role>",                      "dependsOn": ["<phase1>"] }
  ]
}

Rules:
- "name" must be unique across all phases
- "dependsOn" lists names of phases that must finish before this one starts
- Phases with no shared dependencies run in PARALLEL automatically
- Always include a Coding phase and a Documentation phase
- For simple tasks (single HTML/script): 3-4 phases max
- For complex tasks (fullstack, microservices): split Coding into parallel parts
  e.g. "Frontend Coding" + "Backend Coding" both depending on "System Architecture",
  then "Integration" depending on both

Example for a simple task:
{"complexity":"Low","phases":[
  {"name":"System Architecture","role":"Chief Technology Officer","dependsOn":[]},
  {"name":"Coding","role":"Programmer","dependsOn":["System Architecture"]},
  {"name":"Code Review","role":"Code Reviewer","dependsOn":["Coding"]},
  {"name":"Documentation","role":"Technical Writer","dependsOn":["Code Review"]}
]}

Example for fullstack:
{"complexity":"High","phases":[
  {"name":"System Architecture","role":"Chief Technology Officer","dependsOn":[]},
  {"name":"Database Design","role":"Database Optimization Expert","dependsOn":["System Architecture"]},
  {"name":"Backend Coding","role":"Programmer","dependsOn":["Database Design"]},
  {"name":"Frontend Coding","role":"Programmer","dependsOn":["System Architecture"]},
  {"name":"Integration","role":"Code Reviewer","dependsOn":["Backend Coding","Frontend Coding"]},
  {"name":"Documentation","role":"Technical Writer","dependsOn":["Integration"]}
]}`;

    let contextForCEO = globalSessionContext;
    if (contextForCEO.length > 1500) {
        contextForCEO = contextForCEO.substring(contextForCEO.length - 1500);
    }
    const ceoUserMsg = `Task: "${idea}"${contextForCEO ? `\nContext: ${contextForCEO}` : ""}`;

    try {
        const analyzer = new VLLMModelBackend("Chief Executive Officer");
        const response  = await analyzer.step([
            { role: "user", content: `${ceoSystemPrompt}\n\n${ceoUserMsg}` }
        ]);

        // Strip markdown fences if model wraps output anyway
        let cleaned = response.trim();
        const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (fenced) cleaned = fenced[1];

        const parsed = JSON.parse(cleaned);

        if (parsed.complexity) {
            VLLMModelBackend.currentTaskComplexity =
                String(parsed.complexity).toLowerCase() === "low" ? "Low" : "High";
        }

        if (Array.isArray(parsed.phases) && parsed.phases.length > 0) {
            // Validate each phase has required fields
            dagPhases = parsed.phases
                .filter((p: any) => p && typeof p.name === 'string' && typeof p.role === 'string')
                .map((p: any) => ({
                    name:      p.name.trim(),
                    role:      p.role.trim(),
                    dependsOn: Array.isArray(p.dependsOn) ? p.dependsOn.map((d: any) => String(d).trim()) : [],
                }));

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
            type: 'narration',
            content: `⚠️ CEO аналіз не вдався — використовую стандартний план.`
        });
    }

    // ── Build phase objects from DAG (or fallback) ────────────────────────────
    if (dagPhases.length === 0) {
        // Fallback: use static pipeline
        for (const step of FALLBACK_PIPELINE) {
            const assistantPrompt = roleConfig[step.assistantRole] || `You are ${step.assistantRole}.`;
            const userPrompt      = roleConfig[step.userRole]      || `You are ${step.userRole}.`;
            chatChain.addPhase(
                new Phase(step.phaseName, step.assistantRole, step.userRole, assistantPrompt, userPrompt, step.maxTurns),
                step.dependsOn
            );
        }
    } else {
        // Dynamic DAG from CEO
        for (const dp of dagPhases) {
            const assistantRole   = dp.role;
            const userRole        = DEFAULT_USER_ROLE[assistantRole] ?? "Chief Product Officer";
            const assistantPrompt = roleConfig[assistantRole] || `You are ${assistantRole}.`;
            const userPrompt      = roleConfig[userRole]      || `You are ${userRole}.`;
            const maxTurns        = maxTurnsFor(assistantRole);

            chatChain.addPhase(
                new Phase(dp.name, assistantRole, userRole, assistantPrompt, userPrompt, maxTurns),
                dp.dependsOn
            );
        }
    }

    try {
        const env = await chatChain.execute(fullExecutionPrompt);

        globalSessionContext += `\n[Користувач]: ${idea}\n`;
        const phaseKeys = Object.keys(env);
        if (phaseKeys.length > 0) {
            const lastPhase = phaseKeys[phaseKeys.length - 1];
            let output = env[lastPhase] || "";
            if (output.length > 2000) {
                output = output.substring(0, 2000) + "... (контент скорочено)";
            }
            globalSessionContext += `[Результат (${lastPhase})]:\n${output}\n---\n`;
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
            vscode.window.showInformationMessage('OpenAIStudio: Почато нове завдання (контекст очищено).');
            ChatWebview.createOrShow(context.extensionUri);
        }));

        context.subscriptions.push(vscode.commands.registerCommand('openaistudio.startTaskFromWebview', async (idea: string) => {
            if (idea) {
                console.log(`openaistudio.startTaskFromWebview: Starting project with idea: ${idea}`);
                await executeProject(idea, context);
            }
        }));

        context.subscriptions.push(vscode.commands.registerCommand('openaistudio.stopAgent', () => {
            isExecuting = false;
            ChatWebview.currentPanel?.dispose();
        }));

        context.subscriptions.push(vscode.commands.registerCommand('openaistudio.syncSkills', async () => {
            await syncSkills(context);
        }));

        context.subscriptions.push(vscode.commands.registerCommand('openaistudio.selectModel', async () => {
            const config = vscode.workspace.getConfiguration('openaistudio');
            const vllmUrl = config.get<string>('vllmUrl', '');
            if (!vllmUrl) {
                vscode.window.showErrorMessage('Вкажіть vLLM URL спочатку.');
                return;
            }

            try {
                const resp = await axios.get(`${vllmUrl}/models`);
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
            { id: 'openaistudio.explainFile',   prompt: 'Поясни структуру та логіку цього файлу:' },
            { id: 'openaistudio.fixSelection',  prompt: 'Знайди та виправ помилки у виділеному коді:' },
            { id: 'openaistudio.refactor',      prompt: 'Зроби рефакторинг виділеного коду (Clean Code):' },
            { id: 'openaistudio.writeTests',    prompt: 'Напиши Unit-тести для виділеного коду:' },
            { id: 'openaistudio.implement',     prompt: 'Реалізуй функціонал на основі коментарів у виділеному коді:' }
        ];

        for (const cmd of editorCommands) {
            context.subscriptions.push(vscode.commands.registerCommand(cmd.id, async () => {
                const ws = new WorkspaceManager(context);
                const editorContext = ws.gatherContext();
                const fileContent = ws.getActiveFileContent();
                const fullPrompt = `${cmd.prompt}\n\nКод/Файл:\n${fileContent}\n\nКонтекст проєкта:\n${editorContext}`;
                await executeProject(fullPrompt, context);
            }));
        }
    } catch (error: any) {
        vscode.window.showErrorMessage(`Помилка активації OpenAIStudio: ${error.message}`);
        console.error('Activation error:', error);
    }
}

export function deactivate() {}