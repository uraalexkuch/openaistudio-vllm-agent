// Copyright (c) 2026 Юрій Кучеренко.
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { resolveToolPath } from "../utils/path_utils";

/**
 * Opens a file from the workspace or absolute path in the default system application.
 * For HTML files this opens the browser; for code files opens in VS Code editor.
 */
export async function launch_file(filename: string): Promise<string> {
    try {
        const filePath = resolveToolPath(filename);

        if (!fs.existsSync(filePath)) {
            return `Error: File "${filename}" not found in workspace. Make sure to write_file first.`;
        }

        const uri = vscode.Uri.file(filePath);
        const ext = path.extname(filename).toLowerCase();

        if (ext === '.html' || ext === '.htm') {
            // Open HTML in default browser
            const opened = await vscode.env.openExternal(uri);
            if (opened) {
                return `Launched "${filename}" in the default browser.`;
            } else {
                // Fallback: open in VS Code editor
                await vscode.window.showTextDocument(uri);
                return `Could not open browser. Opened "${filename}" in VS Code editor instead.`;
            }
        } else {
            // Open other files in VS Code editor
            await vscode.window.showTextDocument(uri);
            return `Opened "${filename}" in VS Code editor.`;
        }
    } catch (err: any) {
        return `Error launching file: ${err.message}`;
    }
}