// Copyright (c) 2026 Юрій Кучеренко.
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface SkillMeta {
  filePath:    string;
  folderName:  string;
  name:        string;
  description: string;
  domain:      string;
  subdomain:   string;
  tags:        string[];
  score:       number;
}

export interface LoadedSkill extends SkillMeta {
  content: string;
}

export function getSkillsPath(): string {
  const configured = vscode.workspace.getConfiguration('openaistudio').get<string>('skillsPath', '');
  if (configured && typeof configured === 'string' && configured.trim() !== '') {
    return configured;
  }
  return '';
}

const _skillsCache: Map<string, { files: string[], ts: number }> = new Map();
const SKILLS_CACHE_TTL = 30_000;

export function invalidateSkillsCache(): void {
  _skillsCache.clear();
  _idfCache = null;
}

function scanSkillFolders(skillsPath: string): string[] {
  const cached = _skillsCache.get(skillsPath);
  if (cached && (Date.now() - cached.ts) < SKILLS_CACHE_TTL) {
    return cached.files;
  }

  const skillMd: string[] = [];
  const legacyMd: string[] = [];

  function walk(dir: string) {
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const full = path.join(dir, entry);
      try {
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else if (entry === 'SKILL.md') {
          skillMd.push(full);
        } else if (entry.endsWith('.md')) {
          legacyMd.push(full);
        }
      } catch {}
    }
  }

  walk(skillsPath);
  const files = Array.from(new Set([...skillMd, ...legacyMd]));
  _skillsCache.set(skillsPath, { files, ts: Date.now() });
  return files;
}

function readFrontmatter(filePath: string): string | null {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(2048);
    const n = fs.readSync(fd, buf, 0, 2048, 0);
    fs.closeSync(fd);
    const text = buf.subarray(0, n).toString('utf8');
    if (!text.startsWith('---')) return null;
    const end = text.indexOf('\n---', 3);
    return end === -1 ? null : text.slice(4, end).trim();
  } catch { return null; }
}

function parseYaml(yaml: string): Record<string, any> {
  const out: Record<string, any> = {};
  for (const line of yaml.split('\n')) {
    const m = line.match(/^([\w-]+):\s*(.+)$/);
    if (!m) continue;
    const [, key, raw] = m;
    const v = raw.trim();
    if (v.startsWith('[') && v.endsWith(']')) {
      out[key] = v.slice(1, -1)
          .split(',')
          .map(s => s.trim().replace(/^['"]|['"]$/g, '').toLowerCase())
          .filter(Boolean);
    } else {
      out[key] = v.replace(/^['"]|['"]$/g, '');
    }
  }
  return out;
}

const STOP = new Set([
  'the','a','an','in','on','at','to','of','and','or','for','is','it','be',
  'use','using','get','set','run','make','how','do','with',
  'що','як','для','та','і','або','з','у','в','це','на','до','по','при',
  'цей','цього','цьому','цим','ця','цієї','цю','цієї',
  'який','яка','яке','які','якого','якій','яким',
  'мені','мене','мій','моя','моє','мої','мого',
]);

// FIX: Restrict generic action verbs from the translation map.
// Previously "напиши", "створи", etc. mapped to ["create","implement","write"] which
// matched almost every skill. Now action verbs are NOT translated — only domain nouns
// and technical terms are, so skill matching is based on WHAT to build, not HOW.
const UA_EN: Record<string, string[]> = {
  // Domain nouns — safe to translate
  'структуру':  ['structure', 'architecture', 'overview', 'project'],
  'архітектуру':['architecture', 'structure', 'design'],
  'проєкту':    ['project', 'codebase', 'repository'],
  'код':        ['code', 'source'],
  'бекенд':     ['backend', 'server', 'api'],
  'фронтенд':   ['frontend', 'client', 'ui'],
  'апі':        ['api', 'rest', 'endpoint'],
  'безпека':    ['security', 'auth', 'authentication'],
  'тести':      ['tests', 'testing', 'unit-test'],
  'деплой':     ['deploy', 'deployment', 'ci-cd'],
  'документацію':['documentation', 'docs', 'readme'],
  'базу':       ['database', 'db', 'sql'],
  'гру':        ['game', 'gaming'],
  'гра':        ['game', 'gaming'],
  'хрестики':   ['game', 'tictactoe', 'html'],
  'ноліки':     ['game', 'tictactoe', 'html'],
  'сторінку':   ['html', 'page', 'frontend', 'web'],
  'сайт':       ['website', 'html', 'frontend', 'web'],
  'скрипт':     ['script', 'javascript', 'python'],
};

function expandWithTranslations(tokens: string[]): string[] {
  const expanded = new Set(tokens);
  for (const token of tokens) {
    const translations = UA_EN[token];
    if (translations) {
      translations.forEach(t => expanded.add(t));
    }
  }
  return Array.from(expanded);
}

function tokenize(text: string): string[] {
  const KEEP_SHORT = new Set(['3d', '2d', 'vr', 'ar', 'ai', 'ui', 'ux', 'ml', 'gl']);
  return text
      .toLowerCase()
      .replace(/[-_]/g, ' ')
      .split(/[\s,;:.!?()\[\]{}<>|"'`]+/)
      .filter(w => (w.length > 2 || KEEP_SHORT.has(w)) && !STOP.has(w));
}

let _idfCache: { 
  path: string, 
  data: Map<string, number>, 
  ts: number 
} | null = null;
const IDF_CACHE_TTL = 60_000; // 1 minute

function buildIdfCache(skillsPath: string): Map<string, number> {
  const now = Date.now();
  if (_idfCache && _idfCache.path === skillsPath && (now - _idfCache.ts) < IDF_CACHE_TTL) {
    return _idfCache.data;
  }

  const files = scanSkillFolders(skillsPath);
  if (files.length === 0) return new Map();

  const docFreq = new Map<string, number>();

  for (const filePath of files) {
    const yaml = readFrontmatter(filePath);
    if (!yaml) continue;

    const p     = parseYaml(yaml);
    const words = new Set<string>([
      ...tokenize(String(p['name']        || '')),
      ...tokenize(String(p['description'] || '')),
      ...tokenize(String(p['domain']      || '')),
      ...(Array.isArray(p['tags']) ? p['tags'].flatMap((t: string) => tokenize(t)) : []),
    ]);
    words.forEach(w => docFreq.set(w, (docFreq.get(w) ?? 0) + 1));
  }

  const N = files.length;
  const cache = new Map<string, number>();

  docFreq.forEach((df, token) => {
    const ratio = df / N;
    if      (ratio > 0.5) cache.set(token, 0.1);
    else if (ratio > 0.3) cache.set(token, 0.3);
    else if (ratio > 0.1) cache.set(token, 0.6);
    else                  cache.set(token, 1.0);
  });

  _idfCache = { path: skillsPath, data: cache, ts: now };
  return cache;
}

function idfWeight(token: string, idf: Map<string, number>): number {
  return idf.get(token) ?? 1.0;
}

function splitTaskAndContext(combined: string): { taskTokens: string[]; contextTokens: string[] } {
  const lines = combined.split('\n');
  const ctxMarkers = ['Key deps:', 'key deps:', 'Project:', 'Scripts:', 'Active file:', 'Selected code:', 'WORKSPACE', 'deps:', 'dependencies:'];

  let ctxStart = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (ctxMarkers.some(m => lines[i].startsWith(m))) { ctxStart = i; break; }
  }

  const taskText    = lines.slice(0, ctxStart).join('\n');
  const contextText = lines.slice(ctxStart).join('\n');

  const taskRaw    = extractQueryTokens(taskText);
  const contextRaw = extractQueryTokens(contextText);

  const taskExpanded = expandWithTranslations(taskRaw);
  const contextUnique = contextRaw.filter(t => !taskExpanded.includes(t));

  return { taskTokens: taskExpanded, contextTokens: contextUnique };
}

function scoreSkillIdf(
    meta:           SkillMeta,
    taskTokens:     string[],
    contextTokens:  string[],
    idf:            Map<string, number>,
): number {
  const nameT   = tokenize(meta.name + ' ' + meta.folderName);
  const descT   = tokenize(meta.description);
  const domainT = tokenize(meta.domain + ' ' + meta.subdomain);

  function baseScore(tw: string): number {
    if (meta.tags.some(t => t === tw || t.includes(tw) || tw.includes(t)))            return 3;
    if (descT.some(d => d === tw || d.includes(tw) || tw.includes(d)))                return 2;
    if (nameT.some(n => n === tw || n.includes(tw) || tw.includes(n)))                return 1;
    if (domainT.some(d => d.length > 2 && (d.includes(tw) || tw.includes(d))))        return 1;
    return 0;
  }

  let score = 0;
  for (const tw of taskTokens) {
    const base = baseScore(tw);
    if (base > 0) score += base * idfWeight(tw, idf);
  }

  for (const tw of contextTokens) {
    const base = baseScore(tw);
    if (base > 0) score += base * idfWeight(tw, idf) * 0.4;
  }

  return score;
}

function extractQueryTokens(text: string): string[] {
  const cleaned = text
      .slice(0, 4096)
      .replace(/[A-Za-z]:\\[\w\\.\ \-]*/g, ' ')
      .replace(/\/[\w\/.\-]+/g, ' ')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/\b\d{2,}\b/g, ' ')
      .replace(/[^\w\s]/g, ' ');
  return [...new Set(tokenize(cleaned))];
}

export function scanAndScoreAllSkillsIdf(
    combined:      string,
    alreadyLoaded: Set<string> = new Set(),
    // FIX: raised default minScore from 4 → 7 to prevent false-positive skill matches
    // on short/generic tasks. Only skills with strong topical overlap will be loaded.
    minScore       = 7,
): SkillMeta[] {
  const skillsPath = getSkillsPath();
  if (!skillsPath || !fs.existsSync(skillsPath)) return [];

  const files = scanSkillFolders(skillsPath);
  if (files.length === 0) return [];

  const idf = buildIdfCache(skillsPath);
  const { taskTokens, contextTokens } = splitTaskAndContext(combined);

  if (taskTokens.length === 0 && contextTokens.length === 0) return [];

  const scored: SkillMeta[] = [];

  for (const filePath of files) {
    const meta = buildSkillMeta(filePath, skillsPath);
    if (alreadyLoaded.has(meta.folderName)) continue;

    meta.score = scoreSkillIdf(meta, taskTokens, contextTokens, idf);
    if (meta.score >= minScore) scored.push(meta);
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

export function loadTopSkills(scored: SkillMeta[], maxSkills: number): LoadedSkill[] {
  const loaded: LoadedSkill[] = [];
  for (const meta of scored.slice(0, maxSkills)) {
    try {
      const content = fs.readFileSync(meta.filePath, 'utf8');
      loaded.push({ ...meta, content });
      console.log(`[Skills] Loaded "${meta.name}" (score: ${meta.score})`);
    } catch (e: any) {
      console.error(`[Skills] Failed to load ${meta.folderName}: ${e.message}`);
    }
  }
  return loaded;
}

function buildSkillMeta(filePath: string, skillsPath: string): SkillMeta {
  const rawRelative = path.relative(skillsPath, path.dirname(filePath)).replace(/\\/g, '/');

  // FIX: strip container dir if no SKILL.md is inside it directly
  const segments = rawRelative.split('/');
  const CONTAINER_DIRS = new Set(['skills', 'skill', 'content', 'categories', 'topics']);
  const folderName = (segments.length > 1 && CONTAINER_DIRS.has(segments[0].toLowerCase()))
      ? segments.slice(1).join('/')
      : rawRelative;

  const yaml = readFrontmatter(filePath);

  if (yaml) {
    const p = parseYaml(yaml);
    return {
      filePath, folderName,
      name:        String(p['name']        || folderName),
      description: String(p['description'] || ''),
      domain:      String(p['domain']      || ''),
      subdomain:   String(p['subdomain']   || ''),
      tags:        Array.isArray(p['tags']) ? p['tags'] : tokenize(folderName),
      score:       0,
    };
  }

  return {
    filePath, folderName,
    name: folderName, description: '', domain: '', subdomain: '',
    tags: tokenize(folderName), score: 0,
  };
}

const META_SKILLS = new Set(['clean-code', 'coding-standards', 'code-style']);

export async function autoLoadSkillsForTask(
    task: string,
    workspaceContext = '',
    maxSkills = 2,
    excludeMeta = false,
): Promise<LoadedSkill[]> {
  const combined = [task, workspaceContext].filter(Boolean).join('\n');
  if (!combined.trim()) return [];

  // Адаптивний поріг залежно від довжини запиту
  const tokenCount = combined.split(/\s+/).filter(w => w.length > 2).length;
  const primaryMin  = tokenCount <= 5 ? 5 : tokenCount <= 15 ? 7 : 10;
  const fallbackMin = Math.max(3, primaryMin - 3);

  let allScored = scanAndScoreAllSkillsIdf(combined, new Set(), primaryMin);
  
  if (allScored.length === 0) {
    const fallback = scanAndScoreAllSkillsIdf(combined, new Set(), fallbackMin);
    if (fallback.length > 0) {
      console.log(`[Skills] Using adaptive fallback threshold (${fallbackMin}): ${fallback.slice(0, maxSkills).map(s => s.name).join(', ')}`);
      allScored = fallback;
    } else {
      console.log(`[Skills] No relevant skills found. Proceeding without skills.`);
      return [];
    }
  }

  let result = loadTopSkills(allScored, maxSkills);
  
  if (excludeMeta) {
    const originalCount = result.length;
    result = result.filter(s => !META_SKILLS.has(s.folderName.toLowerCase()));
    if (result.length < originalCount) {
      console.log(`[Skills] Filtered out meta-skills. Remaining: ${result.map(s => s.name).join(', ')}`);
    }
  }

  return result;
}

export async function saveSkill(
    name: string,
    description: string,
    content: string
): Promise<string> {
  try {
    if (!name || !content) return 'Error: Missing "name" or "content".';

    const sp = getSkillsPath();
    if (!sp || !fs.existsSync(sp)) return 'Error: Skills path not configured or not found.';

    const folderName = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    const skillDir = path.join(sp, folderName);

    const fileContent = `---\nname: ${name}\ndescription: ${description || ''}\ntags: [auto-generated]\n---\n\n${content}`;

    const confirm = await vscode.window.showInformationMessage(
        `Зберегти новий скіл "${name}"?\nОпис: ${description}`,
        { modal: true },
        'Так', 'Ні'
    );

    if (confirm !== 'Так') {
      return 'User rejected saving the skill.';
    }

    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), fileContent, 'utf8');

    const relativeStoredPath = path.join(folderName, 'SKILL.md').replace(/\\/g, '/');
    return `Skill "${name}" saved successfully to ${relativeStoredPath} in the knowledge base!`;
  } catch (e: any) {
    return `Failed to save skill: ${e.message}`;
  }
}