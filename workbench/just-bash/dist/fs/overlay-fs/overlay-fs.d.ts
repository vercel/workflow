/**
 * OverlayFs - Copy-on-write filesystem backed by a real directory
 *
 * Reads come from the real filesystem, writes go to an in-memory layer.
 * Changes don't persist to disk and can't escape the root directory.
 */
import { type FileContent } from "../encoding.js";
import type { CpOptions, DirentEntry, FsStat, IFileSystem, MkdirOptions, ReadFileOptions, RmOptions, WriteFileOptions } from "../interface.js";
export interface OverlayFsOptions {
    /**
     * The root directory on the real filesystem.
     * All paths are relative to this root and cannot escape it.
     */
    root: string;
    /**
     * The virtual mount point where the root directory appears.
     * Defaults to "/home/user/project".
     */
    mountPoint?: string;
    /**
     * If true, all write operations will throw an error.
     * Useful for truly read-only access to the filesystem.
     * Defaults to false.
     */
    readOnly?: boolean;
}
export declare class OverlayFs implements IFileSystem {
    private readonly root;
    private readonly mountPoint;
    private readonly readOnly;
    private readonly memory;
    private readonly deleted;
    constructor(options: OverlayFsOptions);
    /**
     * Throws an error if the filesystem is in read-only mode.
     */
    private assertWritable;
    /**
     * Create directory entries for the mount point path
     */
    private createMountPointDirs;
    /**
     * Get the mount point for this overlay
     */
    getMountPoint(): string;
    /**
     * Create a virtual directory in memory (sync, for initialization)
     */
    mkdirSync(path: string, _options?: MkdirOptions): void;
    /**
     * Create a virtual file in memory (sync, for initialization)
     */
    writeFileSync(path: string, content: string | Uint8Array): void;
    private getDirname;
    /**
     * Normalize a virtual path (resolve . and .., ensure starts with /)
     */
    private normalizePath;
    /**
     * Check if a normalized virtual path is under the mount point.
     * Returns the relative path within the mount point, or null if not under it.
     */
    private getRelativeToMount;
    /**
     * Convert a virtual path to a real filesystem path.
     * Returns null if the path is not under the mount point or would escape the root.
     */
    private toRealPath;
    private dirname;
    private ensureParentDirs;
    /**
     * Check if a path exists in the overlay (memory + real fs - deleted)
     */
    private existsInOverlay;
    readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string>;
    readFileBuffer(path: string, seen?: Set<string>): Promise<Uint8Array>;
    writeFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void>;
    appendFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void>;
    exists(path: string): Promise<boolean>;
    stat(path: string, seen?: Set<string>): Promise<FsStat>;
    lstat(path: string): Promise<FsStat>;
    private resolveSymlink;
    mkdir(path: string, options?: MkdirOptions): Promise<void>;
    /**
     * Core readdir implementation that returns entries with file types.
     * Both readdir and readdirWithFileTypes use this shared implementation.
     */
    private readdirCore;
    /**
     * Follow symlinks to resolve the final directory path.
     * Returns outsideOverlay: true if the symlink points outside the overlay or
     * the resolved target doesn't exist (security - broken symlinks return []).
     */
    private resolveForReaddir;
    readdir(path: string): Promise<string[]>;
    readdirWithFileTypes(path: string): Promise<DirentEntry[]>;
    rm(path: string, options?: RmOptions): Promise<void>;
    cp(src: string, dest: string, options?: CpOptions): Promise<void>;
    mv(src: string, dest: string): Promise<void>;
    resolvePath(base: string, path: string): string;
    getAllPaths(): string[];
    private scanRealFs;
    chmod(path: string, mode: number): Promise<void>;
    symlink(target: string, linkPath: string): Promise<void>;
    link(existingPath: string, newPath: string): Promise<void>;
    readlink(path: string): Promise<string>;
    /**
     * Resolve all symlinks in a path to get the canonical physical path.
     * This is equivalent to POSIX realpath().
     */
    realpath(path: string): Promise<string>;
    /**
     * Set access and modification times of a file
     * @param path - The file path
     * @param _atime - Access time (ignored, kept for API compatibility)
     * @param mtime - Modification time
     */
    utimes(path: string, _atime: Date, mtime: Date): Promise<void>;
}
