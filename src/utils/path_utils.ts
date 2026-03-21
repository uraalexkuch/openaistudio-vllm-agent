import * as path from 'path';

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
export function resolveToolPath(filename: string): string {
    if (!filename) return getWorkspaceRoot();
    
    // Check if it's already an absolute path
    if (path.isAbsolute(filename)) {
        return filename;
    }
    
    const root = getWorkspaceRoot();
    // Normalise separators and resolve relative to workspace root
    const normalised = filename.replace(/\\/g, '/').replace(/^\/+/, '');
    return path.resolve(root, normalised);
}
