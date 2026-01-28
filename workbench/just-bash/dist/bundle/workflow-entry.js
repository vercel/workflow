var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// ../../node_modules/.pnpm/@workflow+serde@4.0.1-beta.1/node_modules/@workflow/serde/dist/index.js
var WORKFLOW_SERIALIZE = /* @__PURE__ */ Symbol.for("workflow-serialize");
var WORKFLOW_DESERIALIZE = /* @__PURE__ */ Symbol.for("workflow-deserialize");

// dist/fs/encoding.js
var textEncoder = new TextEncoder();
var textDecoder = new TextDecoder();
function toBuffer(content, encoding) {
  if (content instanceof Uint8Array) {
    return content;
  }
  if (encoding === "base64") {
    return Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
  }
  if (encoding === "hex") {
    const bytes = new Uint8Array(content.length / 2);
    for (let i = 0; i < content.length; i += 2) {
      bytes[i / 2] = parseInt(content.slice(i, i + 2), 16);
    }
    return bytes;
  }
  if (encoding === "binary" || encoding === "latin1") {
    return Uint8Array.from(content, (c) => c.charCodeAt(0));
  }
  return textEncoder.encode(content);
}
__name(toBuffer, "toBuffer");
function fromBuffer(buffer, encoding) {
  if (encoding === "base64") {
    return btoa(String.fromCharCode(...buffer));
  }
  if (encoding === "hex") {
    return Array.from(buffer).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  if (encoding === "binary" || encoding === "latin1") {
    return String.fromCharCode(...buffer);
  }
  return textDecoder.decode(buffer);
}
__name(fromBuffer, "fromBuffer");
function getEncoding(options) {
  if (options === null || options === void 0) {
    return void 0;
  }
  if (typeof options === "string") {
    return options;
  }
  return options.encoding ?? void 0;
}
__name(getEncoding, "getEncoding");

// dist/fs/in-memory-fs/in-memory-fs.js
var textEncoder2 = new TextEncoder();
function isFileInit(value) {
  return typeof value === "object" && value !== null && !(value instanceof Uint8Array) && "content" in value;
}
__name(isFileInit, "isFileInit");
var InMemoryFs = class _InMemoryFs {
  static {
    __name(this, "InMemoryFs");
  }
  data = /* @__PURE__ */ new Map();
  constructor(initialFiles) {
    this.data.set("/", { type: "directory", mode: 493, mtime: /* @__PURE__ */ new Date() });
    if (initialFiles) {
      for (const [path, value] of Object.entries(initialFiles)) {
        if (isFileInit(value)) {
          this.writeFileSync(path, value.content, void 0, {
            mode: value.mode,
            mtime: value.mtime
          });
        } else {
          this.writeFileSync(path, value);
        }
      }
    }
  }
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
      } else {
        resolved.push(part);
      }
    }
    return `/${resolved.join("/")}` || "/";
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
    if (!this.data.has(dir)) {
      this.ensureParentDirs(dir);
      this.data.set(dir, { type: "directory", mode: 493, mtime: /* @__PURE__ */ new Date() });
    }
  }
  // Sync method for writing files
  writeFileSync(path, content, options, metadata) {
    const normalized = this.normalizePath(path);
    this.ensureParentDirs(normalized);
    const encoding = getEncoding(options);
    const buffer = toBuffer(content, encoding);
    this.data.set(normalized, {
      type: "file",
      content: buffer,
      mode: metadata?.mode ?? 420,
      mtime: metadata?.mtime ?? /* @__PURE__ */ new Date()
    });
  }
  // Async public API
  async readFile(path, options) {
    const buffer = await this.readFileBuffer(path);
    const encoding = getEncoding(options);
    return fromBuffer(buffer, encoding);
  }
  async readFileBuffer(path) {
    const resolvedPath = this.resolvePathWithSymlinks(path);
    const entry = this.data.get(resolvedPath);
    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }
    if (entry.type !== "file") {
      throw new Error(`EISDIR: illegal operation on a directory, read '${path}'`);
    }
    if (entry.content instanceof Uint8Array) {
      return entry.content;
    }
    return textEncoder2.encode(entry.content);
  }
  async writeFile(path, content, options) {
    this.writeFileSync(path, content, options);
  }
  async appendFile(path, content, options) {
    const normalized = this.normalizePath(path);
    const existing = this.data.get(normalized);
    if (existing && existing.type === "directory") {
      throw new Error(`EISDIR: illegal operation on a directory, write '${path}'`);
    }
    const encoding = getEncoding(options);
    const newBuffer = toBuffer(content, encoding);
    if (existing?.type === "file") {
      const existingBuffer = existing.content instanceof Uint8Array ? existing.content : textEncoder2.encode(existing.content);
      const combined = new Uint8Array(existingBuffer.length + newBuffer.length);
      combined.set(existingBuffer);
      combined.set(newBuffer, existingBuffer.length);
      this.data.set(normalized, {
        type: "file",
        content: combined,
        mode: existing.mode,
        mtime: /* @__PURE__ */ new Date()
      });
    } else {
      this.writeFileSync(path, content, options);
    }
  }
  async exists(path) {
    try {
      const resolvedPath = this.resolvePathWithSymlinks(path);
      return this.data.has(resolvedPath);
    } catch {
      return false;
    }
  }
  async stat(path) {
    const resolvedPath = this.resolvePathWithSymlinks(path);
    const entry = this.data.get(resolvedPath);
    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
    }
    let size = 0;
    if (entry.type === "file" && entry.content) {
      if (entry.content instanceof Uint8Array) {
        size = entry.content.length;
      } else {
        size = textEncoder2.encode(entry.content).length;
      }
    }
    return {
      isFile: entry.type === "file",
      isDirectory: entry.type === "directory",
      isSymbolicLink: false,
      // stat follows symlinks, so this is always false
      mode: entry.mode,
      size,
      mtime: entry.mtime || /* @__PURE__ */ new Date()
    };
  }
  async lstat(path) {
    const resolvedPath = this.resolveIntermediateSymlinks(path);
    const entry = this.data.get(resolvedPath);
    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, lstat '${path}'`);
    }
    if (entry.type === "symlink") {
      return {
        isFile: false,
        isDirectory: false,
        isSymbolicLink: true,
        mode: entry.mode,
        size: entry.target.length,
        mtime: entry.mtime || /* @__PURE__ */ new Date()
      };
    }
    let size = 0;
    if (entry.type === "file" && entry.content) {
      if (entry.content instanceof Uint8Array) {
        size = entry.content.length;
      } else {
        size = textEncoder2.encode(entry.content).length;
      }
    }
    return {
      isFile: entry.type === "file",
      isDirectory: entry.type === "directory",
      isSymbolicLink: false,
      mode: entry.mode,
      size,
      mtime: entry.mtime || /* @__PURE__ */ new Date()
    };
  }
  // Helper to resolve symlink target paths
  resolveSymlink(symlinkPath, target) {
    if (target.startsWith("/")) {
      return this.normalizePath(target);
    }
    const dir = this.dirname(symlinkPath);
    return this.normalizePath(dir === "/" ? `/${target}` : `${dir}/${target}`);
  }
  /**
   * Resolve symlinks in intermediate path components only (not the final component).
   * Used by lstat which should not follow the final symlink.
   */
  resolveIntermediateSymlinks(path) {
    const normalized = this.normalizePath(path);
    if (normalized === "/")
      return "/";
    const parts = normalized.slice(1).split("/");
    if (parts.length <= 1)
      return normalized;
    let resolvedPath = "";
    const seen = /* @__PURE__ */ new Set();
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      resolvedPath = `${resolvedPath}/${part}`;
      let entry = this.data.get(resolvedPath);
      let loopCount = 0;
      const maxLoops = 40;
      while (entry && entry.type === "symlink" && loopCount < maxLoops) {
        if (seen.has(resolvedPath)) {
          throw new Error(`ELOOP: too many levels of symbolic links, lstat '${path}'`);
        }
        seen.add(resolvedPath);
        resolvedPath = this.resolveSymlink(resolvedPath, entry.target);
        entry = this.data.get(resolvedPath);
        loopCount++;
      }
      if (loopCount >= maxLoops) {
        throw new Error(`ELOOP: too many levels of symbolic links, lstat '${path}'`);
      }
    }
    return `${resolvedPath}/${parts[parts.length - 1]}`;
  }
  /**
   * Resolve all symlinks in a path, including intermediate components.
   * For example: /home/user/linkdir/file.txt where linkdir is a symlink to "subdir"
   * would resolve to /home/user/subdir/file.txt
   */
  resolvePathWithSymlinks(path) {
    const normalized = this.normalizePath(path);
    if (normalized === "/")
      return "/";
    const parts = normalized.slice(1).split("/");
    let resolvedPath = "";
    const seen = /* @__PURE__ */ new Set();
    for (const part of parts) {
      resolvedPath = `${resolvedPath}/${part}`;
      let entry = this.data.get(resolvedPath);
      let loopCount = 0;
      const maxLoops = 40;
      while (entry && entry.type === "symlink" && loopCount < maxLoops) {
        if (seen.has(resolvedPath)) {
          throw new Error(`ELOOP: too many levels of symbolic links, open '${path}'`);
        }
        seen.add(resolvedPath);
        resolvedPath = this.resolveSymlink(resolvedPath, entry.target);
        entry = this.data.get(resolvedPath);
        loopCount++;
      }
      if (loopCount >= maxLoops) {
        throw new Error(`ELOOP: too many levels of symbolic links, open '${path}'`);
      }
    }
    return resolvedPath;
  }
  async mkdir(path, options) {
    this.mkdirSync(path, options);
  }
  /**
   * Synchronous version of mkdir
   */
  mkdirSync(path, options) {
    const normalized = this.normalizePath(path);
    if (this.data.has(normalized)) {
      const entry = this.data.get(normalized);
      if (entry?.type === "file") {
        throw new Error(`EEXIST: file already exists, mkdir '${path}'`);
      }
      if (!options?.recursive) {
        throw new Error(`EEXIST: directory already exists, mkdir '${path}'`);
      }
      return;
    }
    const parent = this.dirname(normalized);
    if (parent !== "/" && !this.data.has(parent)) {
      if (options?.recursive) {
        this.mkdirSync(parent, { recursive: true });
      } else {
        throw new Error(`ENOENT: no such file or directory, mkdir '${path}'`);
      }
    }
    this.data.set(normalized, {
      type: "directory",
      mode: 493,
      mtime: /* @__PURE__ */ new Date()
    });
  }
  async readdir(path) {
    const entries = await this.readdirWithFileTypes(path);
    return entries.map((e) => e.name);
  }
  async readdirWithFileTypes(path) {
    let normalized = this.normalizePath(path);
    let entry = this.data.get(normalized);
    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
    }
    const seen = /* @__PURE__ */ new Set();
    while (entry && entry.type === "symlink") {
      if (seen.has(normalized)) {
        throw new Error(`ELOOP: too many levels of symbolic links, scandir '${path}'`);
      }
      seen.add(normalized);
      normalized = this.resolveSymlink(normalized, entry.target);
      entry = this.data.get(normalized);
    }
    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
    }
    if (entry.type !== "directory") {
      throw new Error(`ENOTDIR: not a directory, scandir '${path}'`);
    }
    const prefix = normalized === "/" ? "/" : `${normalized}/`;
    const entriesMap = /* @__PURE__ */ new Map();
    for (const [p, fsEntry] of this.data.entries()) {
      if (p === normalized)
        continue;
      if (p.startsWith(prefix)) {
        const rest = p.slice(prefix.length);
        const name = rest.split("/")[0];
        if (name && !rest.includes("/", name.length) && !entriesMap.has(name)) {
          entriesMap.set(name, {
            name,
            isFile: fsEntry.type === "file",
            isDirectory: fsEntry.type === "directory",
            isSymbolicLink: fsEntry.type === "symlink"
          });
        }
      }
    }
    return Array.from(entriesMap.values()).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  }
  async rm(path, options) {
    const normalized = this.normalizePath(path);
    const entry = this.data.get(normalized);
    if (!entry) {
      if (options?.force)
        return;
      throw new Error(`ENOENT: no such file or directory, rm '${path}'`);
    }
    if (entry.type === "directory") {
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
    this.data.delete(normalized);
  }
  async cp(src, dest, options) {
    const srcNorm = this.normalizePath(src);
    const destNorm = this.normalizePath(dest);
    const srcEntry = this.data.get(srcNorm);
    if (!srcEntry) {
      throw new Error(`ENOENT: no such file or directory, cp '${src}'`);
    }
    if (srcEntry.type === "file") {
      this.ensureParentDirs(destNorm);
      this.data.set(destNorm, { ...srcEntry });
    } else if (srcEntry.type === "directory") {
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
    await this.cp(src, dest, { recursive: true });
    await this.rm(src, { recursive: true });
  }
  // Get all paths (useful for debugging/glob)
  getAllPaths() {
    return Array.from(this.data.keys());
  }
  // Resolve a path relative to a base
  resolvePath(base, path) {
    if (path.startsWith("/")) {
      return this.normalizePath(path);
    }
    const combined = base === "/" ? `/${path}` : `${base}/${path}`;
    return this.normalizePath(combined);
  }
  // Change file/directory permissions
  async chmod(path, mode) {
    const normalized = this.normalizePath(path);
    const entry = this.data.get(normalized);
    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, chmod '${path}'`);
    }
    entry.mode = mode;
  }
  // Create a symbolic link
  async symlink(target, linkPath) {
    const normalized = this.normalizePath(linkPath);
    if (this.data.has(normalized)) {
      throw new Error(`EEXIST: file already exists, symlink '${linkPath}'`);
    }
    this.ensureParentDirs(normalized);
    this.data.set(normalized, {
      type: "symlink",
      target,
      mode: 511,
      mtime: /* @__PURE__ */ new Date()
    });
  }
  // Create a hard link
  async link(existingPath, newPath) {
    const existingNorm = this.normalizePath(existingPath);
    const newNorm = this.normalizePath(newPath);
    const entry = this.data.get(existingNorm);
    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, link '${existingPath}'`);
    }
    if (entry.type !== "file") {
      throw new Error(`EPERM: operation not permitted, link '${existingPath}'`);
    }
    if (this.data.has(newNorm)) {
      throw new Error(`EEXIST: file already exists, link '${newPath}'`);
    }
    this.ensureParentDirs(newNorm);
    this.data.set(newNorm, {
      type: "file",
      content: entry.content,
      mode: entry.mode,
      mtime: entry.mtime
    });
  }
  // Read the target of a symbolic link
  async readlink(path) {
    const normalized = this.normalizePath(path);
    const entry = this.data.get(normalized);
    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, readlink '${path}'`);
    }
    if (entry.type !== "symlink") {
      throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
    }
    return entry.target;
  }
  /**
   * Resolve all symlinks in a path to get the canonical physical path.
   * This is equivalent to POSIX realpath().
   */
  async realpath(path) {
    const resolved = this.resolvePathWithSymlinks(path);
    if (!this.data.has(resolved)) {
      throw new Error(`ENOENT: no such file or directory, realpath '${path}'`);
    }
    return resolved;
  }
  // ===========================================================================
  // Workflow Serde Support
  // ===========================================================================
  static [WORKFLOW_SERIALIZE](instance) {
    return { data: instance.data };
  }
  static [WORKFLOW_DESERIALIZE](serialized) {
    const fs = new _InMemoryFs();
    fs.data = serialized.data;
    return fs;
  }
  /**
   * Set access and modification times of a file
   * @param path - The file path
   * @param _atime - Access time (ignored, kept for API compatibility)
   * @param mtime - Modification time
   */
  async utimes(path, _atime, mtime) {
    const normalized = this.normalizePath(path);
    const resolved = this.resolvePathWithSymlinks(normalized);
    const entry = this.data.get(resolved);
    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, utimes '${path}'`);
    }
    entry.mtime = mtime;
  }
};

// dist/limits.js
var DEFAULT_LIMITS = {
  maxCallDepth: 100,
  maxCommandCount: 1e4,
  maxLoopIterations: 1e4,
  maxAwkIterations: 1e4,
  maxSedIterations: 1e4,
  maxJqIterations: 1e4,
  maxSqliteTimeoutMs: 5e3,
  maxPythonTimeoutMs: 3e4
};
function resolveLimits(userLimits) {
  if (!userLimits) {
    return { ...DEFAULT_LIMITS };
  }
  return {
    maxCallDepth: userLimits.maxCallDepth ?? DEFAULT_LIMITS.maxCallDepth,
    maxCommandCount: userLimits.maxCommandCount ?? DEFAULT_LIMITS.maxCommandCount,
    maxLoopIterations: userLimits.maxLoopIterations ?? DEFAULT_LIMITS.maxLoopIterations,
    maxAwkIterations: userLimits.maxAwkIterations ?? DEFAULT_LIMITS.maxAwkIterations,
    maxSedIterations: userLimits.maxSedIterations ?? DEFAULT_LIMITS.maxSedIterations,
    maxJqIterations: userLimits.maxJqIterations ?? DEFAULT_LIMITS.maxJqIterations,
    maxSqliteTimeoutMs: userLimits.maxSqliteTimeoutMs ?? DEFAULT_LIMITS.maxSqliteTimeoutMs,
    maxPythonTimeoutMs: userLimits.maxPythonTimeoutMs ?? DEFAULT_LIMITS.maxPythonTimeoutMs
  };
}
__name(resolveLimits, "resolveLimits");

// dist/Bash.workflow.js
var Bash = class _Bash {
  static {
    __name(this, "Bash");
  }
  fs;
  state;
  limits;
  constructor(options = {}) {
    this.fs = options.fs ?? new InMemoryFs();
    this.limits = resolveLimits(options.executionLimits);
    this.state = {
      env: {
        HOME: "/home/user",
        PATH: "/usr/bin:/bin",
        IFS: " 	\n",
        PWD: "/home/user",
        OLDPWD: "/home/user",
        OPTIND: "1"
      },
      cwd: "/home/user",
      previousDir: "/home/user",
      lastExitCode: 0,
      lastArg: "",
      currentLine: 1,
      options: {
        errexit: false,
        pipefail: false,
        nounset: false,
        xtrace: false,
        verbose: false,
        posix: false,
        allexport: false,
        noclobber: false,
        noglob: false,
        noexec: false,
        vi: false,
        emacs: false
      },
      shoptOptions: {
        extglob: false,
        dotglob: false,
        nullglob: false,
        failglob: false,
        globstar: false,
        globskipdots: true,
        nocaseglob: false,
        nocasematch: false,
        expand_aliases: false,
        lastpipe: false,
        xpg_echo: false
      },
      functions: /* @__PURE__ */ new Map(),
      localScopes: [],
      callDepth: 0,
      sourceDepth: 0,
      commandCount: 0,
      startTime: Date.now(),
      lastBackgroundPid: 0,
      bashPid: typeof process !== "undefined" ? process.pid : 1,
      nextVirtualPid: (typeof process !== "undefined" ? process.pid : 1) + 1,
      exportedVars: /* @__PURE__ */ new Set(["HOME", "PATH", "PWD", "OLDPWD"]),
      readonlyVars: /* @__PURE__ */ new Set(["SHELLOPTS", "BASHOPTS"]),
      hashTable: /* @__PURE__ */ new Map(),
      inCondition: false,
      loopDepth: 0
    };
  }
  // ===========================================================================
  // Workflow Serde Support
  // ===========================================================================
  /**
   * Serialize Bash instance for Workflow DevKit.
   * Serializes filesystem and interpreter state.
   */
  static [WORKFLOW_SERIALIZE](instance) {
    return {
      fs: instance.fs,
      state: instance.state,
      limits: instance.limits
    };
  }
  /**
   * Deserialize Bash instance for Workflow DevKit.
   */
  static [WORKFLOW_DESERIALIZE](serialized) {
    const bash = new _Bash({ fs: serialized.fs });
    bash.state = serialized.state;
    bash.limits = serialized.limits;
    return bash;
  }
  // ===========================================================================
  // Read-only accessors (for workflow context inspection)
  // ===========================================================================
  getCwd() {
    return this.state.cwd;
  }
  getEnv() {
    return { ...this.state.env };
  }
};
export {
  Bash,
  InMemoryFs,
  WORKFLOW_DESERIALIZE,
  WORKFLOW_SERIALIZE
};
