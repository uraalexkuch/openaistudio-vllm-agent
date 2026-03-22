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

        // Blocklist системних шляхів — безпечніше ніж allowlist
        const SYSTEM_PATHS = process.platform === 'win32'
            ? ['C:\\Windows', 'C:\\Program Files', 'C:\\System32', 'C:\\ProgramData', 'C:\\Recovery']
            : ['/sys', '/proc', '/dev', '/boot', '/etc/passwd', '/etc/shadow', '/etc/sudoers'];

        const isSystem = SYSTEM_PATHS.some(sp => 
            filename.toLowerCase().startsWith(sp.toLowerCase())
        );
        if (isSystem) {
            throw new Error(`Write to system path blocked: ${filename}`);
        }
        return filename;
    }
    const root = getWorkspaceRoot();
    const normalised = filename.replace(/\\/g, '/').replace(/^\/+/, '');
    return path.resolve(root, normalised);
}
