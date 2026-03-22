export type TaskIntent = 'create' | 'explain' | 'fix' | 'refactor' | 'add_feature' | 'document';

export interface TaskContext {
    intent:          TaskIntent;
    sourcePath:      string | null;
    useCurrentProject: boolean;
    description:     string;
}

const EXPLAIN_KEYWORDS = [
    'поясни','explain','розбери','analyze','аналізуй','опиши',
    'describe','review','перевір','what is','що це','як влаштован',
    'покажи структуру','show structure','розкажи про',
];
const FIX_KEYWORDS = [
    'виправ','fix','debug','дебаг','знайди баги','find bugs',
    'полагодь','repair','виправи помилки',
];
const REFACTOR_KEYWORDS = [
    'рефактор','refactor','покращ','improve','оптимізуй','optimize',
    'перепиши','rewrite','clean up','очисти код',
];
const ADD_KEYWORDS = [
    'додай','add','implement','реалізуй','розшир','extend',
    'інтегруй','integrate','підключи',
];
const DOCUMENT_KEYWORDS = [
    'документац', 'documentation', 'readme', 'задокументуй',
    'document this', 'document the', 'напиши документацію',
    'створи документацію', 'технічну документацію',
    'опиши проект', 'описати проект',
];

/**
 * Витягує абсолютний шлях з тексту задачі.
 */
function extractPath(text: string): string | null {
    // Windows: D:\path\to\project або D:/path/to/project
    const winMatch = text.match(/[A-Za-z]:[\\\/][^\s"']+/);
    if (winMatch) return winMatch[0].replace(/\\/g, '\\');

    // Unix: /home/user/project або ~/project
    const unixMatch = text.match(/(?:\/|~\/)[^\s"']+/);
    if (unixMatch) return unixMatch[0];

    // Quoted path: "path/to/project" або 'path/to/project'
    const quotedMatch = text.match(/["']([^"']+)["']/);
    if (quotedMatch) return quotedMatch[1];

    return null;
}

/**
 * Визначає намір користувача та шлях до проєкту.
 */
export function detectTaskIntent(
    idea: string,
    currentProjectPath?: string | null
): TaskContext {
    const lower = idea.toLowerCase();
    const sourcePath = extractPath(idea);

    let intent: TaskIntent = 'create';

    const hasDocKeyword = DOCUMENT_KEYWORDS.some(kw => lower.includes(kw));
    const mentionsCurrentProject = lower.includes('поточного') || 
                                   lower.includes('цього проект') ||
                                   lower.includes('current project') ||
                                   lower.includes('this project');

    if (hasDocKeyword && (mentionsCurrentProject || sourcePath || currentProjectPath)) {
        intent = 'document';
    } else if (EXPLAIN_KEYWORDS.some(kw => lower.includes(kw)))   intent = 'explain';
    else if (FIX_KEYWORDS.some(kw => lower.includes(kw)))         intent = 'fix';
    else if (REFACTOR_KEYWORDS.some(kw => lower.includes(kw)))    intent = 'refactor';
    else if (ADD_KEYWORDS.some(kw => lower.includes(kw)) && (sourcePath || currentProjectPath))
                                                                   intent = 'add_feature';

    // Якщо є шлях, але немає явного наміру "створити" — ймовірно, це аналіз
    if (sourcePath && intent === 'create') {
        const hasCreateKeyword = ['створи','create','зроби','make','build','напиши']
            .some(kw => lower.includes(kw));
        if (!hasCreateKeyword) intent = 'explain';
    }

    // Чи використовувати поточний проєкт:
    // — якщо немає явного шляху І намір не "create" І є відкритий проєкт
    const useCurrentProject =
        !sourcePath &&
        intent !== 'create' &&
        !!currentProjectPath;

    // Очистити опис від шляху, щоб не плутати агентів
    const description = sourcePath
        ? idea.replace(sourcePath, '').replace(/["']/g, '').trim()
        : idea;

    return { intent, sourcePath, useCurrentProject, description };
}
