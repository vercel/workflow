/**
 * ReadWriteFs - Direct wrapper around the real filesystem
 *
 * All operations go directly to the underlying Node.js filesystem.
 * This is a true read-write filesystem with no overlay or sandboxing.
 */
import { type FileContent } from "../encoding.js";
import type { CpOptions, DirentEntry, FsStat, IFileSystem, MkdirOptions, ReadFileOptions, RmOptions, WriteFileOptions } from "../interface.js";
export interface ReadWriteFsOptions {
    /**
     * The root directory on the real filesystem.
     * All paths are relative to this root.
     */
    root: string;
}
export declare class ReadWriteFs implements IFileSystem {
    private readonly root;
    constructor(options: ReadWriteFsOptions);
    /**
     * Convert a virtual path to a real filesystem path.
     */
    private toRealPath;
    /**
     * Normalize a virtual path (resolve . and .., ensure starts with /)
     */
    private normalizePath;
    readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string>;
    readFileBuffer(path: string): Promise<Uint8Array>;
    writeFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void>;
    appendFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void>;
    exists(path: string): Promise<boolean>;
    stat(path: string): Promise<FsStat>;
    lstat(path: string): Promise<FsStat>;
    mkdir(path: string, options?: MkdirOptions): Promise<void>;
    readdir(path: string): Promise<string[]>;
    readdirWithFileTypes(path: string): Promise<DirentEntry[]>;
    rm(path: string, options?: RmOptions): Promise<void>;
    cp(src: string, dest: string, options?: CpOptions): Promise<void>;
    mv(src: string, dest: string): Promise<void>;
    resolvePath(base: string, path: string): string;
    getAllPaths(): string[];
    private scanDir;
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
     * @param atime - Access time
     * @param mtime - Modification time
     */
    utimes(path: string, atime: Date, mtime: Date): Promise<void>;
}
