/**
 * ReadWriteFs - Direct wrapper around the real filesystem
 *
 * All operations go directly to the underlying Node.js filesystem.
 * This is a true read-write filesystem with no overlay or sandboxing.
 */
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { fromBuffer, getEncoding, toBuffer, } from "../encoding.js";
export class ReadWriteFs {
    root;
    constructor(options) {
        this.root = nodePath.resolve(options.root);
        // Verify root exists and is a directory
        if (!fs.existsSync(this.root)) {
            throw new Error(`ReadWriteFs root does not exist: ${this.root}`);
        }
        const stat = fs.statSync(this.root);
        if (!stat.isDirectory()) {
            throw new Error(`ReadWriteFs root is not a directory: ${this.root}`);
        }
    }
    /**
     * Convert a virtual path to a real filesystem path.
     */
    toRealPath(virtualPath) {
        const normalized = this.normalizePath(virtualPath);
        const realPath = nodePath.join(this.root, normalized);
        return nodePath.resolve(realPath);
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
    async readFile(path, options) {
        const buffer = await this.readFileBuffer(path);
        const encoding = getEncoding(options);
        return fromBuffer(buffer, encoding);
    }
    async readFileBuffer(path) {
        const realPath = this.toRealPath(path);
        try {
            const content = await fs.promises.readFile(realPath);
            return new Uint8Array(content);
        }
        catch (e) {
            const err = e;
            if (err.code === "ENOENT") {
                throw new Error(`ENOENT: no such file or directory, open '${path}'`);
            }
            if (err.code === "EISDIR") {
                throw new Error(`EISDIR: illegal operation on a directory, read '${path}'`);
            }
            throw e;
        }
    }
    async writeFile(path, content, options) {
        const realPath = this.toRealPath(path);
        const encoding = getEncoding(options);
        const buffer = toBuffer(content, encoding);
        // Ensure parent directory exists
        const dir = nodePath.dirname(realPath);
        await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.writeFile(realPath, buffer);
    }
    async appendFile(path, content, options) {
        const realPath = this.toRealPath(path);
        const encoding = getEncoding(options);
        const buffer = toBuffer(content, encoding);
        // Ensure parent directory exists
        const dir = nodePath.dirname(realPath);
        await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.appendFile(realPath, buffer);
    }
    async exists(path) {
        const realPath = this.toRealPath(path);
        try {
            await fs.promises.access(realPath);
            return true;
        }
        catch {
            return false;
        }
    }
    async stat(path) {
        const realPath = this.toRealPath(path);
        try {
            const stat = await fs.promises.stat(realPath);
            return {
                isFile: stat.isFile(),
                isDirectory: stat.isDirectory(),
                isSymbolicLink: false, // stat follows symlinks
                mode: stat.mode,
                size: stat.size,
                mtime: stat.mtime,
            };
        }
        catch (e) {
            const err = e;
            if (err.code === "ENOENT") {
                throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
            }
            throw e;
        }
    }
    async lstat(path) {
        const realPath = this.toRealPath(path);
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
            const err = e;
            if (err.code === "ENOENT") {
                throw new Error(`ENOENT: no such file or directory, lstat '${path}'`);
            }
            throw e;
        }
    }
    async mkdir(path, options) {
        const realPath = this.toRealPath(path);
        try {
            await fs.promises.mkdir(realPath, { recursive: options?.recursive });
        }
        catch (e) {
            const err = e;
            if (err.code === "EEXIST") {
                throw new Error(`EEXIST: file already exists, mkdir '${path}'`);
            }
            if (err.code === "ENOENT") {
                throw new Error(`ENOENT: no such file or directory, mkdir '${path}'`);
            }
            throw e;
        }
    }
    async readdir(path) {
        const entries = await this.readdirWithFileTypes(path);
        return entries.map((e) => e.name);
    }
    async readdirWithFileTypes(path) {
        const realPath = this.toRealPath(path);
        try {
            const entries = await fs.promises.readdir(realPath, {
                withFileTypes: true,
            });
            return entries
                .map((dirent) => ({
                name: dirent.name,
                isFile: dirent.isFile(),
                isDirectory: dirent.isDirectory(),
                isSymbolicLink: dirent.isSymbolicLink(),
            }))
                .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        }
        catch (e) {
            const err = e;
            if (err.code === "ENOENT") {
                throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
            }
            if (err.code === "ENOTDIR") {
                throw new Error(`ENOTDIR: not a directory, scandir '${path}'`);
            }
            throw e;
        }
    }
    async rm(path, options) {
        const realPath = this.toRealPath(path);
        try {
            await fs.promises.rm(realPath, {
                recursive: options?.recursive ?? false,
                force: options?.force ?? false,
            });
        }
        catch (e) {
            const err = e;
            if (err.code === "ENOENT" && !options?.force) {
                throw new Error(`ENOENT: no such file or directory, rm '${path}'`);
            }
            if (err.code === "ENOTEMPTY") {
                throw new Error(`ENOTEMPTY: directory not empty, rm '${path}'`);
            }
            throw e;
        }
    }
    async cp(src, dest, options) {
        const srcReal = this.toRealPath(src);
        const destReal = this.toRealPath(dest);
        try {
            await fs.promises.cp(srcReal, destReal, {
                recursive: options?.recursive ?? false,
            });
        }
        catch (e) {
            const err = e;
            if (err.code === "ENOENT") {
                throw new Error(`ENOENT: no such file or directory, cp '${src}'`);
            }
            if (err.code === "EISDIR") {
                throw new Error(`EISDIR: is a directory, cp '${src}'`);
            }
            throw e;
        }
    }
    async mv(src, dest) {
        const srcReal = this.toRealPath(src);
        const destReal = this.toRealPath(dest);
        // Ensure destination parent directory exists
        const destDir = nodePath.dirname(destReal);
        await fs.promises.mkdir(destDir, { recursive: true });
        try {
            await fs.promises.rename(srcReal, destReal);
        }
        catch (e) {
            const err = e;
            if (err.code === "ENOENT") {
                throw new Error(`ENOENT: no such file or directory, mv '${src}'`);
            }
            // If rename fails across devices, fall back to copy + delete
            if (err.code === "EXDEV") {
                await this.cp(src, dest, { recursive: true });
                await this.rm(src, { recursive: true });
                return;
            }
            throw e;
        }
    }
    resolvePath(base, path) {
        if (path.startsWith("/")) {
            return this.normalizePath(path);
        }
        const combined = base === "/" ? `/${path}` : `${base}/${path}`;
        return this.normalizePath(combined);
    }
    getAllPaths() {
        // Recursively scan the filesystem
        const paths = [];
        this.scanDir("/", paths);
        return paths;
    }
    scanDir(virtualDir, paths) {
        const realPath = this.toRealPath(virtualDir);
        try {
            const entries = fs.readdirSync(realPath);
            for (const entry of entries) {
                const virtualPath = virtualDir === "/" ? `/${entry}` : `${virtualDir}/${entry}`;
                paths.push(virtualPath);
                const entryRealPath = nodePath.join(realPath, entry);
                const stat = fs.statSync(entryRealPath);
                if (stat.isDirectory()) {
                    this.scanDir(virtualPath, paths);
                }
            }
        }
        catch {
            // Ignore errors
        }
    }
    async chmod(path, mode) {
        const realPath = this.toRealPath(path);
        try {
            await fs.promises.chmod(realPath, mode);
        }
        catch (e) {
            const err = e;
            if (err.code === "ENOENT") {
                throw new Error(`ENOENT: no such file or directory, chmod '${path}'`);
            }
            throw e;
        }
    }
    async symlink(target, linkPath) {
        const realLinkPath = this.toRealPath(linkPath);
        try {
            await fs.promises.symlink(target, realLinkPath);
        }
        catch (e) {
            const err = e;
            if (err.code === "EEXIST") {
                throw new Error(`EEXIST: file already exists, symlink '${linkPath}'`);
            }
            throw e;
        }
    }
    async link(existingPath, newPath) {
        const realExisting = this.toRealPath(existingPath);
        const realNew = this.toRealPath(newPath);
        try {
            await fs.promises.link(realExisting, realNew);
        }
        catch (e) {
            const err = e;
            if (err.code === "ENOENT") {
                throw new Error(`ENOENT: no such file or directory, link '${existingPath}'`);
            }
            if (err.code === "EEXIST") {
                throw new Error(`EEXIST: file already exists, link '${newPath}'`);
            }
            if (err.code === "EPERM") {
                throw new Error(`EPERM: operation not permitted, link '${existingPath}'`);
            }
            throw e;
        }
    }
    async readlink(path) {
        const realPath = this.toRealPath(path);
        try {
            return await fs.promises.readlink(realPath);
        }
        catch (e) {
            const err = e;
            if (err.code === "ENOENT") {
                throw new Error(`ENOENT: no such file or directory, readlink '${path}'`);
            }
            if (err.code === "EINVAL") {
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
        const realPath = this.toRealPath(path);
        try {
            const resolved = await fs.promises.realpath(realPath);
            // Convert back to virtual path (relative to root)
            if (resolved.startsWith(this.root)) {
                const relative = resolved.slice(this.root.length);
                return relative || "/";
            }
            // If resolved path is outside root (shouldn't happen), return as-is
            return resolved;
        }
        catch (e) {
            const err = e;
            if (err.code === "ENOENT") {
                throw new Error(`ENOENT: no such file or directory, realpath '${path}'`);
            }
            if (err.code === "ELOOP") {
                throw new Error(`ELOOP: too many levels of symbolic links, realpath '${path}'`);
            }
            throw e;
        }
    }
    /**
     * Set access and modification times of a file
     * @param path - The file path
     * @param atime - Access time
     * @param mtime - Modification time
     */
    async utimes(path, atime, mtime) {
        const realPath = this.toRealPath(path);
        try {
            await fs.promises.utimes(realPath, atime, mtime);
        }
        catch (e) {
            const err = e;
            if (err.code === "ENOENT") {
                throw new Error(`ENOENT: no such file or directory, utimes '${path}'`);
            }
            throw e;
        }
    }
}
