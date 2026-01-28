/**
 * OverlayFs - Copy-on-write filesystem backed by a real directory
 *
 * Reads come from the real filesystem, writes go to an in-memory layer.
 * Changes don't persist to disk and can't escape the root directory.
 */
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { fromBuffer, getEncoding, toBuffer, } from "../encoding.js";
/** Default mount point for OverlayFs */
const DEFAULT_MOUNT_POINT = "/home/user/project";
export class OverlayFs {
    root;
    mountPoint;
    readOnly;
    memory = new Map();
    deleted = new Set();
    constructor(options) {
        // Resolve to absolute path
        this.root = nodePath.resolve(options.root);
        // Normalize mount point (ensure it starts with / and has no trailing /)
        const mp = options.mountPoint ?? DEFAULT_MOUNT_POINT;
        this.mountPoint = mp === "/" ? "/" : mp.replace(/\/+$/, "");
        if (!this.mountPoint.startsWith("/")) {
            throw new Error(`Mount point must be an absolute path: ${mp}`);
        }
        // Set read-only mode
        this.readOnly = options.readOnly ?? false;
        // Verify root exists and is a directory
        if (!fs.existsSync(this.root)) {
            throw new Error(`OverlayFs root does not exist: ${this.root}`);
        }
        const stat = fs.statSync(this.root);
        if (!stat.isDirectory()) {
            throw new Error(`OverlayFs root is not a directory: ${this.root}`);
        }
        // Create mount point directory structure in memory layer
        this.createMountPointDirs();
    }
    /**
     * Throws an error if the filesystem is in read-only mode.
     */
    assertWritable(operation) {
        if (this.readOnly) {
            throw new Error(`EROFS: read-only file system, ${operation}`);
        }
    }
    /**
     * Create directory entries for the mount point path
     */
    createMountPointDirs() {
        const parts = this.mountPoint.split("/").filter(Boolean);
        let current = "";
        for (const part of parts) {
            current += `/${part}`;
            if (!this.memory.has(current)) {
                this.memory.set(current, {
                    type: "directory",
                    mode: 0o755,
                    mtime: new Date(),
                });
            }
        }
        // Also ensure root exists
        if (!this.memory.has("/")) {
            this.memory.set("/", {
                type: "directory",
                mode: 0o755,
                mtime: new Date(),
            });
        }
    }
    /**
     * Get the mount point for this overlay
     */
    getMountPoint() {
        return this.mountPoint;
    }
    /**
     * Create a virtual directory in memory (sync, for initialization)
     */
    mkdirSync(path, _options) {
        const normalized = this.normalizePath(path);
        const parts = normalized.split("/").filter(Boolean);
        let current = "";
        for (const part of parts) {
            current += `/${part}`;
            if (!this.memory.has(current)) {
                this.memory.set(current, {
                    type: "directory",
                    mode: 0o755,
                    mtime: new Date(),
                });
            }
        }
    }
    /**
     * Create a virtual file in memory (sync, for initialization)
     */
    writeFileSync(path, content) {
        const normalized = this.normalizePath(path);
        // Ensure parent directories exist
        const parent = this.getDirname(normalized);
        if (parent !== "/") {
            this.mkdirSync(parent);
        }
        const buffer = content instanceof Uint8Array
            ? content
            : new TextEncoder().encode(content);
        this.memory.set(normalized, {
            type: "file",
            content: buffer,
            mode: 0o644,
            mtime: new Date(),
        });
    }
    getDirname(path) {
        const lastSlash = path.lastIndexOf("/");
        return lastSlash === 0 ? "/" : path.slice(0, lastSlash);
    }
    /**
     * Normalize a virtual path (resolve . and .., ensure starts with /)
     */
    normalizePath(path) {
        if (!path || path === "/")
            return "/";
        let normalized = path.endsWith("/") && path !== "/" ? path.slice(0, -1) : path;
        if (!normalized.startsWith("/")) {
            normalized = `/${normalized}`;
        }
        const parts = normalized.split("/").filter((p) => p && p !== ".");
        const resolved = [];
        for (const part of parts) {
            if (part === "..") {
                resolved.pop();
            }
            else {
                resolved.push(part);
            }
        }
        return `/${resolved.join("/")}` || "/";
    }
    /**
     * Check if a normalized virtual path is under the mount point.
     * Returns the relative path within the mount point, or null if not under it.
     */
    getRelativeToMount(normalizedPath) {
        if (this.mountPoint === "/") {
            // Mount at root - all paths are relative to mount
            return normalizedPath;
        }
        if (normalizedPath === this.mountPoint) {
            return "/";
        }
        if (normalizedPath.startsWith(`${this.mountPoint}/`)) {
            return normalizedPath.slice(this.mountPoint.length);
        }
        return null;
    }
    /**
     * Convert a virtual path to a real filesystem path.
     * Returns null if the path is not under the mount point or would escape the root.
     */
    toRealPath(virtualPath) {
        const normalized = this.normalizePath(virtualPath);
        // Check if path is under the mount point
        const relativePath = this.getRelativeToMount(normalized);
        if (relativePath === null) {
            return null;
        }
        const realPath = nodePath.join(this.root, relativePath);
        // Security check: ensure path doesn't escape root
        const resolvedReal = nodePath.resolve(realPath);
        if (!resolvedReal.startsWith(this.root) &&
            resolvedReal !== this.root.replace(/\/$/, "")) {
            return null;
        }
        return resolvedReal;
    }
    dirname(path) {
        const normalized = this.normalizePath(path);
        if (normalized === "/")
            return "/";
        const lastSlash = normalized.lastIndexOf("/");
        return lastSlash === 0 ? "/" : normalized.slice(0, lastSlash);
    }
    ensureParentDirs(path) {
        const dir = this.dirname(path);
        if (dir === "/")
            return;
        if (!this.memory.has(dir)) {
            this.ensureParentDirs(dir);
            this.memory.set(dir, {
                type: "directory",
                mode: 0o755,
                mtime: new Date(),
            });
        }
        // Remove from deleted set if it was there
        this.deleted.delete(dir);
    }
    /**
     * Check if a path exists in the overlay (memory + real fs - deleted)
     */
    async existsInOverlay(virtualPath) {
        const normalized = this.normalizePath(virtualPath);
        // Deleted in memory layer?
        if (this.deleted.has(normalized)) {
            return false;
        }
        // Exists in memory layer?
        if (this.memory.has(normalized)) {
            return true;
        }
        // Check real filesystem
        const realPath = this.toRealPath(normalized);
        if (!realPath) {
            return false;
        }
        try {
            await fs.promises.access(realPath);
            return true;
        }
        catch {
            return false;
        }
    }
    async readFile(path, options) {
        const buffer = await this.readFileBuffer(path);
        const encoding = getEncoding(options);
        return fromBuffer(buffer, encoding);
    }
    async readFileBuffer(path, seen = new Set()) {
        const normalized = this.normalizePath(path);
        // Detect symlink loops
        if (seen.has(normalized)) {
            throw new Error(`ELOOP: too many levels of symbolic links, open '${path}'`);
        }
        seen.add(normalized);
        // Check if deleted
        if (this.deleted.has(normalized)) {
            throw new Error(`ENOENT: no such file or directory, open '${path}'`);
        }
        // Check memory layer first
        const memEntry = this.memory.get(normalized);
        if (memEntry) {
            if (memEntry.type === "symlink") {
                const target = this.resolveSymlink(normalized, memEntry.target);
                return this.readFileBuffer(target, seen);
            }
            if (memEntry.type !== "file") {
                throw new Error(`EISDIR: illegal operation on a directory, read '${path}'`);
            }
            return memEntry.content;
        }
        // Fall back to real filesystem
        const realPath = this.toRealPath(normalized);
        if (!realPath) {
            throw new Error(`ENOENT: no such file or directory, open '${path}'`);
        }
        try {
            const stat = await fs.promises.lstat(realPath);
            if (stat.isSymbolicLink()) {
                const target = await fs.promises.readlink(realPath);
                const resolvedTarget = this.resolveSymlink(normalized, target);
                return this.readFileBuffer(resolvedTarget, seen);
            }
            if (stat.isDirectory()) {
                throw new Error(`EISDIR: illegal operation on a directory, read '${path}'`);
            }
            const content = await fs.promises.readFile(realPath);
            return new Uint8Array(content);
        }
        catch (e) {
            if (e.code === "ENOENT") {
                throw new Error(`ENOENT: no such file or directory, open '${path}'`);
            }
            throw e;
        }
    }
    async writeFile(path, content, options) {
        this.assertWritable(`write '${path}'`);
        const normalized = this.normalizePath(path);
        this.ensureParentDirs(normalized);
        const encoding = getEncoding(options);
        const buffer = toBuffer(content, encoding);
        this.memory.set(normalized, {
            type: "file",
            content: buffer,
            mode: 0o644,
            mtime: new Date(),
        });
        this.deleted.delete(normalized);
    }
    async appendFile(path, content, options) {
        this.assertWritable(`append '${path}'`);
        const normalized = this.normalizePath(path);
        const encoding = getEncoding(options);
        const newBuffer = toBuffer(content, encoding);
        // Try to read existing content
        let existingBuffer;
        try {
            existingBuffer = await this.readFileBuffer(normalized);
        }
        catch {
            existingBuffer = new Uint8Array(0);
        }
        const combined = new Uint8Array(existingBuffer.length + newBuffer.length);
        combined.set(existingBuffer);
        combined.set(newBuffer, existingBuffer.length);
        this.ensureParentDirs(normalized);
        this.memory.set(normalized, {
            type: "file",
            content: combined,
            mode: 0o644,
            mtime: new Date(),
        });
        this.deleted.delete(normalized);
    }
    async exists(path) {
        return this.existsInOverlay(path);
    }
    async stat(path, seen = new Set()) {
        const normalized = this.normalizePath(path);
        // Detect symlink loops
        if (seen.has(normalized)) {
            throw new Error(`ELOOP: too many levels of symbolic links, stat '${path}'`);
        }
        seen.add(normalized);
        if (this.deleted.has(normalized)) {
            throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
        }
        // Check memory layer first
        const entry = this.memory.get(normalized);
        if (entry) {
            // Follow symlinks
            if (entry.type === "symlink") {
                const target = this.resolveSymlink(normalized, entry.target);
                return this.stat(target, seen);
            }
            let size = 0;
            if (entry.type === "file") {
                size = entry.content.length;
            }
            return {
                isFile: entry.type === "file",
                isDirectory: entry.type === "directory",
                isSymbolicLink: false,
                mode: entry.mode,
                size,
                mtime: entry.mtime,
            };
        }
        // Fall back to real filesystem
        const realPath = this.toRealPath(normalized);
        if (!realPath) {
            throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
        }
        try {
            const stat = await fs.promises.stat(realPath);
            return {
                isFile: stat.isFile(),
                isDirectory: stat.isDirectory(),
                isSymbolicLink: false,
                mode: stat.mode,
                size: stat.size,
                mtime: stat.mtime,
            };
        }
        catch (e) {
            if (e.code === "ENOENT") {
                throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
            }
            throw e;
        }
    }
    async lstat(path) {
        const normalized = this.normalizePath(path);
        if (this.deleted.has(normalized)) {
            throw new Error(`ENOENT: no such file or directory, lstat '${path}'`);
        }
        // Check memory layer first
        const entry = this.memory.get(normalized);
        if (entry) {
            if (entry.type === "symlink") {
                return {
                    isFile: false,
                    isDirectory: false,
                    isSymbolicLink: true,
                    mode: entry.mode,
                    size: entry.target.length,
                    mtime: entry.mtime,
                };
            }
            let size = 0;
            if (entry.type === "file") {
                size = entry.content.length;
            }
            return {
                isFile: entry.type === "file",
                isDirectory: entry.type === "directory",
                isSymbolicLink: false,
                mode: entry.mode,
                size,
                mtime: entry.mtime,
            };
        }
        // Fall back to real filesystem
        const realPath = this.toRealPath(normalized);
        if (!realPath) {
            throw new Error(`ENOENT: no such file or directory, lstat '${path}'`);
        }
        try {
            const stat = await fs.promises.lstat(realPath);
            return {
                isFile: stat.isFile(),
                isDirectory: stat.isDirectory(),
                isSymbolicLink: stat.isSymbolicLink(),
                mode: stat.mode,
                size: stat.size,
                mtime: stat.mtime,
            };
        }
        catch (e) {
            if (e.code === "ENOENT") {
                throw new Error(`ENOENT: no such file or directory, lstat '${path}'`);
            }
            throw e;
        }
    }
    resolveSymlink(symlinkPath, target) {
        if (target.startsWith("/")) {
            return this.normalizePath(target);
        }
        const dir = this.dirname(symlinkPath);
        return this.normalizePath(dir === "/" ? `/${target}` : `${dir}/${target}`);
    }
    async mkdir(path, options) {
        this.assertWritable(`mkdir '${path}'`);
        const normalized = this.normalizePath(path);
        // Check if it exists (in memory or real fs)
        const exists = await this.existsInOverlay(normalized);
        if (exists) {
            if (!options?.recursive) {
                throw new Error(`EEXIST: file already exists, mkdir '${path}'`);
            }
            return;
        }
        // Check parent exists
        const parent = this.dirname(normalized);
        if (parent !== "/") {
            const parentExists = await this.existsInOverlay(parent);
            if (!parentExists) {
                if (options?.recursive) {
                    await this.mkdir(parent, { recursive: true });
                }
                else {
                    throw new Error(`ENOENT: no such file or directory, mkdir '${path}'`);
                }
            }
        }
        this.memory.set(normalized, {
            type: "directory",
            mode: 0o755,
            mtime: new Date(),
        });
        this.deleted.delete(normalized);
    }
    /**
     * Core readdir implementation that returns entries with file types.
     * Both readdir and readdirWithFileTypes use this shared implementation.
     */
    async readdirCore(path, normalized) {
        if (this.deleted.has(normalized)) {
            throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
        }
        const entriesMap = new Map();
        const deletedChildren = new Set();
        // Collect deleted entries that are direct children of this path
        const prefix = normalized === "/" ? "/" : `${normalized}/`;
        for (const deletedPath of this.deleted) {
            if (deletedPath.startsWith(prefix)) {
                const rest = deletedPath.slice(prefix.length);
                const name = rest.split("/")[0];
                if (name && !rest.includes("/", name.length)) {
                    deletedChildren.add(name);
                }
            }
        }
        // Add entries from memory layer (with type info)
        for (const [memPath, entry] of this.memory) {
            if (memPath === normalized)
                continue;
            if (memPath.startsWith(prefix)) {
                const rest = memPath.slice(prefix.length);
                const name = rest.split("/")[0];
                if (name && !deletedChildren.has(name) && !rest.includes("/", 1)) {
                    // Direct child
                    entriesMap.set(name, {
                        name,
                        isFile: entry.type === "file",
                        isDirectory: entry.type === "directory",
                        isSymbolicLink: entry.type === "symlink",
                    });
                }
            }
        }
        // Add entries from real filesystem with file types
        const realPath = this.toRealPath(normalized);
        if (realPath) {
            try {
                const realEntries = await fs.promises.readdir(realPath, {
                    withFileTypes: true,
                });
                for (const dirent of realEntries) {
                    if (!deletedChildren.has(dirent.name) &&
                        !entriesMap.has(dirent.name)) {
                        entriesMap.set(dirent.name, {
                            name: dirent.name,
                            isFile: dirent.isFile(),
                            isDirectory: dirent.isDirectory(),
                            isSymbolicLink: dirent.isSymbolicLink(),
                        });
                    }
                }
            }
            catch (e) {
                // If it's ENOENT and we don't have it in memory, throw
                if (e.code === "ENOENT") {
                    if (!this.memory.has(normalized)) {
                        throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
                    }
                }
                else if (e.code !== "ENOTDIR") {
                    throw e;
                }
            }
        }
        return entriesMap;
    }
    /**
     * Follow symlinks to resolve the final directory path.
     * Returns outsideOverlay: true if the symlink points outside the overlay or
     * the resolved target doesn't exist (security - broken symlinks return []).
     */
    async resolveForReaddir(path, followedSymlink = false) {
        let normalized = this.normalizePath(path);
        const seen = new Set();
        let didFollowSymlink = followedSymlink;
        // Check memory layer first
        let entry = this.memory.get(normalized);
        while (entry && entry.type === "symlink") {
            if (seen.has(normalized)) {
                throw new Error(`ELOOP: too many levels of symbolic links, scandir '${path}'`);
            }
            seen.add(normalized);
            didFollowSymlink = true;
            normalized = this.resolveSymlink(normalized, entry.target);
            entry = this.memory.get(normalized);
        }
        // If in memory and not a symlink, we're done
        if (entry) {
            return { normalized, outsideOverlay: false };
        }
        // Check if the resolved path is within the overlay's mount point
        const relativePath = this.getRelativeToMount(normalized);
        if (relativePath === null) {
            // Path is outside the overlay - return indicator for secure handling
            return { normalized, outsideOverlay: true };
        }
        // Check real filesystem
        const realPath = this.toRealPath(normalized);
        if (!realPath) {
            // Path doesn't map to real filesystem (security check failed)
            return { normalized, outsideOverlay: true };
        }
        try {
            const stat = await fs.promises.lstat(realPath);
            if (stat.isSymbolicLink()) {
                const target = await fs.promises.readlink(realPath);
                const resolvedTarget = this.resolveSymlink(normalized, target);
                return this.resolveForReaddir(resolvedTarget, true);
            }
            // Path exists on real filesystem
            return { normalized, outsideOverlay: false };
        }
        catch {
            // Path doesn't exist on real fs
            if (didFollowSymlink) {
                // Followed a symlink but target doesn't exist - broken symlink, return []
                return { normalized, outsideOverlay: true };
            }
            // No symlink was followed, let readdirCore handle the ENOENT
            return { normalized, outsideOverlay: false };
        }
    }
    async readdir(path) {
        const { normalized, outsideOverlay } = await this.resolveForReaddir(path);
        if (outsideOverlay) {
            // Security: symlink points outside overlay, return empty
            return [];
        }
        const entriesMap = await this.readdirCore(path, normalized);
        // Sort using case-sensitive comparison to match native behavior
        return Array.from(entriesMap.keys()).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    }
    async readdirWithFileTypes(path) {
        const { normalized, outsideOverlay } = await this.resolveForReaddir(path);
        if (outsideOverlay) {
            // Security: symlink points outside overlay, return empty
            return [];
        }
        const entriesMap = await this.readdirCore(path, normalized);
        // Sort using case-sensitive comparison to match native behavior
        return Array.from(entriesMap.values()).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    }
    async rm(path, options) {
        this.assertWritable(`rm '${path}'`);
        const normalized = this.normalizePath(path);
        const exists = await this.existsInOverlay(normalized);
        if (!exists) {
            if (options?.force)
                return;
            throw new Error(`ENOENT: no such file or directory, rm '${path}'`);
        }
        // Check if it's a directory
        try {
            const stat = await this.stat(normalized);
            if (stat.isDirectory) {
                const children = await this.readdir(normalized);
                if (children.length > 0) {
                    if (!options?.recursive) {
                        throw new Error(`ENOTEMPTY: directory not empty, rm '${path}'`);
                    }
                    for (const child of children) {
                        const childPath = normalized === "/" ? `/${child}` : `${normalized}/${child}`;
                        await this.rm(childPath, options);
                    }
                }
            }
        }
        catch {
            // If stat fails, we'll just mark it as deleted
        }
        // Mark as deleted and remove from memory
        this.deleted.add(normalized);
        this.memory.delete(normalized);
    }
    async cp(src, dest, options) {
        this.assertWritable(`cp '${dest}'`);
        const srcNorm = this.normalizePath(src);
        const destNorm = this.normalizePath(dest);
        const srcExists = await this.existsInOverlay(srcNorm);
        if (!srcExists) {
            throw new Error(`ENOENT: no such file or directory, cp '${src}'`);
        }
        const srcStat = await this.stat(srcNorm);
        if (srcStat.isFile) {
            const content = await this.readFileBuffer(srcNorm);
            await this.writeFile(destNorm, content);
        }
        else if (srcStat.isDirectory) {
            if (!options?.recursive) {
                throw new Error(`EISDIR: is a directory, cp '${src}'`);
            }
            await this.mkdir(destNorm, { recursive: true });
            const children = await this.readdir(srcNorm);
            for (const child of children) {
                const srcChild = srcNorm === "/" ? `/${child}` : `${srcNorm}/${child}`;
                const destChild = destNorm === "/" ? `/${child}` : `${destNorm}/${child}`;
                await this.cp(srcChild, destChild, options);
            }
        }
    }
    async mv(src, dest) {
        this.assertWritable(`mv '${dest}'`);
        await this.cp(src, dest, { recursive: true });
        await this.rm(src, { recursive: true });
    }
    resolvePath(base, path) {
        if (path.startsWith("/")) {
            return this.normalizePath(path);
        }
        const combined = base === "/" ? `/${path}` : `${base}/${path}`;
        return this.normalizePath(combined);
    }
    getAllPaths() {
        // This is expensive for overlay fs, but we can return what's in memory
        // plus scan the real filesystem
        const paths = new Set(this.memory.keys());
        // Remove deleted paths
        for (const deleted of this.deleted) {
            paths.delete(deleted);
        }
        // Add paths from real filesystem (this is a sync operation, be careful)
        this.scanRealFs("/", paths);
        return Array.from(paths);
    }
    scanRealFs(virtualDir, paths) {
        if (this.deleted.has(virtualDir))
            return;
        const realPath = this.toRealPath(virtualDir);
        if (!realPath)
            return;
        try {
            const entries = fs.readdirSync(realPath);
            for (const entry of entries) {
                const virtualPath = virtualDir === "/" ? `/${entry}` : `${virtualDir}/${entry}`;
                if (this.deleted.has(virtualPath))
                    continue;
                paths.add(virtualPath);
                const entryRealPath = nodePath.join(realPath, entry);
                const stat = fs.statSync(entryRealPath);
                if (stat.isDirectory()) {
                    this.scanRealFs(virtualPath, paths);
                }
            }
        }
        catch {
            // Ignore errors
        }
    }
    async chmod(path, mode) {
        this.assertWritable(`chmod '${path}'`);
        const normalized = this.normalizePath(path);
        const exists = await this.existsInOverlay(normalized);
        if (!exists) {
            throw new Error(`ENOENT: no such file or directory, chmod '${path}'`);
        }
        // If in memory, update there
        const entry = this.memory.get(normalized);
        if (entry) {
            entry.mode = mode;
            return;
        }
        // If from real fs, we need to copy to memory layer first
        const stat = await this.stat(normalized);
        if (stat.isFile) {
            const content = await this.readFileBuffer(normalized);
            this.memory.set(normalized, {
                type: "file",
                content,
                mode,
                mtime: new Date(),
            });
        }
        else if (stat.isDirectory) {
            this.memory.set(normalized, {
                type: "directory",
                mode,
                mtime: new Date(),
            });
        }
    }
    async symlink(target, linkPath) {
        this.assertWritable(`symlink '${linkPath}'`);
        const normalized = this.normalizePath(linkPath);
        const exists = await this.existsInOverlay(normalized);
        if (exists) {
            throw new Error(`EEXIST: file already exists, symlink '${linkPath}'`);
        }
        this.ensureParentDirs(normalized);
        this.memory.set(normalized, {
            type: "symlink",
            target,
            mode: 0o777,
            mtime: new Date(),
        });
        this.deleted.delete(normalized);
    }
    async link(existingPath, newPath) {
        this.assertWritable(`link '${newPath}'`);
        const existingNorm = this.normalizePath(existingPath);
        const newNorm = this.normalizePath(newPath);
        const existingExists = await this.existsInOverlay(existingNorm);
        if (!existingExists) {
            throw new Error(`ENOENT: no such file or directory, link '${existingPath}'`);
        }
        const existingStat = await this.stat(existingNorm);
        if (!existingStat.isFile) {
            throw new Error(`EPERM: operation not permitted, link '${existingPath}'`);
        }
        const newExists = await this.existsInOverlay(newNorm);
        if (newExists) {
            throw new Error(`EEXIST: file already exists, link '${newPath}'`);
        }
        // Copy content to new location
        const content = await this.readFileBuffer(existingNorm);
        this.ensureParentDirs(newNorm);
        this.memory.set(newNorm, {
            type: "file",
            content,
            mode: existingStat.mode,
            mtime: new Date(),
        });
        this.deleted.delete(newNorm);
    }
    async readlink(path) {
        const normalized = this.normalizePath(path);
        if (this.deleted.has(normalized)) {
            throw new Error(`ENOENT: no such file or directory, readlink '${path}'`);
        }
        // Check memory layer first
        const entry = this.memory.get(normalized);
        if (entry) {
            if (entry.type !== "symlink") {
                throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
            }
            return entry.target;
        }
        // Fall back to real filesystem
        const realPath = this.toRealPath(normalized);
        if (!realPath) {
            throw new Error(`ENOENT: no such file or directory, readlink '${path}'`);
        }
        try {
            return await fs.promises.readlink(realPath);
        }
        catch (e) {
            if (e.code === "ENOENT") {
                throw new Error(`ENOENT: no such file or directory, readlink '${path}'`);
            }
            if (e.code === "EINVAL") {
                throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
            }
            throw e;
        }
    }
    /**
     * Resolve all symlinks in a path to get the canonical physical path.
     * This is equivalent to POSIX realpath().
     */
    async realpath(path) {
        const normalized = this.normalizePath(path);
        const seen = new Set();
        // Helper to resolve symlinks iteratively
        const resolveAll = async (p) => {
            const parts = p === "/" ? [] : p.slice(1).split("/");
            let resolved = "";
            for (const part of parts) {
                resolved = `${resolved}/${part}`;
                // Check for loops
                if (seen.has(resolved)) {
                    throw new Error(`ELOOP: too many levels of symbolic links, realpath '${path}'`);
                }
                // Check if deleted
                if (this.deleted.has(resolved)) {
                    throw new Error(`ENOENT: no such file or directory, realpath '${path}'`);
                }
                // Check memory layer first
                let entry = this.memory.get(resolved);
                let loopCount = 0;
                const maxLoops = 40;
                while (entry && entry.type === "symlink" && loopCount < maxLoops) {
                    seen.add(resolved);
                    resolved = this.resolveSymlink(resolved, entry.target);
                    loopCount++;
                    if (seen.has(resolved)) {
                        throw new Error(`ELOOP: too many levels of symbolic links, realpath '${path}'`);
                    }
                    if (this.deleted.has(resolved)) {
                        throw new Error(`ENOENT: no such file or directory, realpath '${path}'`);
                    }
                    entry = this.memory.get(resolved);
                }
                if (loopCount >= maxLoops) {
                    throw new Error(`ELOOP: too many levels of symbolic links, realpath '${path}'`);
                }
                // If not in memory, check real filesystem
                if (!entry) {
                    const realPath = this.toRealPath(resolved);
                    if (realPath) {
                        try {
                            const stat = await fs.promises.lstat(realPath);
                            if (stat.isSymbolicLink()) {
                                const target = await fs.promises.readlink(realPath);
                                seen.add(resolved);
                                resolved = this.resolveSymlink(resolved, target);
                                // Continue resolving from the new path
                                // We need to restart from this point to handle nested symlinks
                                return resolveAll(resolved);
                            }
                        }
                        catch (e) {
                            if (e.code === "ENOENT") {
                                throw new Error(`ENOENT: no such file or directory, realpath '${path}'`);
                            }
                            throw e;
                        }
                    }
                }
            }
            return resolved || "/";
        };
        const result = await resolveAll(normalized);
        // Verify the final path exists
        const exists = await this.existsInOverlay(result);
        if (!exists) {
            throw new Error(`ENOENT: no such file or directory, realpath '${path}'`);
        }
        return result;
    }
    /**
     * Set access and modification times of a file
     * @param path - The file path
     * @param _atime - Access time (ignored, kept for API compatibility)
     * @param mtime - Modification time
     */
    async utimes(path, _atime, mtime) {
        this.assertWritable(`utimes '${path}'`);
        const normalized = this.normalizePath(path);
        const exists = await this.existsInOverlay(normalized);
        if (!exists) {
            throw new Error(`ENOENT: no such file or directory, utimes '${path}'`);
        }
        // If in memory, update there
        const entry = this.memory.get(normalized);
        if (entry) {
            entry.mtime = mtime;
            return;
        }
        // If from real fs, we need to copy to memory layer first
        const stat = await this.stat(normalized);
        if (stat.isFile) {
            const content = await this.readFileBuffer(normalized);
            this.memory.set(normalized, {
                type: "file",
                content,
                mode: stat.mode,
                mtime,
            });
        }
        else if (stat.isDirectory) {
            this.memory.set(normalized, {
                type: "directory",
                mode: stat.mode,
                mtime,
            });
        }
    }
}
