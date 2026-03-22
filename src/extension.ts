// Copyright (c) 2026 Юрій Кучеренко.
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
import { invalidateSkillsCache } from './chatdev/skills';
import { buildProjectLayout } from './utils/project_utils';
import { getWorkspaceRoot } from './utils/path_utils';
import { detectTaskIntent, TaskIntent } from './utils/task_intent';

let globalSessionContext = "";
let isExecuting = false;

interface RoleDetail {
    model?: string;
    description?: string;
    skills?: string[];
    systemPrompt: string;
}

type RoleConfig = Record<string, string | RoleDetail> & { roles?: Record<string, RoleDetail> };

// Мікро: 1-3 операції — гра, скрипт, проста сторінка
const MICRO_PIPELINE = [
    { phaseName: "Implementation",        assistantRole: "Programmer",       userRole: "Chief Technology Officer", maxTurns: 2, dependsOn: [] },
    { phaseName: "Code Review",           assistantRole: "Code Reviewer",    userRole: "Programmer",               maxTurns: 3, dependsOn: ["Implementation"] },
    { phaseName: "Project Documentation", assistantRole: "Technical Writer", userRole: "Chief Executive Officer",  maxTurns: 1, dependsOn: ["Code Review"] },
];

// Стандарт: 4-7 операцій — REST API, dashboard, невеликий SaaS
const STANDARD_PIPELINE = [
    { phaseName: "System Architecture",   assistantRole: "Chief Technology Officer", userRole: "Chief Executive Officer",  maxTurns: 2, dependsOn: [] },
    { phaseName: "Implementation",        assistantRole: "Programmer",               userRole: "Chief Technology Officer", maxTurns: 3, dependsOn: ["System Architecture"] },
    { phaseName: "Code Review",           assistantRole: "Code Reviewer",            userRole: "Programmer",               maxTurns: 3, dependsOn: ["Implementation"] },
    { phaseName: "Project Documentation", assistantRole: "Technical Writer",         userRole: "Chief Executive Officer",  maxTurns: 1, dependsOn: ["Code Review"] },
];

// Повний: 8+ операцій — платформа, мікросервіси, складний SaaS
const FULL_PIPELINE = [
    { phaseName: "Business Analysis",     assistantRole: "Chief Executive Officer",      userRole: "Chief Product Officer",    maxTurns: 2, dependsOn: [] },
    { phaseName: "System Architecture",   assistantRole: "Chief Technology Officer",     userRole: "Chief Executive Officer",  maxTurns: 2, dependsOn: ["Business Analysis"] },
    { phaseName: "Database Optimization", assistantRole: "Database Optimization Expert", userRole: "Chief Technology Officer", maxTurns: 2, dependsOn: ["System Architecture"] },
    { phaseName: "Cyber Security Audit",  assistantRole: "Cyber Security Specialist",   userRole: "Chief Technology Officer", maxTurns: 2, dependsOn: ["System Architecture"] },
    { phaseName: "Implementation",        assistantRole: "Programmer",                   userRole: "Chief Technology Officer", maxTurns: 3, dependsOn: ["Database Optimization", "Cyber Security Audit"] },
    { phaseName: "Quality Assurance",     assistantRole: "Software Test Engineer",       userRole: "Programmer",               maxTurns: 2, dependsOn: ["Implementation"] },
    { phaseName: "Code Review",           assistantRole: "Code Reviewer",                userRole: "Programmer",               maxTurns: 4, dependsOn: ["Quality Assurance"] },
    { phaseName: "Project Documentation", assistantRole: "Technical Writer",             userRole: "Chief Executive Officer",  maxTurns: 1, dependsOn: ["Code Review"] },
];

const FALLBACK_PIPELINE = MICRO_PIPELINE;

const DEFAULT_USER_ROLE: Record<string, string> = {
    "Chief Executive Officer":      "Chief Product Officer",
    "Chief Technology Officer":     "Chief Executive Officer",
    "Database Optimization Expert": "Chief Technology Officer",
    "Cyber Security Specialist":    "Chief Technology Officer",
    "Frontend Developer":           "Chief Technology Officer",
    "Programmer":                   "Chief Technology Officer",
    "Software Test Engineer":       "Programmer",
    "Code Reviewer":                "Programmer",
    "Technical Writer":             "Chief Executive Officer",
    "Project Analyst":              "Chief Executive Officer",
};

const DEFAULT_MAX_TURNS: Record<string, number> = {
    "Code Reviewer":      4,
    "Programmer":         3,
    "Frontend Developer": 3,
    "Project Analyst":    4,
    "Technical Writer":   2,
};
function maxTurnsFor(role: string): number {
    return DEFAULT_MAX_TURNS[role] ?? 2;
}

/**
 * Truncates text at the last sentence boundary within the limit.
 */
function trimToSentence(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    const truncated = text.substring(0, maxLen);
    // Find last sentence end
    const lastStop = Math.max(
        truncated.lastIndexOf('. '),
        truncated.lastIndexOf('.\n'),
        truncated.lastIndexOf('! '),
        truncated.lastIndexOf('? '),
    );
    // If we found a stop in the last 40% of the truncated text, use it.
    // Otherwise just hard truncate to avoid losing too much info.
    return lastStop > maxLen * 0.6
        ? truncated.substring(0, lastStop + 1) + ' …'
        : truncated + ' …';
}

/**
 * Truncates context while preserving complete [...] blocks.
 */
function trimSessionContext(ctx: string, maxLen: number): string {
    if (ctx.length <= maxLen) return ctx;
    const tail = ctx.substring(ctx.length - maxLen);
    // Find start of first full block [...]
    const firstBlock = tail.indexOf('\n[');
    return firstBlock > 0 ? tail.substring(firstBlock + 1) : tail;
}

// Визначає чи задача потребує фронтенд-розробника
function detectTaskType(idea: string): { hasFrontend: boolean; hasBackend: boolean } {
    const lower = idea.toLowerCase();
    const frontendKeywords = [
        'html', 'css', 'page', 'сторінк', 'site', 'сайт', 'form', 'форм',
        'dashboard', 'дашборд', 'ui', 'ux', 'landing', 'лендінг',
        'react', 'vue', 'angular', 'animation', 'анімац',
        'responsive', 'адаптив', 'фронтенд', 'frontend',
        'інтерфейс', 'interface', 'button', 'кнопк', 'menu', 'меню',
        'modal', 'popup', 'slider', 'carousel', 'gallery', 'галере',
    ];
    const backendKeywords = [
        'api', 'server', 'сервер', 'endpoint', 'rest', 'graphql',
        'middleware', 'бекенд', 'backend', 'route', 'маршрут',
        'express', 'fastapi', 'django', 'flask', 'nest',
    ];
    const hasFrontend = frontendKeywords.some(kw => lower.includes(kw));
    const hasBackend  = backendKeywords.some(kw => lower.includes(kw));
    return { hasFrontend, hasBackend };
}

// Адаптує статичний пайплайн під тип задачі
function adaptPipelineForTaskType(
    pipeline: typeof MICRO_PIPELINE,
    taskType: { hasFrontend: boolean; hasBackend: boolean }
): typeof MICRO_PIPELINE {
    if (!taskType.hasFrontend) return pipeline;

    return pipeline.map(step => {
        if (step.assistantRole === "Programmer") {
            return {
                ...step,
                assistantRole: "Frontend Developer",
                phaseName: step.phaseName.replace("Implementation", "Frontend Implementation"),
            };
        }
        return step;
    });
}

function injectParallelFrontendBackend(
    pipeline: typeof STANDARD_PIPELINE
): typeof STANDARD_PIPELINE {
    // Знаходимо фазу Implementation і розбиваємо на 2 паралельні
    const implIdx = pipeline.findIndex(p => p.assistantRole === "Programmer");
    if (implIdx === -1) return pipeline;

    const original = pipeline[implIdx];
    const before   = pipeline.slice(0, implIdx);
    const after    = pipeline.slice(implIdx + 1);

    const fePhase  = { ...original, phaseName: "Frontend Implementation", assistantRole: "Frontend Developer" };
    const bePhase  = { ...original, phaseName: "Backend Implementation",  assistantRole: "Programmer" };

    // Code Review залежить від обох
    const reviewIdx = after.findIndex(p => p.assistantRole === "Code Reviewer");
    if (reviewIdx !== -1) {
        after[reviewIdx] = {
            ...after[reviewIdx],
            dependsOn: ["Frontend Implementation", "Backend Implementation"],
        };
    }

    return [...before, fePhase, bePhase, ...after];
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
                        if (execErr) {
                            vscode.window.showErrorMessage(`Помилка синхронізації: ${execErr.message}`);
                        } else {
                            invalidateSkillsCache();
                            vscode.window.showInformationMessage(`✅ Скіли синхронізовано у: ${skillsPath}`);
                        }
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
        path.join(extensionPath, 'dist', 'RoleConfig.json'),
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
    let currentTaskComplexity: string = "Low";
    const config  = vscode.workspace.getConfiguration('openaistudio');
    const vllmUrl = config.get<string>('vllmUrl', '');
    if (!vllmUrl) { isExecuting = false; vscode.window.showErrorMessage('❌ vLLM URL не вказано.'); return; }

    const roleConfig = loadRoleConfig(context.extensionPath);

    ChatWebview.createOrShow(context.extensionUri);
    ChatWebview.currentPanel?.notifyStart();

    // Отримати контекст відкритого проєкту
    const wsManager = new WorkspaceManager(context);
    const currentProject = wsManager.gatherProjectContext();

    // FIX Bug #2: reset ПІСЛЯ CEO, не до. (Safe fallback default)
    currentTaskComplexity = "Low";

    const taskCtx = detectTaskIntent(idea, currentProject.rootPath);
    const workspaceRoot = getWorkspaceRoot();

    let fullExecutionPrompt = taskCtx.description;

    // ── Logic Improvement: Inject active file for fix/refactor ────────────────
    if ((taskCtx.intent === 'fix' || taskCtx.intent === 'refactor') && taskCtx.useCurrentProject) {
        const activeFile = wsManager.getActiveFileContent();
        const activeContext = wsManager.gatherContext();
        if (activeFile && !fullExecutionPrompt.includes(activeFile.substring(0, 100))) {
            fullExecutionPrompt += `\n\n=== ACTIVE FILE ===\n${activeContext}\n${activeFile}`;
        }
    }

    if (globalSessionContext) {
        fullExecutionPrompt = `Історія попередніх сесій:\n${globalSessionContext}\nНове завдання: ${taskCtx.description}`;
        ChatWebview.currentPanel?.broadcastEvent({ type: 'narration', content: `🔄 Продовження роботи над проектом` });
    } else {
        ChatWebview.currentPanel?.broadcastEvent({ type: 'narration', content: `🚀 Запуск проєкту: ${taskCtx.description}` });
    }
    ChatWebview.currentPanel?.broadcastEvent({ type: 'narration', content: `🔌 vLLM: ${vllmUrl}` });

    // ── РЕЖИМ: Аналіз / Maintenance ──────────────────────────────────────────
    if (taskCtx.intent !== 'create') {
        const targetPath = taskCtx.sourcePath ?? (taskCtx.useCurrentProject ? currentProject.rootPath : null);

        if (taskCtx.useCurrentProject && !taskCtx.sourcePath) {
            ChatWebview.currentPanel?.broadcastEvent({
                type: 'narration',
                content: `📂 Аналізую поточний проєкт: ${currentProject.projectName}\n`
                       + `📍 Шлях: ${currentProject.rootPath}\n`
                       + `🔧 Стек: ${currentProject.stack}`
            });
        } else if (taskCtx.sourcePath) {
            ChatWebview.currentPanel?.broadcastEvent({
                type: 'narration',
                content: `🔍 Режим: ${intentLabel(taskCtx.intent)} існуючого проєкту`
                       + `\n📂 Шлях: ${taskCtx.sourcePath}`
             });
        } else {
            ChatWebview.currentPanel?.broadcastEvent({
                type: 'narration',
                content: `⚠️ Шлях до проєкту не знайдено. Відкрийте папку проєкту у VS Code або вкажіть шлях.`
            });
        }

        const hasInlineCode = fullExecutionPrompt.includes('```');
        const analysisContext = buildAnalysisContext(taskCtx, targetPath, currentProject, hasInlineCode);
        fullExecutionPrompt = `${analysisContext}\n\n${fullExecutionPrompt}`;

    // ── РЕЖИМ: Створення нового ──────────────────────────────────────────────
    } else {
        const layout = buildProjectLayout(idea, workspaceRoot);

        // Створити структуру папок заздалегідь
        if (!fs.existsSync(layout.projectPath)) {
            fs.mkdirSync(layout.projectPath, { recursive: true });
        }
        for (const fullDirPath of layout.dirs) {
            if (!fs.existsSync(fullDirPath)) {
                fs.mkdirSync(fullDirPath, { recursive: true });
            }
        }

        // Повідомити у чат та додати до промпту задачі
        const forcedStack = config.get<string>('forceStack', '');
        const stackSource = forcedStack ? '(вручну)' : '(автовизначено)';

        ChatWebview.currentPanel?.broadcastEvent({
            type: 'narration',
            content: `📁 Стек: ${layout.stack.toUpperCase()} ${stackSource} | Папка: workspace/${layout.slug}/`
        });

        fullExecutionPrompt = `${layout.promptHint}\n\n${fullExecutionPrompt}`;
    }

    const chatChain = new ChatChain();
    chatChain.onEvent = (ev) => ChatWebview.currentPanel?.broadcastEvent(ev);

    // 2. Детектор типу задачі
    const taskType = detectTaskType(idea);
    if (taskType.hasFrontend) {
        ChatWebview.currentPanel?.broadcastEvent({
            type: 'narration', content: `🎨 Виявлено UI/Frontend задачу → підключаю Frontend Developer`
        });
    }

    ChatWebview.currentPanel?.broadcastEvent({ type: 'narration', content: `🔍 Аналізую задачу та будую DAG...` });

    interface DagPhase { name: string; role: string; dependsOn: string[]; }
    let dagPhases: DagPhase[] = [];

    const rolesObj = (roleConfig as any).roles ?? roleConfig;
    const availableRoles = Object.keys(rolesObj).join(', ');

    const ceoSystemPrompt = taskCtx.intent === 'create'
        ? buildCreationCeoPrompt(idea, availableRoles)
        : buildAnalysisCeoPrompt(idea, taskCtx, availableRoles);

    const CEO_CONTEXT_LIMIT = 4000;
    let contextForCEO = globalSessionContext;
    if (contextForCEO.length > CEO_CONTEXT_LIMIT) {
        contextForCEO = trimSessionContext(contextForCEO, CEO_CONTEXT_LIMIT);
    }
    const ceoUserMsg = `TASK: "${idea}"\n\n${contextForCEO ? `=== PREVIOUS SESSION CONTEXT ===\n${contextForCEO}` : ""}`;

    try {
        const analyzer = new VLLMModelBackend("Chief Executive Officer");
        const response = await analyzer.step([
            { role: "user", content: `${ceoSystemPrompt}\n\n${ceoUserMsg}` }
        ]);

        let cleaned = response.trim().replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1');
        const parsed = JSON.parse(cleaned);

        // 4. Визначити складність із трьох рівнів
        const ops = Number(parsed.estimated_operations ?? 0);
        const c = String(parsed.complexity ?? "").toLowerCase();
        if      (ops <= 3 || c === "micro")     currentTaskComplexity = "Low";
        else if (ops <= 7 || c === "standard")  currentTaskComplexity = "Medium";
        else                                     currentTaskComplexity = "High";

        console.log(`CEO Analysis: Ops=${ops}, Complex=${currentTaskComplexity}, FE=${parsed.has_frontend}, BE=${parsed.has_backend}`);

        // Врахувати CEO-детекцію типу задачі
        const ceoDetectedFE = parsed.has_frontend === true;
        const effectiveTaskType = {
            hasFrontend: taskType.hasFrontend || ceoDetectedFE,
            hasBackend:  taskType.hasBackend  || parsed.has_backend === true,
        };

        // FIX Bug #1: support both 'plan' and 'phases'
        const rawPlan = parsed.plan ?? parsed.phases;
        if (Array.isArray(rawPlan) && rawPlan.length > 0) {
            const rolesObj = (roleConfig as any).roles ?? roleConfig;
            const knownRoles = new Set(Object.keys(rolesObj));

            // FIX: remap unknown/hallucinated roles to nearest known role
            dagPhases = rawPlan
                .filter((p: any) => p && typeof p.name === 'string' && typeof p.role === 'string')
                .map((p: any) => {
                    let role = p.role.trim();
                    // Автозаміна Programmer → Frontend Developer якщо треба
                    if (role === "Programmer" && effectiveTaskType.hasFrontend && !effectiveTaskType.hasBackend) {
                        role = "Frontend Developer";
                    }

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
                content: `⚙️ Динамічний DAG (складність: ${currentTaskComplexity}):\n${planStr}`
            });
        }
    } catch (e) {
        console.error("CEO DAG analysis failed, fallback to Micro:", e);
        // FIX Bug #2: single reset in catch as safe fallback
        currentTaskComplexity = "Low";
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
        let basePipeline =
            currentTaskComplexity === "High"   ? FULL_PIPELINE     :
            currentTaskComplexity === "Medium" ? STANDARD_PIPELINE :
                                      MICRO_PIPELINE;

        plan = adaptPipelineForTaskType(basePipeline, taskType) as any;
        
        // Якщо є і frontend і backend → додати паралельні фази
        if (taskType.hasFrontend && taskType.hasBackend && currentTaskComplexity !== "Low") {
            plan = injectParallelFrontendBackend(plan as any) as any;
        }

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
                    currentTaskComplexity,
                    assistantDetail.skills,
                    idea          // ← передаємо оригінальний текст задачі
                ),
                step.dependsOn
            );
        }
    } else {
        for (const p of dagPhases) {
            const assistantDetail = getRoleDetail(roleConfig, p.role);
            const userRole        = DEFAULT_USER_ROLE[p.role] ?? "Chief Product Officer";
            const userDetail      = getRoleDetail(roleConfig, userRole);

            const phase = new Phase(
                p.name,
                p.role,
                userRole,
                assistantDetail.prompt,
                userDetail.prompt,
                maxTurnsFor(p.role),
                assistantDetail.model,
                currentTaskComplexity,
                assistantDetail.skills,
                idea          // ← передаємо оригінальний текст задачі
            );
            chatChain.addPhase(phase, p.dependsOn);
        }
    }

        try {
            const env = await chatChain.execute(fullExecutionPrompt);
    
            // Тільки для create зберігаємо в сесію
            if (taskCtx.intent === 'create') {
                globalSessionContext += `\n[Користувач]: ${idea}\n`;
                const phaseKeys = Object.keys(env).filter(k => k.endsWith('_summary'));
                const allSummaries = phaseKeys
                    .map(k => {
                        const phaseName = k.replace('_summary', '');
                        const summary   = env[k];
                        const trimmed   = summary ? trimToSentence(summary, 600) : '';
                        return trimmed ? `[${phaseName}]: ${trimmed}` : null;
                    })
                    .filter(Boolean)
                    .join('\n\n');
                if (allSummaries) {
                    globalSessionContext += `[Результат "${idea}"]:\n${allSummaries}\n---\n`;
                }
            }

        // Якщо стек був зафіксований вручну — запропонувати скинути
        const forcedStack = config.get<string>('forceStack', '');
        if (forcedStack) {
            const reset = await vscode.window.showInformationMessage(
                `Стек "${forcedStack}" зафіксований. Скинути на "Автоматично"?`,
                'Так, скинути', 'Залишити'
            );
            if (reset === 'Так, скинути') {
                await config.update('forceStack', '', vscode.ConfigurationTarget.Global);
            }
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
        context.subscriptions.push(
            vscode.commands.registerCommand('openaistudio.selectStack', async () => {
                const config = vscode.workspace.getConfiguration('openaistudio');

                const STACK_LABELS: Array<{ label: string; description: string; value: string }> = [
                    { label: '$(search) Автоматично',            description: 'Визначати зі тексту задачі', value: '' },
                    { label: '$(globe) HTML/CSS/JS',              description: 'vanilla',         value: 'html' },
                    { label: '$(symbol-class) React',             description: 'Vite / CRA',      value: 'react' },
                    { label: '$(symbol-class) Vue 3',             description: 'Vite',            value: 'vue' },
                    { label: '$(symbol-class) Angular',           description: 'ng CLI',          value: 'angular' },
                    { label: '$(symbol-class) Svelte',            description: 'Vite',            value: 'svelte' },
                    { label: '$(symbol-class) Astro',             description: 'static',          value: 'astro' },
                    { label: '$(layers) Next.js',                 description: 'App Router',      value: 'nextjs' },
                    { label: '$(layers) Nuxt 3',                  description: 'fullstack',       value: 'nuxt' },
                    { label: '$(layers) Remix',                   description: 'fullstack',       value: 'remix' },
                    { label: '$(layers) SvelteKit',               description: 'fullstack',       value: 'sveltekit' },
                    { label: '$(server) Node.js',                 description: 'Express',         value: 'node' },
                    { label: '$(server) NestJS',                  description: 'TypeScript',      value: 'nestjs' },
                    { label: '$(server) Fastify',                 description: 'Node',            value: 'fastify' },
                    { label: '$(server) Hono',                    description: 'Edge/Bun',        value: 'hono' },
                    { label: '$(server) Flask',                   description: 'Python',          value: 'flask' },
                    { label: '$(server) FastAPI',                 description: 'Python',          value: 'fastapi' },
                    { label: '$(server) Django',                  description: 'Python',          value: 'django' },
                    { label: '$(terminal) Python script',         description: 'CLI/tool',        value: 'python' },
                    { label: '$(server) Go',                      description: 'Gin/stdlib',      value: 'golang' },
                    { label: '$(server) Spring Boot',             description: 'Java',            value: 'spring' },
                    { label: '$(server) Rust',                    description: 'Axum/Actix',      value: 'rust' },
                    { label: '$(server) .NET / C#',               description: 'ASP.NET',         value: 'dotnet' },
                    { label: '$(server) PHP / Laravel',           description: 'Laravel',         value: 'php' },
                    { label: '$(symbol-interface) TypeScript',    description: 'ts-node',         value: 'typescript' },
                    { label: '$(symbol-interface) Deno',          description: 'Oak/Fresh',       value: 'deno' },
                    { label: '$(device-mobile) React Native',     description: 'Expo',            value: 'reactnative' },
                    { label: '$(device-mobile) Flutter',          description: 'Dart',            value: 'flutter' },
                    { label: '$(desktop-download) Electron',      description: 'desktop',         value: 'electron' },
                    { label: '$(desktop-download) Tauri',         description: 'Rust+Web',        value: 'tauri' },
                    { label: '$(graph) Data Science',             description: 'Jupyter/Python',  value: 'datasci' },
                    { label: '$(hubot) ML / AI',                  description: 'PyTorch/TF',      value: 'mlops' },
                    { label: '$(package) Docker / DevOps',        description: 'Compose',         value: 'docker' },
                    { label: '$(repo) Monorepo',                  description: 'Turborepo',       value: 'monorepo' },
                ];

                const current = config.get<string>('forceStack', '') || '';
                const currentItem = STACK_LABELS.find(i => i.value === current);

                const picked = await vscode.window.showQuickPick(STACK_LABELS, {
                    title: `Вибір стеку проєкту  [поточний: ${currentItem?.label ?? 'Автоматично'}]`,
                    placeHolder: 'Почніть вводити назву стеку…',
                    matchOnDescription: true,
                });

                if (picked === undefined) return;

                await config.update('forceStack', picked.value, vscode.ConfigurationTarget.Global);

                const msg = picked.value
                    ? `Стек зафіксовано: ${picked.label}. Скиньте на "Автоматично" після задачі.`
                    : `Стек: Автоматично (визначається з тексту задачі).`;

                vscode.window.showInformationMessage(`OpenAIStudio: ${msg}`);
            })
        );
        context.subscriptions.push(vscode.commands.registerCommand('openaistudio.newTask', async () => {
            if (globalSessionContext.trim()) {
                const choice = await vscode.window.showWarningMessage(
                    'Очистити контекст поточного проєкту та почати новий?',
                    { modal: true },
                    'Так, новий проєкт',
                    'Ні, продовжити поточний'
                );
                if (choice !== 'Так, новий проєкт') return;
            }
            globalSessionContext = "";
            vscode.window.showInformationMessage('OpenAIStudio: Контекст очищено. Новий проєкт.');
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function intentLabel(intent: TaskIntent): string {
    const labels: Record<TaskIntent, string> = {
        explain:     'Аналіз',
        fix:         'Виправлення',
        refactor:    'Рефакторинг',
        add_feature: 'Додавання функціоналу',
        document:    'Документування',
        create:      'Створення',
    };
    return labels[intent];
}

function buildAnalysisContext(
    taskCtx:        ReturnType<typeof detectTaskIntent>,
    targetPath:     string | null,
    currentProject: ReturnType<WorkspaceManager['gatherProjectContext']>,
    hasInlineCode:  boolean
): string {

    if (!targetPath) {
        return [
            `═══ ANALYSIS TASK — NO PATH ═══`,
            `Intent: ${taskCtx.intent}`,
            `No project path found. Tell the user to:`,
            `  1. Open the project folder in VS Code (File → Open Folder)`,
            `  2. Or specify the path explicitly in the task`,
            `═════════════════════════════════`,
        ].join('\n');
    }

    const isCurrentProject = taskCtx.useCurrentProject;
    const projectInfo = isCurrentProject
        ? `\nKnown info:\n${currentProject.contextText}`
        : '';

    // Windows paths escaping
    const escapedSp = targetPath.replace(/\\/g, '\\\\');

    const permissions: Record<TaskIntent, string> = {
        explain:     `FORBIDDEN: write_file, make_directory, launch_file. READ ONLY.`,
        fix:         `ALLOWED: read_file, list_files, write_file (to fix issues).
                      FORBIDDEN: make_directory, launch_file unless explicitly requested.`,
        refactor:    `ALLOWED: read_file, list_files, write_file to refactor code.
                      FORBIDDEN: make_directory, launch_file.`,
        add_feature: `ALLOWED: all tools to add feature.`,
        document:    `ALLOWED: read_file, list_files, write_file for .md ONLY.
                      ALL write_file filenames MUST start with: "${escapedSp}/"
                      Example: {"filename": "${escapedSp}/README.md"}
                      FORBIDDEN: workspace/ path, modifying source code files.`,
        create:      `ALLOWED: all tools.`,
    };

    const workflow = hasInlineCode
        ? `Code is provided inline above. Analyze it directly.`
        : `1. Start with: list_files → {"directory": "${escapedSp}"}\n` +
          `2. Read key files: read_file → {"filename": "${escapedSp}/package.json"} (or main entry)`;

    const intentStep = taskCtx.intent === 'document'
        ? 'Write documentation files based on what you read'
        : (taskCtx.intent === 'fix' ? 'Fix issues and write_file' : 'Analyze and explain');

    return [
        `═══ EXISTING PROJECT: ${taskCtx.intent.toUpperCase()} ═══`,
        `Path:    ${targetPath}`,
        isCurrentProject ? `Source:  currently open in VS Code` : '',
        projectInfo,
        ``,
        `WORKFLOW:`,
        workflow,
        `3. ${intentStep}`,
        ``,
        permissions[taskCtx.intent],
        `DO NOT create workspace/ structure for this task.`,
        `═══════════════════════════════════`,
    ].filter(Boolean).join('\n');
}

function buildCreationCeoPrompt(idea: string, availableRoles: string): string {
    return [
        `TASK: "${idea}"`,
        `Available roles: ${availableRoles}`,
        ``,
        `Analyze the task and return ONLY valid JSON with these fields:`,
        `- estimated_operations: integer (count of distinct dev operations)`,
        `- justification: string (one sentence explaining the count)`,
        `- complexity: "Micro" | "Standard" | "Full"`,
        `  * Micro  = 1-3 ops  (single file, script, simple game)`,
        `  * Standard = 4-7 ops  (REST API, small app with DB)`,
        `  * Full  = 8+ ops  (platform, microservices, complex SaaS)`,
        `- has_frontend: boolean (does task need UI/HTML/CSS work?)`,
        `- has_backend: boolean (does task need server/API work?)`,
        `- plan: array of phases, each: { name, role, dependsOn: string[] }`,
        `  Use ONLY roles from the Available roles list above.`,
        `IMPORTANT: Respond ONLY with a valid JSON object.`
    ].join('\n');
}

function buildAnalysisCeoPrompt(
    idea: string,
    taskCtx: ReturnType<typeof detectTaskIntent>,
    roles: string
): string {
    const docGuide = taskCtx.intent === 'document' ? `
CRITICAL DAG RULES for documentation:
1. dependsOn values MUST be phase NAMES (not role names)
2. "Cyber Security Specialist", "Code Reviewer" etc are ROLES, not phases
3. CORRECT: {"name":"API Docs","role":"Technical Writer","dependsOn":["Project Analysis"]}
4. WRONG:   {"name":"API Docs","role":"Technical Writer","dependsOn":["Project Analysis","Cyber Security Specialist"]}
5. Keep it simple: ONE Project Analyst phase (Project Analysis), then Technical Writer phases in parallel
6. Maximum 4-5 documentation sections to avoid parallel overload
` : 'Build an analysis DAG. First phase MUST be "Project Analysis" (Project Analyst role) to read the code.';
    
    return [
        `TASK: "${idea}"`,
        `Intent: ${taskCtx.intent} existing project`,
        taskCtx.sourcePath ? `Source: ${taskCtx.sourcePath}` : '',
        `Available roles: ${roles}`,
        ``,
        docGuide,
        ``,
        `Return ONLY valid JSON block:`,
        `{`,
        `  "estimated_operations": <int>,`,
        `  "complexity": "Micro" | "Standard" | "Full",`,
        `  "has_frontend": <boolean>,`,
        `  "has_backend": <boolean>,`,
        `  "plan": [`,
        `    {"name": "Project Analysis", "role": "Project Analyst", "dependsOn": []},`,
        `    {"name": "...", "role": "...", "dependsOn": ["Project Analysis"]}`,
        `  ]`,
        `}`,
        ``,
        `CRITICAL:`,
        taskCtx.intent === 'document' 
            ? `- ONLY write_file for .md files allowed.`
            : `- Do NOT include write_file or code creation phases. Only research tools (list_files, read_file).`,
        `- Role "Project Analyst" is MANDATORY as the first step to read the codebase.`,
        `- NEVER use <tool_code> or JSON formatting in the DAG plan response itself.`,
    ].filter(Boolean).join('\n');
}

export function deactivate() {}