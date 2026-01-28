import type { BufferEncoding, CpOptions, FileContent, FsStat, IFileSystem, MkdirOptions, ReadFileOptions, RmOptions, WriteFileOptions } from "../interface.js";
/**
 * Configuration for a mount point
 */
export interface MountConfig {
    /** Virtual path where the filesystem is mounted */
    mountPoint: string;
    /** The filesystem to mount at this path */
    filesystem: IFileSystem;
}
/**
 * Options for creating a MountableFs
 */
export interface MountableFsOptions {
    /** Base filesystem used for unmounted paths (defaults to InMemoryFs) */
    base?: IFileSystem;
    /** Initial mounts to configure */
    mounts?: MountConfig[];
}
/**
 * A filesystem that supports mounting other filesystems at specific paths.
 *
 * This allows combining multiple filesystem backends into a unified namespace.
 * For example, mounting a read-only knowledge base at /mnt/knowledge and a
 * read-write workspace at /home/agent.
 *
 * @example
 * ```typescript
 * const fs = new MountableFs({ base: new InMemoryFs() });
 * fs.mount('/mnt/knowledge', new OverlayFs({ root: "/path/to/knowledge", readOnly: true }));
 * fs.mount('/home/agent', new ReadWriteFs({ root: "/path/to/workspace" }));
 * ```
 */
export declare class MountableFs implements IFileSystem {
    private baseFs;
    private mounts;
    constructor(options?: MountableFsOptions);
    /**
     * Mount a filesystem at the specified virtual path.
     *
     * @param mountPoint - The virtual path where the filesystem will be accessible
     * @param filesystem - The filesystem to mount
     * @throws Error if mounting at root '/' or inside an existing mount
     */
    mount(mountPoint: string, filesystem: IFileSystem): void;
    /**
     * Unmount the filesystem at the specified path.
     *
     * @param mountPoint - The virtual path to unmount
     * @throws Error if no filesystem is mounted at this path
     */
    unmount(mountPoint: string): void;
    /**
     * Get all current mounts.
     */
    getMounts(): ReadonlyArray<{
        mountPoint: string;
        filesystem: IFileSystem;
    }>;
    /**
     * Check if a path is exactly a mount point.
     */
    isMountPoint(path: string): boolean;
    /**
     * Validate mount path format before normalization.
     * Rejects paths containing . or .. segments.
     */
    private validateMountPath;
    /**
     * Validate that a mount point is allowed.
     */
    private validateMount;
    /**
     * Normalize a path to a consistent format.
     */
    private normalizePath;
    /**
     * Route a path to the appropriate filesystem.
     * Returns the filesystem and the relative path within that filesystem.
     */
    private routePath;
    /**
     * Get mount points that are immediate children of a directory.
     */
    private getChildMountPoints;
    readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string>;
    readFileBuffer(path: string): Promise<Uint8Array>;
    writeFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void>;
    appendFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void>;
    exists(path: string): Promise<boolean>;
    stat(path: string): Promise<FsStat>;
    lstat(path: string): Promise<FsStat>;
    mkdir(path: string, options?: MkdirOptions): Promise<void>;
    readdir(path: string): Promise<string[]>;
    rm(path: string, options?: RmOptions): Promise<void>;
    cp(src: string, dest: string, options?: CpOptions): Promise<void>;
    mv(src: string, dest: string): Promise<void>;
    resolvePath(base: string, path: string): string;
    getAllPaths(): string[];
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
     * Perform a cross-mount copy operation.
     */
    private crossMountCopy;
    /**
     * Set access and modification times of a file
     * @param path - The file path
     * @param atime - Access time
     * @param mtime - Modification time
     */
    utimes(path: string, atime: Date, mtime: Date): Promise<void>;
}
