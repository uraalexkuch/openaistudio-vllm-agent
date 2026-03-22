// Copyright (c) 2026 Юрій Кучеренко.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export class WorkspaceManager {
    private workspacePath: string;

    constructor(context: vscode.ExtensionContext) {
        // Find the currently open workspace in VS Code
        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.length > 0) {
            this.workspacePath = folders[0].uri.fsPath;
        } else {
            // Use extension's global storage instead of its installation directory
            this.workspacePath = path.join(context.globalStorageUri.fsPath, 'OpenAIStudio_Generated');
            console.log(`No workspace folder open. Using global storage: ${this.workspacePath}`);
        }
    }

    /**
     * Saves generated code to the workspace.
     */
    public async writeCodeFile(fileName: string, content: string): Promise<void> {
        const filePath = path.join(this.workspacePath, fileName);
        
        // Ensure parent directories exist
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(filePath, content, 'utf8');
        console.log(`Saved file: ${filePath}`);
    }

    /**
     * Reads a file from the workspace for agent context.
     */
    public readCodeFile(fileName: string): string {
        const filePath = path.join(this.workspacePath, fileName);
        if (fs.existsSync(filePath)) {
            return fs.readFileSync(filePath, 'utf8');
        }
        throw new Error(`File ${fileName} not found.`);
    }

    public getWorkspacePath(): string {
        return this.workspacePath;
    }

    /**
     * Gather compact workspace context: project type, key files, open file, selection.
     * Replicated from OG project.
     */
    public gatherContext(): string {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) return '';

        const lines: string[] = [];

        // Project metadata
        const pkgPath = path.join(root, 'package.json');
        if (fs.existsSync(pkgPath)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                lines.push(`Project: ${pkg.name ?? 'unknown'} (${pkg.version ?? '?'})`);
                const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
                if (deps.length) lines.push(`Key deps: ${deps.slice(0, 12).join(', ')}`);
                if (pkg.scripts) {
                    const scripts = Object.keys(pkg.scripts).slice(0, 8).join(', ');
                    lines.push(`Scripts: ${scripts}`);
                }
            } catch { /* */ }
        }

        // Active file
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const rel = path.relative(root, editor.document.fileName);
            lines.push(`Active file: ${rel} (${editor.document.languageId})`);

            const sel = editor.selection;
            if (!sel.isEmpty) {
                const selText = editor.document.getText(sel);
                const preview = selText.slice(0, 400);
                lines.push(`Selected code:\n\`\`\`\n${preview}${selText.length > 400 ? '\n…' : ''}\n\`\`\``);
            }
        }

        return lines.join('\n');
    }

    /**
     * Get currently open file content (capped at 200 lines AND 20KB)
     */
    public getActiveFileContent(): string {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return '';
        const doc = editor.document;
        const content = doc.getText();
        const MAX_CONTEXT_BYTES = 20 * 1024;

        // Byte cap
        const bytes = Buffer.byteLength(content, 'utf8');
        if (bytes > MAX_CONTEXT_BYTES) {
            const truncated = content.slice(0, MAX_CONTEXT_BYTES);
            const lineCount = content.split('\n').length;
            return `\`\`\`${doc.languageId}\n${truncated}\n…[truncated — file is ${lineCount} lines / ${Math.round(bytes / 1024)}KB, showing first 20KB]\n\`\`\``;
        }

        const lines = content.split('\n');
        const capped = lines.slice(0, 200);
        const suffix = lines.length > 200 ? `\n…(${lines.length - 200} more lines)` : '';
        return `\`\`\`${doc.languageId}\n${capped.join('\n')}${suffix}\n\`\`\``;
    }

    /**
     * Повертає повний контекст відкритого проєкту у VS Code.
     */
    public gatherProjectContext(): {
        rootPath: string | null;
        projectName: string;
        stack: string;
        mainFiles: string[];
        contextText: string;
    } {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            return {
                rootPath: null,
                projectName: 'unknown',
                stack: 'unknown',
                mainFiles: [],
                contextText: '',
            };
        }

        const root = folders[0].uri.fsPath;
        const projectName = path.basename(root);

        // Визначити стек за наявними файлами
        const stackIndicators: Array<[string, string]> = [
            ['package.json',     'node/js'],
            ['angular.json',     'angular'],
            ['nest-cli.json',    'nestjs'],
            ['next.config.js',   'nextjs'],
            ['next.config.ts',   'nextjs'],
            ['nuxt.config.ts',   'nuxt'],
            ['vite.config.ts',   'vite/react/vue'],
            ['svelte.config.js', 'svelte'],
            ['requirements.txt', 'python'],
            ['Cargo.toml',       'rust'],
            ['go.mod',           'golang'],
            ['pom.xml',          'java/spring'],
            ['composer.json',    'php'],
            ['pubspec.yaml',     'flutter'],
            ['Dockerfile',       'docker'],
            ['turbo.json',       'monorepo'],
        ];

        let stack = 'unknown';
        const foundFiles: string[] = [];

        for (const [file, detectedStack] of stackIndicators) {
            const fullPath = path.join(root, file);
            if (fs.existsSync(fullPath)) {
                if (stack === 'unknown') stack = detectedStack;
                foundFiles.push(file);
            }
        }

        // Зібрати список ключових файлів (max 20)
        const mainFiles: string[] = [];
        const scanDirs = ['src', 'app', 'lib', 'pages', '.'];
        for (const dir of scanDirs) {
            const dirPath = path.join(root, dir);
            if (!fs.existsSync(dirPath)) continue;
            try {
                const entries = fs.readdirSync(dirPath, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isFile() && mainFiles.length < 20) {
                        mainFiles.push(dir === '.' ? entry.name : `${dir}/${entry.name}`);
                    }
                }
            } catch { /* skip */ }
            if (mainFiles.length >= 20) break;
        }

        const contextText = [
            `PROJECT: ${projectName}`,
            `PATH: ${root}`,
            `STACK: ${stack}`,
            `CONFIG FILES: ${foundFiles.join(', ') || 'none found'}`,
            `MAIN FILES: ${mainFiles.slice(0, 10).join(', ')}`,
        ].join('\n');

        return { rootPath: root, projectName, stack, mainFiles, contextText };
    }
}
