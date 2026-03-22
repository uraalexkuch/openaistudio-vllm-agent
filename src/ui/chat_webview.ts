// Copyright (c) 2026 Юрій Кучеренко.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export class ChatWebview {
    public static currentPanel: ChatWebview | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private readonly _extensionUri: vscode.Uri;

    // Track the last HTML file written by an agent so the "Open in Browser" button works
    public static lastWrittenFile: string | undefined;
    public static lastProjectFolder: string | undefined;

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.html = this._getHtmlForWebview();

        this._panel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case 'set_lang':
                    if (msg.lang) {
                        const cfg = vscode.workspace.getConfiguration('openaistudio');
                        await cfg.update('uiLanguage', msg.lang, vscode.ConfigurationTarget.Global);
                    }
                    break;

                case 'run_task':
                    if (msg.text) {
                        vscode.commands.executeCommand('openaistudio.startTaskFromWebview', msg.text);
                    }
                    break;

                case 'open_in_browser':
                    // User clicked "Open in Browser" button in the webview
                    if (ChatWebview.lastWrittenFile) {
                        vscode.commands.executeCommand('openaistudio.openFileInBrowser', ChatWebview.lastWrittenFile);
                    } else {
                        vscode.window.showWarningMessage('No file has been generated yet.');
                    }
                    break;

                case 'open_workspace':
                    // Open the workspace folder in VS Code explorer
                    vscode.commands.executeCommand('openaistudio.openWorkspace');
                    break;

                case 'ready':
                    this.broadcastModels();
                    break;

                case 'clear':
                    break;
            }
        }, null, this._disposables);
    }

    public static createOrShow(extensionUri: vscode.Uri) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (ChatWebview.currentPanel) {
            ChatWebview.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'openaistudioChat',
            'OpenAIStudio Workspace',
            column || vscode.ViewColumn.Two,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        ChatWebview.currentPanel = new ChatWebview(panel, extensionUri);
    }

    public broadcastEvent(event: any) {
        const content = event.content || '';

        // Відстежити папку проєкту з нарації
        const folderMatch = content.match(/Папка проєкту: workspace\/([^\s\n]+)/);
        if (folderMatch) {
            ChatWebview.lastProjectFolder = folderMatch[1];
        }

        // Track last written file for the "Open in Browser" button
        if (event.type === 'tool_result' || event.type === 'narration') {
            const match = content.match(/File "([^"]+\.html?)" saved successfully/i);
            if (match) {
                ChatWebview.lastWrittenFile = match[1];
                // Notify webview that a file is ready to open
                this._panel.webview.postMessage({
                    type: 'file_ready',
                    filename: ChatWebview.lastWrittenFile,
                    // Показати відносний шлях у кнопці (basename)
                    displayName: match[1].replace(/.*\//, '')
                });
            }
        }
        this._panel.webview.postMessage({ type: 'agent_event', event });
    }

    public broadcastModels() {
        const config  = vscode.workspace.getConfiguration('openaistudio');
        const current = config.get<string>('modelGeneral', 'gemma');
        const currentLang = config.get<string>('uiLanguage', '') || 
            vscode.env.language.split('-')[0].toLowerCase();

        this._panel.webview.postMessage({
            type: 'models_list',
            models: [current, 'qwen3-coder', 'codestral', 'gemma'],
            current,
            currentLang
        });
    }

    public notifyStart() {
        ChatWebview.lastWrittenFile  = undefined; // reset on new task
        ChatWebview.lastProjectFolder = undefined;
        this._panel.webview.postMessage({ type: 'task_start' });
    }

    private _getHtmlForWebview() {
        const htmlPath = path.join(this._extensionUri.fsPath, 'resources', 'chat.html');
        try {
            let html = fs.readFileSync(htmlPath, 'utf8');
            // Inject the "Open in Browser" button script if not already present
            if (!html.includes('file_ready')) {
                html = html.replace('</body>', `
<script>
// Handle file_ready event — show "Open in Browser" button
window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'file_ready' && msg.filename) {
        let btn = document.getElementById('openBrowserBtn');
        if (!btn) {
            btn = document.createElement('button');
            btn.id = 'openBrowserBtn';
            btn.style.cssText = 'position:fixed;bottom:70px;right:16px;padding:8px 16px;' +
                'background:#007acc;color:#fff;border:none;border-radius:4px;cursor:pointer;' +
                'font-size:13px;z-index:999;box-shadow:0 2px 8px rgba(0,0,0,0.3)';
            btn.onclick = () => vscode.postMessage({ type: 'open_in_browser' });
            document.body.appendChild(btn);
        }
        btn.textContent = '🌐 Open ' + (msg.displayName || msg.filename) + ' in Browser';
        btn.style.display = 'block';
    }
    if (msg.type === 'task_start') {
        const btn = document.getElementById('openBrowserBtn');
        if (btn) btn.style.display = 'none';
    }
});
</script>
</body>`);
            }
            return html;
        } catch (e) {
            return `<html><body>Error loading chat.html: ${e}</body></html>`;
        }
    }

    public dispose() {
        ChatWebview.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) x.dispose();
        }
    }
}