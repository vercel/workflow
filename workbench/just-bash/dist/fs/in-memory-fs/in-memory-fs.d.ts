import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";
import type { BufferEncoding, CpOptions, DirectoryEntry, DirentEntry, FileContent, FileEntry, FsEntry, FsStat, IFileSystem, InitialFiles, MkdirOptions, ReadFileOptions, RmOptions, SymlinkEntry, WriteFileOptions } from "../interface.js";
export type { BufferEncoding, FileContent, FileEntry, DirectoryEntry, SymlinkEntry, FsEntry, FsStat, IFileSystem, };
export interface FsData {
    [path: string]: FsEntry;
}
export declare class InMemoryFs implements IFileSystem {
    private data;
    constructor(initialFiles?: InitialFiles);
    private normalizePath;
    private dirname;
    private ensureParentDirs;
    writeFileSync(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding, metadata?: {
        mode?: number;
        mtime?: Date;
    }): void;
    readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string>;
    readFileBuffer(path: string): Promise<Uint8Array>;
    writeFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void>;
    appendFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void>;
    exists(path: string): Promise<boolean>;
    stat(path: string): Promise<FsStat>;
    lstat(path: string): Promise<FsStat>;
    private resolveSymlink;
    /**
     * Resolve symlinks in intermediate path components only (not the final component).
     * Used by lstat which should not follow the final symlink.
     */
    private resolveIntermediateSymlinks;
    /**
     * Resolve all symlinks in a path, including intermediate components.
     * For example: /home/user/linkdir/file.txt where linkdir is a symlink to "subdir"
     * would resolve to /home/user/subdir/file.txt
     */
    private resolvePathWithSymlinks;
    mkdir(path: string, options?: MkdirOptions): Promise<void>;
    /**
     * Synchronous version of mkdir
     */
    mkdirSync(path: string, options?: MkdirOptions): void;
    readdir(path: string): Promise<string[]>;
    readdirWithFileTypes(path: string): Promise<DirentEntry[]>;
    rm(path: string, options?: RmOptions): Promise<void>;
    cp(src: string, dest: string, options?: CpOptions): Promise<void>;
    mv(src: string, dest: string): Promise<void>;
    getAllPaths(): string[];
    resolvePath(base: string, path: string): string;
    chmod(path: string, mode: number): Promise<void>;
    symlink(target: string, linkPath: string): Promise<void>;
    link(existingPath: string, newPath: string): Promise<void>;
    readlink(path: string): Promise<string>;
    /**
     * Resolve all symlinks in a path to get the canonical physical path.
     * This is equivalent to POSIX realpath().
     */
    realpath(path: string): Promise<string>;
    static [WORKFLOW_SERIALIZE](instance: InMemoryFs): {
        data: Map<string, FsEntry>;
    };
    static [WORKFLOW_DESERIALIZE](serialized: {
        data: Map<string, FsEntry>;
    }): InMemoryFs;
    /**
     * Set access and modification times of a file
     * @param path - The file path
     * @param _atime - Access time (ignored, kept for API compatibility)
     * @param mtime - Modification time
     */
    utimes(path: string, _atime: Date, mtime: Date): Promise<void>;
}
