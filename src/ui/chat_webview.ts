import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export class ChatWebview {
    public static currentPanel: ChatWebview | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private readonly _extensionUri: vscode.Uri;

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.html = this._getHtmlForWebview();

        this._panel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case 'run_task':
                    if (msg.text) {
                        // Forward to extension via command
                        vscode.commands.executeCommand('openaistudio.startTaskFromWebview', msg.text);
                    }
                    break;
                case 'ready':
                    this.broadcastModels();
                    break;
                case 'clear':
                    // handled by JS in webview
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
        this._panel.webview.postMessage({ type: 'agent_event', event });
    }

    public broadcastModels() {
        const config = vscode.workspace.getConfiguration('openaistudio');
        const current = config.get<string>('model', 'gemma');
        this._panel.webview.postMessage({ 
            type: 'models_list', 
            models: [current, 'qwen', 'codestral', 'qwen-code'], // hardcoded for now
            current 
        });
    }

    public notifyStart() {
        this._panel.webview.postMessage({ type: 'task_start' });
    }

    private _getHtmlForWebview() {
        const htmlPath = path.join(this._extensionUri.fsPath, 'resources', 'chat.html');
        try {
            return fs.readFileSync(htmlPath, 'utf8');
        } catch (e) {
            return `Error loading chat.html: ${e}`;
        }
    }

    public dispose() {
        ChatWebview.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }
}
