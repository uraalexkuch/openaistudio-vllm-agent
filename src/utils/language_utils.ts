import * as vscode from 'vscode';

export interface LangInfo {
    code: string;        // "uk", "en", "de" …
    label: string;       // "Ukrainian", "English" …
    nativeLabel: string; // "Українська", "English" …
}

const LANG_MAP: Record<string, LangInfo> = {
    'uk': { code: 'uk', label: 'Ukrainian',  nativeLabel: 'Українська'  },
    'en': { code: 'en', label: 'English',    nativeLabel: 'English'     },
    'de': { code: 'de', label: 'German',     nativeLabel: 'Deutsch'     },
    'fr': { code: 'fr', label: 'French',     nativeLabel: 'Français'    },
    'pl': { code: 'pl', label: 'Polish',     nativeLabel: 'Polski'      },
};

// Детектор за символами у тексті задачі
function detectLangFromText(text: string): string | null {
    const sample = text.slice(0, 300);
    const cyrillicUk = (sample.match(/[іїєґІЇЄҐ]/g) || []).length;
    const cyrillic    = (sample.match(/[а-яА-Я]/g)   || []).length;
    const latin       = (sample.match(/[a-zA-Z]/g)   || []).length;

    if (cyrillicUk > 2)   return 'uk';
    if (cyrillic > latin)  return 'uk'; // fallback кирилиці → uk
    if (latin > 3)         return 'en';
    return null;
}

/**
 * Визначає мову UI за трирівневим пріоритетом:
 * 1. Явне налаштування openaistudio.uiLanguage
 * 2. Мова задачі користувача (детектується за символами)
 * 3. Мова VS Code інтерфейсу (vscode.env.language)
 */
export function resolveUiLanguage(taskText?: string): LangInfo {
    const config = vscode.workspace.getConfiguration('openaistudio');
    const explicit = config.get<string>('uiLanguage', '').trim().toLowerCase();

    if (explicit && LANG_MAP[explicit]) {
        return LANG_MAP[explicit];
    }

    if (taskText) {
        const detected = detectLangFromText(taskText);
        if (detected && LANG_MAP[detected]) return LANG_MAP[detected];
    }

    // vscode.env.language повертає BCP-47 типу "uk", "en-US", "zh-CN"
    const vscodeLang = vscode.env.language.split('-')[0].toLowerCase();
    return LANG_MAP[vscodeLang] ?? LANG_MAP['en'];
}

/**
 * Формує рядок LANGUAGE RULE для ін'єкції в system prompt агента.
 */
export function buildLanguageRule(lang: LangInfo): string {
    return (
        `LANGUAGE RULE: You may reason and think internally in any language. ` +
        `Your FINAL visible response in the chat MUST be written in ${lang.label} (${lang.code}). ` +
        `This rule is absolute — it overrides any other language instruction. ` +
        `Native name: ${lang.nativeLabel}.`
    );
}
