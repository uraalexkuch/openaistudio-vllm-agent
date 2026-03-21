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

type RoleConfig = Record<string, string>;

const FALLBACK_PIPELINE: Array<{
    phaseName: string;
    assistantRole: string;
    userRole: string;
    maxTurns: number;
    dependsOn: string[];
}> = [
    { phaseName: "System Architecture", assistantRole: "Chief Technology Officer",  userRole: "Chief Product Officer",    maxTurns: 2, dependsOn: [] },
    { phaseName: "Coding",              assistantRole: "Programmer",                userRole: "Chief Technology Officer", maxTurns: 2, dependsOn: ["System Architecture"] },
    { phaseName: "CodeReview",          assistantRole: "Code Reviewer",             userRole: "Programmer",               maxTurns: 4, dependsOn: ["Coding"] },
    { phaseName: "Documentation",       assistantRole: "Technical Writer",          userRole: "Chief Product Officer",    maxTurns: 2, dependsOn: ["CodeReview"] },
];

const DEFAULT_USER_ROLE: Record<string, string> = {
    "Programmer":                   "Chief Technology Officer",
    "Frontend Developer":           "Chief Technology Officer",
    "Backend Developer":            "Chief Technology Officer",
    "Chief Technology Officer":     "Chief Product Officer",
    "Code Reviewer":                "Programmer",
    "Technical Writer":             "Chief Product Officer",
    "Database Optimization Expert": "Chief Technology Officer",
    "Cyber Security Specialist":    "Chief Technology Officer",
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
    const configPath = path.join(extensionPath, 'src', 'config', 'RoleConfig.json');
    if (!fs.existsSync(configPath)) { console.warn('RoleConfig.json not found at', configPath); return {}; }
    try {
        const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as RoleConfig;
        return {};
    } catch (e) {
        vscode.window.showWarningMessage(`RoleConfig.json parse error: ${e}`);
        return {};
    }
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

    const ceoSystemPrompt = `You are a senior software architect. Analyze the task and return a JSON execution plan.
Return ONLY valid JSON — no markdown, no explanation, no text before or after the JSON.

ALLOWED ROLES (use EXACTLY these strings, nothing else):
${availableRoles}

Response format:
{"complexity":"Low"|"High","phases":[{"name":"<unique name>","role":"<EXACT role from list above>","dependsOn":[]}]}

CRITICAL RULES:
- "role" MUST be copied EXACTLY from the allowed roles list — no variations, no invented roles
- "name" must be unique across all phases
- "dependsOn" lists names of phases that must finish first ([] for start phases)

IMPORTANT — SINGLE FILE RULE:
If the entire deliverable is ONE FILE (e.g. a single .html, .py, .js file), use EXACTLY this structure:
{"complexity":"Low","phases":[
  {"name":"Coding","role":"Programmer","dependsOn":[]},
  {"name":"Code Review","role":"Code Reviewer","dependsOn":["Coding"]},
  {"name":"Documentation","role":"Technical Writer","dependsOn":["Code Review"]}
]}
Do NOT split a single file into separate HTML/CSS/JS phases — all code goes in one Coding phase.

Parallel phases are ONLY for genuinely independent deliverables (e.g. separate frontend + backend servers).

Example fullstack (two separate servers):
{"complexity":"High","phases":[
  {"name":"System Architecture","role":"Chief Technology Officer","dependsOn":[]},
  {"name":"Frontend","role":"Frontend Developer","dependsOn":["System Architecture"]},
  {"name":"Backend","role":"Backend Developer","dependsOn":["System Architecture"]},
  {"name":"Integration Review","role":"Code Reviewer","dependsOn":["Frontend","Backend"]},
  {"name":"Documentation","role":"Technical Writer","dependsOn":["Integration Review"]}
]}`;

    let contextForCEO = globalSessionContext;
    if (contextForCEO.length > 1500) contextForCEO = contextForCEO.substring(contextForCEO.length - 1500);
    const ceoUserMsg = `Task: "${idea}"${contextForCEO ? `\nContext: ${contextForCEO}` : ""}`;

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
    if (dagPhases.length === 0) {
        for (const step of FALLBACK_PIPELINE) {
            const assistantPrompt = roleConfig[step.assistantRole] || `You are ${step.assistantRole}.`;
            const userPrompt      = roleConfig[step.userRole]      || `You are ${step.userRole}.`;
            chatChain.addPhase(
                new Phase(step.phaseName, step.assistantRole, step.userRole, assistantPrompt, userPrompt, step.maxTurns),
                step.dependsOn
            );
        }
    } else {
        for (const dp of dagPhases) {
            const assistantRole   = dp.role;
            const userRole        = DEFAULT_USER_ROLE[assistantRole] ?? "Chief Product Officer";
            const assistantPrompt = roleConfig[assistantRole] || `You are ${assistantRole}.`;
            const userPrompt      = roleConfig[userRole]      || `You are ${userRole}.`;
            chatChain.addPhase(
                new Phase(dp.name, assistantRole, userRole, assistantPrompt, userPrompt, maxTurnsFor(assistantRole)),
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
            // Prefer summary over raw output to keep context compact
            let output = env[`${lastPhase}_summary`] || env[lastPhase] || "";
            if (output.length > 2000) output = output.substring(0, 2000) + "... (скорочено)";
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