// Copyright (c) 2026 Юрій Кучеренко.
import * as path from 'path';
import * as os from 'os';

/**
 * Gets the absolute path to the standard workspace directory.
 */
export function getWorkspaceRoot(): string {
    // Standard workspace is at project_root/workspace
    return path.resolve(path.join(__dirname, '..', 'workspace'));
}

/**
 * Resolves a user-supplied filename to an absolute path.
 * If the filename is already absolute (e.g., C:\path\to\file or /path/to/file), it returns it as is.
 * Otherwise, it resolves it relative to the workspace directory.
 * NOTE: Absolute paths are allowed to enable full disk interaction as requested by the user.
 */
export function resolveToolPath(filename: string, readOnly = false): string {
    if (!filename) return getWorkspaceRoot();
    if (path.isAbsolute(filename)) {
        if (readOnly) return filename; // читання — без обмежень
        const root = getWorkspaceRoot();
        const home = os.homedir();
        // Дозволені префікси для запису
        const WRITE_ALLOWED = [
            home,
            root,
            // Linux серверні шляхи
            '/var/www',
            '/opt',
            '/srv',
            '/home',
        ];

        const isAllowed = WRITE_ALLOWED.some(p => filename.startsWith(p));
        if (!isAllowed) {
            throw new Error(`Write outside allowed paths blocked: ${filename}`);
        }
        return filename;
    }
    const root = getWorkspaceRoot();
    const normalised = filename.replace(/\\/g, '/').replace(/^\/+/, '');
    return path.resolve(root, normalised);
}
