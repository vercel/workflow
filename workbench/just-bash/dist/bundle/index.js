import {
  KERNEL_VERSION,
  LexerError,
  ParseException,
  Parser,
  checkReadonlyError,
  clearArray,
  escapeGlobChars,
  escapeRegexChars,
  evaluateArithmetic,
  expandRedirectTarget,
  expandWord,
  expandWordForPattern,
  expandWordForRegex,
  expandWordWithGlob,
  formatProcStatus,
  getArrayElements,
  getArrayIndices,
  getAssocArrayKeys,
  getIfs,
  getNamerefTarget,
  hasQuotedMultiValueAt,
  isArray,
  isNameref,
  isReadonly,
  isWordFullyQuoted,
  markExported,
  markNameref,
  markNamerefBound,
  markNamerefInvalid,
  markReadonly,
  parse,
  parseArithmeticExpression,
  parseKeyedElementFromWord,
  resolveNameref,
  resolveNamerefForAssignment,
  splitByIfsForRead,
  stripTrailingIfsWhitespace,
  targetExists,
  unmarkExported,
  unmarkNameref,
  wordToLiteralString
} from "./chunks/chunk-76K7JZ5Q.js";
import {
  ArithmeticError,
  BadSubstitutionError,
  BraceExpansionError,
  BreakError,
  ContinueError,
  ErrexitError,
  ExecutionLimitError,
  ExitError,
  GlobError,
  NounsetError,
  PosixFatalError,
  ReturnError,
  SubshellExitError,
  isScopeExitError
} from "./chunks/chunk-KRBYMBZY.js";
import "./chunks/chunk-PRIRMCRG.js";
import {
  getErrorMessage
} from "./chunks/chunk-3EDCHFHY.js";
import {
  __name
} from "./chunks/chunk-Y7IWVHJ4.js";

// ../../node_modules/.pnpm/@workflow+serde@4.0.1-beta.1/node_modules/@workflow/serde/dist/index.js
var WORKFLOW_SERIALIZE = /* @__PURE__ */ Symbol.for("workflow-serialize");
var WORKFLOW_DESERIALIZE = /* @__PURE__ */ Symbol.for("workflow-deserialize");

// dist/commands/registry.js
var commandLoaders = [
  // Basic I/O
  {
    name: "echo",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/echo-4Q24LB22.js")).echoCommand, "load")
  },
  {
    name: "cat",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/cat-B5PH27R7.js")).catCommand, "load")
  },
  {
    name: "printf",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/printf-ZZ4KXEG7.js")).printfCommand, "load")
  },
  // File operations
  {
    name: "ls",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/ls-ITHR6NA5.js")).lsCommand, "load")
  },
  {
    name: "mkdir",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/mkdir-DPRWIIWK.js")).mkdirCommand, "load")
  },
  {
    name: "rmdir",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/rmdir-JZSE3DID.js")).rmdirCommand, "load")
  },
  {
    name: "touch",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/touch-OBPNOMXA.js")).touchCommand, "load")
  },
  {
    name: "rm",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/rm-EDUVHVWA.js")).rmCommand, "load")
  },
  {
    name: "cp",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/cp-GCW6DPKS.js")).cpCommand, "load")
  },
  {
    name: "mv",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/mv-O7MACADD.js")).mvCommand, "load")
  },
  {
    name: "ln",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/ln-YRTKPH24.js")).lnCommand, "load")
  },
  {
    name: "chmod",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/chmod-MZSIIAM2.js")).chmodCommand, "load")
  },
  // Navigation
  {
    name: "pwd",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/pwd-UZ5Z7KB2.js")).pwdCommand, "load")
  },
  {
    name: "readlink",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/readlink-UX2V3KZO.js")).readlinkCommand, "load")
  },
  // File viewing
  {
    name: "head",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/head-MAMZPQ4G.js")).headCommand, "load")
  },
  {
    name: "tail",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/tail-QAYF3564.js")).tailCommand, "load")
  },
  {
    name: "wc",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/wc-OEWLC524.js")).wcCommand, "load")
  },
  {
    name: "stat",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/stat-3JBZSO27.js")).statCommand, "load")
  },
  // Text processing
  {
    name: "grep",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/grep-2LQO4DI4.js")).grepCommand, "load")
  },
  {
    name: "fgrep",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/grep-2LQO4DI4.js")).fgrepCommand, "load")
  },
  {
    name: "egrep",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/grep-2LQO4DI4.js")).egrepCommand, "load")
  },
  {
    name: "rg",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/rg-3TQI6FXH.js")).rgCommand, "load")
  },
  {
    name: "sed",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/sed-2VVO2AX6.js")).sedCommand, "load")
  },
  {
    name: "awk",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/awk2-DZVMO7HO.js")).awkCommand2, "load")
  },
  {
    name: "sort",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/sort-HZ26NJFX.js")).sortCommand, "load")
  },
  {
    name: "uniq",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/uniq-2NSIND2Z.js")).uniqCommand, "load")
  },
  {
    name: "comm",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/comm-26O3DPXS.js")).commCommand, "load")
  },
  {
    name: "cut",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/cut-EIFIJONN.js")).cutCommand, "load")
  },
  {
    name: "paste",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/paste-CRP7HJIL.js")).pasteCommand, "load")
  },
  {
    name: "tr",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/tr-EU3C37E7.js")).trCommand, "load")
  },
  {
    name: "rev",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/rev-TO32M6QM.js")).rev, "load")
  },
  {
    name: "nl",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/nl-VB4EELAK.js")).nl, "load")
  },
  {
    name: "fold",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/fold-HRC5RKDU.js")).fold, "load")
  },
  {
    name: "expand",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/expand-45TJED4V.js")).expand, "load")
  },
  {
    name: "unexpand",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/unexpand-EFNDJ2XW.js")).unexpand, "load")
  },
  {
    name: "strings",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/strings-A3U3X73Y.js")).strings, "load")
  },
  {
    name: "split",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/split-EKWHRCLK.js")).split, "load")
  },
  {
    name: "column",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/column-44HJIOZZ.js")).column, "load")
  },
  {
    name: "join",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/join-GKVO4J5L.js")).join, "load")
  },
  {
    name: "tee",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/tee-E5IFE6IH.js")).teeCommand, "load")
  },
  // Search
  {
    name: "find",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/find-UMVOHB4Z.js")).findCommand, "load")
  },
  // Path utilities
  {
    name: "basename",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/basename-PRSHUE2H.js")).basenameCommand, "load")
  },
  {
    name: "dirname",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/dirname-UWVOMVEF.js")).dirnameCommand, "load")
  },
  // Directory utilities
  {
    name: "tree",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/tree-UUS43NLC.js")).treeCommand, "load")
  },
  {
    name: "du",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/du-TNOLWKGM.js")).duCommand, "load")
  },
  // Environment
  {
    name: "env",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/env-LIAAB6DX.js")).envCommand, "load")
  },
  {
    name: "printenv",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/env-LIAAB6DX.js")).printenvCommand, "load")
  },
  {
    name: "alias",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/alias-QMPFO2GL.js")).aliasCommand, "load")
  },
  {
    name: "unalias",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/alias-QMPFO2GL.js")).unaliasCommand, "load")
  },
  {
    name: "history",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/history-4GQ2YJGE.js")).historyCommand, "load")
  },
  // Utilities
  {
    name: "xargs",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/xargs-VLOAFEYW.js")).xargsCommand, "load")
  },
  {
    name: "true",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/true-G2JQF2T5.js")).trueCommand, "load")
  },
  {
    name: "false",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/true-G2JQF2T5.js")).falseCommand, "load")
  },
  {
    name: "clear",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/clear-ECGGFZOE.js")).clearCommand, "load")
  },
  // Shell
  {
    name: "bash",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/bash-BV44E2AQ.js")).bashCommand, "load")
  },
  {
    name: "sh",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/bash-BV44E2AQ.js")).shCommand, "load")
  },
  // Data processing
  {
    name: "jq",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/jq-JONOBNUR.js")).jqCommand, "load")
  },
  {
    name: "base64",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/base64-UXIW5DLW.js")).base64Command, "load")
  },
  {
    name: "diff",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/diff-ZFQ3G62K.js")).diffCommand, "load")
  },
  {
    name: "date",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/date-UX4T6DZI.js")).dateCommand, "load")
  },
  {
    name: "sleep",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/sleep-NLREXEY3.js")).sleepCommand, "load")
  },
  {
    name: "timeout",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/timeout-S2QKAXZ5.js")).timeoutCommand, "load")
  },
  {
    name: "time",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/time-KQHYMHQP.js")).timeCommand, "load")
  },
  {
    name: "seq",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/seq-NIXAHVIM.js")).seqCommand, "load")
  },
  {
    name: "expr",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/expr-TJEIOE4P.js")).exprCommand, "load")
  },
  // Checksums
  {
    name: "md5sum",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/md5sum-YUAHKVHJ.js")).md5sumCommand, "load")
  },
  {
    name: "sha1sum",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/sha1sum-R7H4OKNW.js")).sha1sumCommand, "load")
  },
  {
    name: "sha256sum",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/sha256sum-TNNNTOHR.js")).sha256sumCommand, "load")
  },
  // File type detection
  {
    name: "file",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/file-3NDKDBH7.js")).fileCommand, "load")
  },
  // HTML processing
  {
    name: "html-to-markdown",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/html-to-markdown-TH7JLL6O.js")).htmlToMarkdownCommand, "load")
  },
  // Help
  {
    name: "help",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/help-ANYWV4TI.js")).helpCommand, "load")
  },
  // PATH utilities
  {
    name: "which",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/which-WBT5TKUV.js")).whichCommand, "load")
  },
  // Misc utilities
  {
    name: "tac",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/tac-O6MB7KMO.js")).tac, "load")
  },
  {
    name: "hostname",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/hostname-J4E23M7W.js")).hostname, "load")
  },
  {
    name: "whoami",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/whoami-CSC7NWHZ.js")).whoami, "load")
  },
  {
    name: "od",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/od-C3HXAFA4.js")).od, "load")
  },
  // Compression
  {
    name: "gzip",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/gzip-EDT74RBR.js")).gzipCommand, "load")
  },
  {
    name: "gunzip",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/gzip-EDT74RBR.js")).gunzipCommand, "load")
  },
  {
    name: "zcat",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/gzip-EDT74RBR.js")).zcatCommand, "load")
  }
];
if (typeof __BROWSER__ === "undefined" || !__BROWSER__) {
  commandLoaders.push({
    name: "tar",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/tar-LMPCAEUP.js")).tarCommand, "load")
  });
  commandLoaders.push({
    name: "yq",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/yq-MNUMXC25.js")).yqCommand, "load")
  });
  commandLoaders.push({
    name: "xan",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/xan-HGI54YYH.js")).xanCommand, "load")
  });
  commandLoaders.push({
    name: "sqlite3",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/sqlite3-Z25OARQE.js")).sqlite3Command, "load")
  });
  commandLoaders.push({
    name: "python3",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/python3-IQN6VCMJ.js")).python3Command, "load")
  });
  commandLoaders.push({
    name: "python",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/python3-IQN6VCMJ.js")).pythonCommand, "load")
  });
}
var networkCommandLoaders = [
  {
    name: "curl",
    load: /* @__PURE__ */ __name(async () => (await import("./chunks/curl-SQ7JITGL.js")).curlCommand, "load")
  }
];
var cache = /* @__PURE__ */ new Map();
function createLazyCommand(def) {
  return {
    name: def.name,
    async execute(args, ctx) {
      let cmd = cache.get(def.name);
      if (!cmd) {
        cmd = await def.load();
        cache.set(def.name, cmd);
      }
      return cmd.execute(args, ctx);
    }
  };
}
__name(createLazyCommand, "createLazyCommand");
function getCommandNames() {
  return commandLoaders.map((def) => def.name);
}
__name(getCommandNames, "getCommandNames");
function getNetworkCommandNames() {
  return networkCommandLoaders.map((def) => def.name);
}
__name(getNetworkCommandNames, "getNetworkCommandNames");
function createLazyCommands(filter) {
  const loaders = filter ? commandLoaders.filter((def) => filter.includes(def.name)) : commandLoaders;
  return loaders.map(createLazyCommand);
}
__name(createLazyCommands, "createLazyCommands");
function createNetworkCommands() {
  return networkCommandLoaders.map(createLazyCommand);
}
__name(createNetworkCommands, "createNetworkCommands");

// dist/custom-commands.js
function isLazyCommand(cmd) {
  return "load" in cmd && typeof cmd.load === "function";
}
__name(isLazyCommand, "isLazyCommand");
function defineCommand(name, execute) {
  return { name, execute };
}
__name(defineCommand, "defineCommand");
function createLazyCustomCommand(lazy) {
  let cached = null;
  return {
    name: lazy.name,
    async execute(args, ctx) {
      if (!cached) {
        cached = await lazy.load();
      }
      return cached.execute(args, ctx);
    }
  };
}
__name(createLazyCustomCommand, "createLazyCustomCommand");

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
    const fs3 = new _InMemoryFs();
    fs3.data = serialized.data;
    return fs3;
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

// dist/fs/init.js
function isSyncInitFs(fs3) {
  const maybeFs = fs3;
  return typeof maybeFs.mkdirSync === "function" && typeof maybeFs.writeFileSync === "function";
}
__name(isSyncInitFs, "isSyncInitFs");
function initCommonDirectories(fs3, useDefaultLayout) {
  fs3.mkdirSync("/bin", { recursive: true });
  fs3.mkdirSync("/usr/bin", { recursive: true });
  if (useDefaultLayout) {
    fs3.mkdirSync("/home/user", { recursive: true });
    fs3.mkdirSync("/tmp", { recursive: true });
  }
}
__name(initCommonDirectories, "initCommonDirectories");
function initDevFiles(fs3) {
  fs3.mkdirSync("/dev", { recursive: true });
  fs3.writeFileSync("/dev/null", "");
  fs3.writeFileSync("/dev/zero", new Uint8Array(0));
  fs3.writeFileSync("/dev/stdin", "");
  fs3.writeFileSync("/dev/stdout", "");
  fs3.writeFileSync("/dev/stderr", "");
}
__name(initDevFiles, "initDevFiles");
function initProcFiles(fs3) {
  fs3.mkdirSync("/proc/self/fd", { recursive: true });
  fs3.writeFileSync("/proc/version", `${KERNEL_VERSION}
`);
  fs3.writeFileSync("/proc/self/exe", "/bin/bash");
  fs3.writeFileSync("/proc/self/cmdline", "bash\0");
  fs3.writeFileSync("/proc/self/comm", "bash\n");
  fs3.writeFileSync("/proc/self/status", formatProcStatus());
  fs3.writeFileSync("/proc/self/fd/0", "/dev/stdin");
  fs3.writeFileSync("/proc/self/fd/1", "/dev/stdout");
  fs3.writeFileSync("/proc/self/fd/2", "/dev/stderr");
}
__name(initProcFiles, "initProcFiles");
function initFilesystem(fs3, useDefaultLayout) {
  if (isSyncInitFs(fs3)) {
    initCommonDirectories(fs3, useDefaultLayout);
    initDevFiles(fs3);
    initProcFiles(fs3);
  }
}
__name(initFilesystem, "initFilesystem");

// dist/interpreter/helpers/shellopts.js
var SHELLOPTS_OPTIONS = [
  "allexport",
  "errexit",
  "noglob",
  "noclobber",
  "noexec",
  "nounset",
  "pipefail",
  "posix",
  "verbose",
  "xtrace"
];
var ALWAYS_ON_OPTIONS = ["braceexpand", "hashall", "interactive-comments"];
function buildShellopts(options) {
  const enabled = [];
  const allOptions = [
    ...ALWAYS_ON_OPTIONS.map((opt) => ({ name: opt, enabled: true })),
    ...SHELLOPTS_OPTIONS.map((opt) => ({ name: opt, enabled: options[opt] }))
  ].sort((a, b) => a.name.localeCompare(b.name));
  for (const opt of allOptions) {
    if (opt.enabled) {
      enabled.push(opt.name);
    }
  }
  return enabled.join(":");
}
__name(buildShellopts, "buildShellopts");
function updateShellopts(ctx) {
  ctx.state.env.SHELLOPTS = buildShellopts(ctx.state.options);
}
__name(updateShellopts, "updateShellopts");
var BASHOPTS_OPTIONS = [
  "dotglob",
  "expand_aliases",
  "extglob",
  "failglob",
  "globskipdots",
  "globstar",
  "lastpipe",
  "nocaseglob",
  "nocasematch",
  "nullglob",
  "xpg_echo"
];
function buildBashopts(shoptOptions) {
  const enabled = [];
  for (const opt of BASHOPTS_OPTIONS) {
    if (shoptOptions[opt]) {
      enabled.push(opt);
    }
  }
  return enabled.join(":");
}
__name(buildBashopts, "buildBashopts");
function updateBashopts(ctx) {
  ctx.state.env.BASHOPTS = buildBashopts(ctx.state.shoptOptions);
}
__name(updateBashopts, "updateBashopts");

// dist/interpreter/alias-expansion.js
var ALIAS_PREFIX = "BASH_ALIAS_";
function isLiteralUnquotedWord(word) {
  if (word.parts.length !== 1)
    return false;
  const part = word.parts[0];
  return part.type === "Literal";
}
__name(isLiteralUnquotedWord, "isLiteralUnquotedWord");
function getLiteralValue(word) {
  if (word.parts.length !== 1)
    return null;
  const part = word.parts[0];
  if (part.type === "Literal") {
    return part.value;
  }
  return null;
}
__name(getLiteralValue, "getLiteralValue");
function getAlias(ctx, name) {
  return ctx.env[`${ALIAS_PREFIX}${name}`];
}
__name(getAlias, "getAlias");
function expandAlias(ctx, node, aliasExpansionStack) {
  if (!node.name)
    return node;
  if (!isLiteralUnquotedWord(node.name))
    return node;
  const cmdName = getLiteralValue(node.name);
  if (!cmdName)
    return node;
  const aliasValue = getAlias(ctx, cmdName);
  if (!aliasValue)
    return node;
  if (aliasExpansionStack.has(cmdName))
    return node;
  try {
    aliasExpansionStack.add(cmdName);
    const parser = new Parser();
    let fullCommand = aliasValue;
    const expandNext = aliasValue.endsWith(" ");
    if (!expandNext) {
      for (const arg of node.args) {
        const argLiteral = wordNodeToString(arg);
        fullCommand += ` ${argLiteral}`;
      }
    }
    let expandedAst;
    try {
      expandedAst = parser.parse(fullCommand);
    } catch (e) {
      if (e instanceof ParseException) {
        throw e;
      }
      return node;
    }
    if (expandedAst.statements.length !== 1 || expandedAst.statements[0].pipelines.length !== 1 || expandedAst.statements[0].pipelines[0].commands.length !== 1) {
      return handleComplexAlias(node, aliasValue);
    }
    const expandedCmd = expandedAst.statements[0].pipelines[0].commands[0];
    if (expandedCmd.type !== "SimpleCommand") {
      return handleComplexAlias(node, aliasValue);
    }
    let newNode = {
      ...expandedCmd,
      // Preserve original assignments (prefix assignments like FOO=bar alias_cmd)
      assignments: [...node.assignments, ...expandedCmd.assignments],
      // Preserve original redirections
      redirections: [...expandedCmd.redirections, ...node.redirections],
      // Preserve line number
      line: node.line
    };
    if (expandNext && node.args.length > 0) {
      newNode = {
        ...newNode,
        args: [...newNode.args, ...node.args]
      };
      if (newNode.args.length > 0) {
        const firstArg = newNode.args[0];
        if (isLiteralUnquotedWord(firstArg)) {
          const firstArgName = getLiteralValue(firstArg);
          if (firstArgName && getAlias(ctx, firstArgName)) {
            const tempNode = {
              type: "SimpleCommand",
              name: firstArg,
              args: newNode.args.slice(1),
              assignments: [],
              redirections: []
            };
            const expandedFirst = expandAlias(ctx, tempNode, aliasExpansionStack);
            if (expandedFirst !== tempNode) {
              newNode = {
                ...newNode,
                name: expandedFirst.name,
                args: [...expandedFirst.args]
              };
            }
          }
        }
      }
    }
    return newNode;
  } catch (e) {
    aliasExpansionStack.delete(cmdName);
    throw e;
  }
}
__name(expandAlias, "expandAlias");
function handleComplexAlias(node, aliasValue) {
  let fullCommand = aliasValue;
  for (const arg of node.args) {
    const argLiteral = wordNodeToString(arg);
    fullCommand += ` ${argLiteral}`;
  }
  const parser = new Parser();
  const evalWord = parser.parseWordFromString("eval", false, false);
  const cmdWord = parser.parseWordFromString(`'${fullCommand.replace(/'/g, "'\\''")}'`, false, false);
  return {
    type: "SimpleCommand",
    name: evalWord,
    args: [cmdWord],
    assignments: node.assignments,
    redirections: node.redirections,
    line: node.line
  };
}
__name(handleComplexAlias, "handleComplexAlias");
function wordNodeToString(word) {
  let result2 = "";
  for (const part of word.parts) {
    switch (part.type) {
      case "Literal":
        result2 += part.value.replace(/([\s"'$`\\*?[\]{}()<>|&;#!])/g, "\\$1");
        break;
      case "SingleQuoted":
        result2 += `'${part.value}'`;
        break;
      case "DoubleQuoted":
        result2 += `"${part.parts.map((p) => p.type === "Literal" ? p.value : `$${p.type}`).join("")}"`;
        break;
      case "ParameterExpansion":
        result2 += `\${${part.parameter}}`;
        break;
      case "CommandSubstitution":
        result2 += `$(...)`;
        break;
      case "ArithmeticExpansion":
        result2 += `$((${part.expression}))`;
        break;
      case "Glob":
        result2 += part.pattern;
        break;
      default:
        break;
    }
  }
  return result2;
}
__name(wordNodeToString, "wordNodeToString");

// dist/interpreter/assignment-expansion.js
async function expandLocalArrayAssignment(ctx, word) {
  const fullLiteral = word.parts.map((p) => p.type === "Literal" ? p.value : "\0").join("");
  const arrayMatch = fullLiteral.match(/^([a-zA-Z_][a-zA-Z0-9_]*)=\(/);
  if (!arrayMatch || !fullLiteral.endsWith(")")) {
    return null;
  }
  const name = arrayMatch[1];
  const elements = [];
  let inArrayContent = false;
  let pendingLiteral = "";
  let hasQuotedContent = false;
  for (const part of word.parts) {
    if (part.type === "Literal") {
      let value = part.value;
      if (!inArrayContent) {
        const idx = value.indexOf("=(");
        if (idx !== -1) {
          inArrayContent = true;
          value = value.slice(idx + 2);
        }
      }
      if (inArrayContent) {
        if (value.endsWith(")")) {
          value = value.slice(0, -1);
        }
        const tokens = value.split(/(\s+)/);
        for (const token of tokens) {
          if (/^\s+$/.test(token)) {
            if (pendingLiteral || hasQuotedContent) {
              elements.push(pendingLiteral);
              pendingLiteral = "";
              hasQuotedContent = false;
            }
          } else if (token) {
            pendingLiteral += token;
          }
        }
      }
    } else if (inArrayContent) {
      if (part.type === "BraceExpansion") {
        const isKeyedElement = /^\[.+\]=/.test(pendingLiteral);
        if (isKeyedElement) {
          pendingLiteral += wordToLiteralString({
            type: "Word",
            parts: [part]
          });
        } else {
          if (pendingLiteral || hasQuotedContent) {
            elements.push(pendingLiteral);
            pendingLiteral = "";
            hasQuotedContent = false;
          }
          const braceExpanded = await expandWordWithGlob(ctx, {
            type: "Word",
            parts: [part]
          });
          elements.push(...braceExpanded.values);
        }
      } else {
        if (part.type === "SingleQuoted" || part.type === "DoubleQuoted" || part.type === "Escaped") {
          hasQuotedContent = true;
        }
        const expanded = await expandWord(ctx, {
          type: "Word",
          parts: [part]
        });
        pendingLiteral += expanded;
      }
    }
  }
  if (pendingLiteral || hasQuotedContent) {
    elements.push(pendingLiteral);
  }
  const quotedElements = elements.map((elem) => {
    if (/^\[.+\]=/.test(elem)) {
      return elem;
    }
    if (elem === "") {
      return "''";
    }
    if (/[\s"'\\$`!*?[\]{}|&;<>()]/.test(elem) && !elem.startsWith("'") && !elem.startsWith('"')) {
      return `'${elem.replace(/'/g, "'\\''")}'`;
    }
    return elem;
  });
  return `${name}=(${quotedElements.join(" ")})`;
}
__name(expandLocalArrayAssignment, "expandLocalArrayAssignment");
async function expandScalarAssignmentArg(ctx, word) {
  let eqPartIndex = -1;
  let eqCharIndex = -1;
  let isAppend = false;
  for (let i = 0; i < word.parts.length; i++) {
    const part = word.parts[i];
    if (part.type === "Literal") {
      const appendIdx = part.value.indexOf("+=");
      if (appendIdx !== -1) {
        const before = part.value.slice(0, appendIdx);
        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(before)) {
          eqPartIndex = i;
          eqCharIndex = appendIdx;
          isAppend = true;
          break;
        }
        if (/^[a-zA-Z_][a-zA-Z0-9_]*\[[^\]]+\]$/.test(before)) {
          eqPartIndex = i;
          eqCharIndex = appendIdx;
          isAppend = true;
          break;
        }
      }
      const eqIdx = part.value.indexOf("=");
      if (eqIdx !== -1 && (eqIdx === 0 || part.value[eqIdx - 1] !== "+")) {
        const before = part.value.slice(0, eqIdx);
        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(before) || /^[a-zA-Z_][a-zA-Z0-9_]*\[[^\]]+\]$/.test(before)) {
          eqPartIndex = i;
          eqCharIndex = eqIdx;
          break;
        }
      }
    }
  }
  if (eqPartIndex === -1) {
    return null;
  }
  const nameParts = word.parts.slice(0, eqPartIndex);
  const eqPart = word.parts[eqPartIndex];
  if (eqPart.type !== "Literal") {
    return null;
  }
  const operatorLen = isAppend ? 2 : 1;
  const nameFromEqPart = eqPart.value.slice(0, eqCharIndex);
  const valueFromEqPart = eqPart.value.slice(eqCharIndex + operatorLen);
  const valueParts = word.parts.slice(eqPartIndex + 1);
  let name = "";
  for (const part of nameParts) {
    name += await expandWord(ctx, { type: "Word", parts: [part] });
  }
  name += nameFromEqPart;
  const valueWord = {
    type: "Word",
    parts: valueFromEqPart !== "" ? [{ type: "Literal", value: valueFromEqPart }, ...valueParts] : valueParts
  };
  const value = valueWord.parts.length > 0 ? await expandWord(ctx, valueWord) : "";
  const operator = isAppend ? "+=" : "=";
  return `${name}${operator}${value}`;
}
__name(expandScalarAssignmentArg, "expandScalarAssignmentArg");

// dist/commands/browser-excluded.js
var BROWSER_EXCLUDED_COMMANDS = [
  "tar",
  // Uses native compression modules (@mongodb-js/zstd, node-liblzma, compressjs)
  "yq",
  // Requires fast-xml-parser and other Node.js-specific parsing
  "xan",
  // Complex CSV/data processing with Node.js dependencies
  "sqlite3",
  // Uses sql.js (WASM) which requires Node.js worker threads
  "python3",
  // Uses Pyodide (WASM) which requires Node.js worker threads
  "python"
  // Alias for python3
];
function isBrowserExcludedCommand(commandName) {
  return BROWSER_EXCLUDED_COMMANDS.includes(commandName);
}
__name(isBrowserExcludedCommand, "isBrowserExcludedCommand");

// dist/interpreter/helpers/result.js
var OK = Object.freeze({
  stdout: "",
  stderr: "",
  exitCode: 0
});
function success(stdout = "") {
  return { stdout, stderr: "", exitCode: 0 };
}
__name(success, "success");
function failure(stderr, exitCode = 1) {
  return { stdout: "", stderr, exitCode };
}
__name(failure, "failure");
function result(stdout, stderr, exitCode) {
  return { stdout, stderr, exitCode };
}
__name(result, "result");
function testResult(passed) {
  return { stdout: "", stderr: "", exitCode: passed ? 0 : 1 };
}
__name(testResult, "testResult");
function throwExecutionLimit(message, limitType, stdout = "", stderr = "") {
  throw new ExecutionLimitError(message, limitType, stdout, stderr);
}
__name(throwExecutionLimit, "throwExecutionLimit");

// dist/interpreter/builtins/break.js
function handleBreak(ctx, args) {
  if (ctx.state.loopDepth === 0) {
    if (ctx.state.parentHasLoopContext) {
      throw new SubshellExitError();
    }
    return OK;
  }
  if (args.length > 1) {
    throw new ExitError(1, "", "bash: break: too many arguments\n");
  }
  let levels = 1;
  if (args.length > 0) {
    const n = Number.parseInt(args[0], 10);
    if (Number.isNaN(n) || n < 1) {
      throw new ExitError(128, "", `bash: break: ${args[0]}: numeric argument required
`);
    }
    levels = n;
  }
  throw new BreakError(levels);
}
__name(handleBreak, "handleBreak");

// dist/interpreter/builtins/cd.js
async function handleCd(ctx, args) {
  let target;
  let printPath = false;
  let physical = false;
  let i = 0;
  while (i < args.length) {
    if (args[i] === "--") {
      i++;
      break;
    } else if (args[i] === "-L") {
      physical = false;
      i++;
    } else if (args[i] === "-P") {
      physical = true;
      i++;
    } else if (args[i].startsWith("-") && args[i] !== "-") {
      i++;
    } else {
      break;
    }
  }
  const remainingArgs = args.slice(i);
  if (remainingArgs.length === 0) {
    target = ctx.state.env.HOME || "/";
  } else if (remainingArgs[0] === "~") {
    target = ctx.state.env.HOME || "/";
  } else if (remainingArgs[0] === "-") {
    target = ctx.state.previousDir;
    printPath = true;
  } else {
    target = remainingArgs[0];
  }
  if (!target.startsWith("/") && !target.startsWith("./") && !target.startsWith("../") && target !== "." && target !== "..") {
    const cdpath = ctx.state.env.CDPATH;
    if (cdpath) {
      const cdpathDirs = cdpath.split(":").filter((d) => d);
      for (const dir of cdpathDirs) {
        const candidate = dir.startsWith("/") ? `${dir}/${target}` : `${ctx.state.cwd}/${dir}/${target}`;
        try {
          const stat = await ctx.fs.stat(candidate);
          if (stat.isDirectory) {
            target = candidate;
            printPath = true;
            break;
          }
        } catch {
        }
      }
    }
  }
  const pathToCheck = target.startsWith("/") ? target : `${ctx.state.cwd}/${target}`;
  const parts = pathToCheck.split("/").filter((p) => p && p !== ".");
  let currentPath = "";
  for (const part of parts) {
    if (part === "..") {
      currentPath = currentPath.split("/").slice(0, -1).join("/") || "/";
    } else {
      currentPath = currentPath ? `${currentPath}/${part}` : `/${part}`;
      try {
        const stat = await ctx.fs.stat(currentPath);
        if (!stat.isDirectory) {
          return failure(`bash: cd: ${target}: Not a directory
`);
        }
      } catch {
        return failure(`bash: cd: ${target}: No such file or directory
`);
      }
    }
  }
  let newDir = currentPath || "/";
  if (physical) {
    try {
      newDir = await ctx.fs.realpath(newDir);
    } catch {
    }
  }
  ctx.state.previousDir = ctx.state.cwd;
  ctx.state.cwd = newDir;
  ctx.state.env.PWD = ctx.state.cwd;
  ctx.state.env.OLDPWD = ctx.state.previousDir;
  return success(printPath ? `${newDir}
` : "");
}
__name(handleCd, "handleCd");

// dist/interpreter/helpers/file-tests.js
function resolvePath(ctx, path) {
  return ctx.fs.resolvePath(ctx.state.cwd, path);
}
__name(resolvePath, "resolvePath");
var FILE_TEST_OPERATORS = [
  "-e",
  // file exists
  "-a",
  // file exists (deprecated synonym for -e)
  "-f",
  // regular file
  "-d",
  // directory
  "-r",
  // readable
  "-w",
  // writable
  "-x",
  // executable
  "-s",
  // file exists and has size > 0
  "-L",
  // symbolic link
  "-h",
  // symbolic link (synonym for -L)
  "-k",
  // sticky bit set
  "-g",
  // setgid bit set
  "-u",
  // setuid bit set
  "-G",
  // owned by effective group ID
  "-O",
  // owned by effective user ID
  "-b",
  // block special file
  "-c",
  // character special file
  "-p",
  // named pipe (FIFO)
  "-S",
  // socket
  "-t",
  // file descriptor is open and refers to a terminal
  "-N"
  // file has been modified since last read
];
function isFileTestOperator(op) {
  return FILE_TEST_OPERATORS.includes(op);
}
__name(isFileTestOperator, "isFileTestOperator");
async function evaluateFileTest(ctx, operator, operand) {
  const path = resolvePath(ctx, operand);
  switch (operator) {
    case "-e":
    case "-a":
      return ctx.fs.exists(path);
    case "-f": {
      if (await ctx.fs.exists(path)) {
        const stat = await ctx.fs.stat(path);
        return stat.isFile;
      }
      return false;
    }
    case "-d": {
      if (await ctx.fs.exists(path)) {
        const stat = await ctx.fs.stat(path);
        return stat.isDirectory;
      }
      return false;
    }
    case "-r": {
      if (await ctx.fs.exists(path)) {
        const stat = await ctx.fs.stat(path);
        return (stat.mode & 256) !== 0;
      }
      return false;
    }
    case "-w": {
      if (await ctx.fs.exists(path)) {
        const stat = await ctx.fs.stat(path);
        return (stat.mode & 128) !== 0;
      }
      return false;
    }
    case "-x": {
      if (await ctx.fs.exists(path)) {
        const stat = await ctx.fs.stat(path);
        return (stat.mode & 64) !== 0;
      }
      return false;
    }
    case "-s": {
      if (await ctx.fs.exists(path)) {
        const stat = await ctx.fs.stat(path);
        return stat.size > 0;
      }
      return false;
    }
    case "-L":
    case "-h": {
      try {
        const stat = await ctx.fs.lstat(path);
        return stat.isSymbolicLink;
      } catch {
        return false;
      }
    }
    case "-k": {
      if (await ctx.fs.exists(path)) {
        const stat = await ctx.fs.stat(path);
        return (stat.mode & 512) !== 0;
      }
      return false;
    }
    case "-g": {
      if (await ctx.fs.exists(path)) {
        const stat = await ctx.fs.stat(path);
        return (stat.mode & 1024) !== 0;
      }
      return false;
    }
    case "-u": {
      if (await ctx.fs.exists(path)) {
        const stat = await ctx.fs.stat(path);
        return (stat.mode & 2048) !== 0;
      }
      return false;
    }
    case "-G":
    case "-O":
      return ctx.fs.exists(path);
    case "-b":
      return false;
    case "-c": {
      const charDevices = [
        "/dev/null",
        "/dev/zero",
        "/dev/random",
        "/dev/urandom",
        "/dev/tty",
        "/dev/stdin",
        "/dev/stdout",
        "/dev/stderr"
      ];
      return charDevices.some((dev) => path === dev || path.endsWith(dev));
    }
    case "-p":
      return false;
    case "-S":
      return false;
    case "-t":
      return false;
    case "-N": {
      return ctx.fs.exists(path);
    }
    default:
      return false;
  }
}
__name(evaluateFileTest, "evaluateFileTest");
var BINARY_FILE_TEST_OPERATORS = ["-nt", "-ot", "-ef"];
function isBinaryFileTestOperator(op) {
  return BINARY_FILE_TEST_OPERATORS.includes(op);
}
__name(isBinaryFileTestOperator, "isBinaryFileTestOperator");
async function evaluateBinaryFileTest(ctx, operator, left, right) {
  const leftPath = resolvePath(ctx, left);
  const rightPath = resolvePath(ctx, right);
  switch (operator) {
    case "-nt": {
      try {
        const leftStat = await ctx.fs.stat(leftPath);
        const rightStat = await ctx.fs.stat(rightPath);
        return leftStat.mtime > rightStat.mtime;
      } catch {
        return false;
      }
    }
    case "-ot": {
      try {
        const leftStat = await ctx.fs.stat(leftPath);
        const rightStat = await ctx.fs.stat(rightPath);
        return leftStat.mtime < rightStat.mtime;
      } catch {
        return false;
      }
    }
    case "-ef": {
      try {
        if (!await ctx.fs.exists(leftPath) || !await ctx.fs.exists(rightPath)) {
          return false;
        }
        const leftReal = ctx.fs.resolvePath(ctx.state.cwd, leftPath);
        const rightReal = ctx.fs.resolvePath(ctx.state.cwd, rightPath);
        return leftReal === rightReal;
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}
__name(evaluateBinaryFileTest, "evaluateBinaryFileTest");

// dist/interpreter/helpers/numeric-compare.js
var NUMERIC_OPS = /* @__PURE__ */ new Set(["-eq", "-ne", "-lt", "-le", "-gt", "-ge"]);
function isNumericOp(op) {
  return NUMERIC_OPS.has(op);
}
__name(isNumericOp, "isNumericOp");
function compareNumeric(op, left, right) {
  switch (op) {
    case "-eq":
      return left === right;
    case "-ne":
      return left !== right;
    case "-lt":
      return left < right;
    case "-le":
      return left <= right;
    case "-gt":
      return left > right;
    case "-ge":
      return left >= right;
  }
}
__name(compareNumeric, "compareNumeric");

// dist/interpreter/helpers/string-compare.js
function isStringCompareOp(op) {
  return op === "=" || op === "==" || op === "!=";
}
__name(isStringCompareOp, "isStringCompareOp");
function compareStrings(op, left, right, usePattern = false, nocasematch = false, extglob = false) {
  if (usePattern) {
    const isEqual2 = matchPattern(left, right, nocasematch, extglob);
    return op === "!=" ? !isEqual2 : isEqual2;
  }
  if (nocasematch) {
    const isEqual2 = left.toLowerCase() === right.toLowerCase();
    return op === "!=" ? !isEqual2 : isEqual2;
  }
  const isEqual = left === right;
  return op === "!=" ? !isEqual : isEqual;
}
__name(compareStrings, "compareStrings");

// dist/interpreter/helpers/string-tests.js
var STRING_TEST_OPS = /* @__PURE__ */ new Set(["-z", "-n"]);
function isStringTestOp(op) {
  return STRING_TEST_OPS.has(op);
}
__name(isStringTestOp, "isStringTestOp");
function evaluateStringTest(op, value) {
  switch (op) {
    case "-z":
      return value === "";
    case "-n":
      return value !== "";
  }
}
__name(evaluateStringTest, "evaluateStringTest");

// dist/interpreter/helpers/variable-tests.js
async function evaluateVariableTest(ctx, operand) {
  const arrayMatch = operand.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[(.+)\]$/);
  if (arrayMatch) {
    const arrayName = arrayMatch[1];
    const indexExpr = arrayMatch[2];
    const isAssoc = ctx.state.associativeArrays?.has(arrayName);
    if (isAssoc) {
      let key = indexExpr;
      if (key.startsWith("'") && key.endsWith("'") || key.startsWith('"') && key.endsWith('"')) {
        key = key.slice(1, -1);
      }
      key = key.replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, varName) => {
        return ctx.state.env[varName] || "";
      });
      return `${arrayName}_${key}` in ctx.state.env;
    }
    let index;
    try {
      const parser = new Parser();
      const arithAst = parseArithmeticExpression(parser, indexExpr);
      index = await evaluateArithmetic(ctx, arithAst.expression);
    } catch {
      if (/^-?\d+$/.test(indexExpr)) {
        index = Number.parseInt(indexExpr, 10);
      } else {
        const varValue = ctx.state.env[indexExpr];
        index = varValue ? Number.parseInt(varValue, 10) : 0;
      }
    }
    if (index < 0) {
      const indices = getArrayIndices(ctx, arrayName);
      const lineNum = ctx.state.currentLine;
      if (indices.length === 0) {
        ctx.state.expansionStderr = (ctx.state.expansionStderr || "") + `bash: line ${lineNum}: ${arrayName}: bad array subscript
`;
        return false;
      }
      const maxIndex = Math.max(...indices);
      index = maxIndex + 1 + index;
      if (index < 0) {
        ctx.state.expansionStderr = (ctx.state.expansionStderr || "") + `bash: line ${lineNum}: ${arrayName}: bad array subscript
`;
        return false;
      }
    }
    return `${arrayName}_${index}` in ctx.state.env;
  }
  if (operand in ctx.state.env) {
    return true;
  }
  if (ctx.state.associativeArrays?.has(operand)) {
    return getAssocArrayKeys(ctx, operand).length > 0;
  }
  return getArrayIndices(ctx, operand).length > 0;
}
__name(evaluateVariableTest, "evaluateVariableTest");

// dist/interpreter/conditionals.js
async function evaluateConditional(ctx, expr) {
  switch (expr.type) {
    case "CondBinary": {
      const left = await expandWord(ctx, expr.left);
      const isRhsQuoted = expr.right.parts.length > 0 && expr.right.parts.every((p) => p.type === "SingleQuoted" || p.type === "DoubleQuoted" || // Escaped counts as quoted for pattern matching, but NOT for regex
      p.type === "Escaped" && expr.operator !== "=~");
      let right;
      if (expr.operator === "=~") {
        if (isRhsQuoted) {
          const expanded = await expandWord(ctx, expr.right);
          right = escapeRegexChars(expanded);
        } else {
          right = await expandWordForRegex(ctx, expr.right);
        }
      } else if (isStringCompareOp(expr.operator) && !isRhsQuoted) {
        right = await expandWordForPattern(ctx, expr.right);
      } else {
        right = await expandWord(ctx, expr.right);
      }
      if (isStringCompareOp(expr.operator)) {
        const nocasematch = ctx.state.shoptOptions.nocasematch;
        return compareStrings(expr.operator, left, right, !isRhsQuoted, nocasematch, true);
      }
      if (isNumericOp(expr.operator)) {
        return compareNumeric(expr.operator, await evalArithExpr(ctx, left), await evalArithExpr(ctx, right));
      }
      if (isBinaryFileTestOperator(expr.operator)) {
        return evaluateBinaryFileTest(ctx, expr.operator, left, right);
      }
      switch (expr.operator) {
        case "=~": {
          try {
            const nocasematch = ctx.state.shoptOptions.nocasematch;
            const jsPattern = posixEreToJsRegex(right);
            const regex = new RegExp(jsPattern, nocasematch ? "i" : "");
            const match = left.match(regex);
            clearArray(ctx, "BASH_REMATCH");
            if (match) {
              for (let i = 0; i < match.length; i++) {
                ctx.state.env[`BASH_REMATCH_${i}`] = match[i] || "";
              }
            }
            return match !== null;
          } catch {
            throw new Error("syntax error in regular expression");
          }
        }
        case "<":
          return left < right;
        case ">":
          return left > right;
        default:
          return false;
      }
    }
    case "CondUnary": {
      const operand = await expandWord(ctx, expr.operand);
      if (isFileTestOperator(expr.operator)) {
        return evaluateFileTest(ctx, expr.operator, operand);
      }
      if (isStringTestOp(expr.operator)) {
        return evaluateStringTest(expr.operator, operand);
      }
      if (expr.operator === "-v") {
        return await evaluateVariableTest(ctx, operand);
      }
      if (expr.operator === "-o") {
        return evaluateShellOption(ctx, operand);
      }
      return false;
    }
    case "CondNot": {
      if (ctx.state.shoptOptions.extglob) {
        if (expr.operand.type === "CondGroup" && expr.operand.expression.type === "CondWord") {
          const innerValue = await expandWord(ctx, expr.operand.expression.word);
          const extglobPattern = `!(${innerValue})`;
          return extglobPattern !== "";
        }
      }
      return !await evaluateConditional(ctx, expr.operand);
    }
    case "CondAnd": {
      const left = await evaluateConditional(ctx, expr.left);
      if (!left)
        return false;
      return await evaluateConditional(ctx, expr.right);
    }
    case "CondOr": {
      const left = await evaluateConditional(ctx, expr.left);
      if (left)
        return true;
      return await evaluateConditional(ctx, expr.right);
    }
    case "CondGroup":
      return await evaluateConditional(ctx, expr.expression);
    case "CondWord": {
      const value = await expandWord(ctx, expr.word);
      return value !== "";
    }
    default:
      return false;
  }
}
__name(evaluateConditional, "evaluateConditional");
async function evaluateTestArgs(ctx, args) {
  if (args.length === 0) {
    return result("", "", 1);
  }
  if (args.length === 1) {
    return testResult(Boolean(args[0]));
  }
  if (args.length === 2) {
    const op = args[0];
    const operand = args[1];
    if (op === "(") {
      return failure("test: '(' without matching ')'\n", 2);
    }
    if (isFileTestOperator(op)) {
      return testResult(await evaluateFileTest(ctx, op, operand));
    }
    if (isStringTestOp(op)) {
      return testResult(evaluateStringTest(op, operand));
    }
    if (op === "!") {
      return testResult(!operand);
    }
    if (op === "-v") {
      return testResult(await evaluateVariableTest(ctx, operand));
    }
    if (op === "-o") {
      return testResult(evaluateShellOption(ctx, operand));
    }
    if (op === "=" || op === "==" || op === "!=" || op === "<" || op === ">" || op === "-eq" || op === "-ne" || op === "-lt" || op === "-le" || op === "-gt" || op === "-ge" || op === "-nt" || op === "-ot" || op === "-ef") {
      return failure(`test: ${op}: unary operator expected
`, 2);
    }
    return result("", "", 1);
  }
  if (args.length === 3) {
    const left = args[0];
    const op = args[1];
    const right = args[2];
    if (isStringCompareOp(op)) {
      return testResult(compareStrings(op, left, right));
    }
    if (isNumericOp(op)) {
      const leftNum = parseNumericDecimal(left);
      const rightNum = parseNumericDecimal(right);
      if (!leftNum.valid || !rightNum.valid) {
        return result("", "", 2);
      }
      return testResult(compareNumeric(op, leftNum.value, rightNum.value));
    }
    if (isBinaryFileTestOperator(op)) {
      return testResult(await evaluateBinaryFileTest(ctx, op, left, right));
    }
    switch (op) {
      case "-a":
        return testResult(left !== "" && right !== "");
      case "-o":
        return testResult(left !== "" || right !== "");
      case ">":
        return testResult(left > right);
      case "<":
        return testResult(left < right);
    }
    if (left === "!") {
      const negResult = await evaluateTestArgs(ctx, [op, right]);
      return result("", negResult.stderr, negResult.exitCode === 0 ? 1 : negResult.exitCode === 1 ? 0 : negResult.exitCode);
    }
    if (left === "(" && right === ")") {
      return testResult(op !== "");
    }
  }
  if (args.length === 4) {
    if (args[0] === "!") {
      const negResult = await evaluateTestArgs(ctx, args.slice(1));
      return result("", negResult.stderr, negResult.exitCode === 0 ? 1 : negResult.exitCode === 1 ? 0 : negResult.exitCode);
    }
    if (args[0] === "(" && args[3] === ")") {
      return evaluateTestArgs(ctx, [args[1], args[2]]);
    }
  }
  const exprResult = await evaluateTestExpr(ctx, args, 0);
  if (exprResult.pos < args.length) {
    return failure("test: too many arguments\n", 2);
  }
  return testResult(exprResult.value);
}
__name(evaluateTestArgs, "evaluateTestArgs");
async function evaluateTestExpr(ctx, args, pos) {
  return evaluateTestOr(ctx, args, pos);
}
__name(evaluateTestExpr, "evaluateTestExpr");
async function evaluateTestOr(ctx, args, pos) {
  let { value, pos: newPos } = await evaluateTestAnd(ctx, args, pos);
  while (args[newPos] === "-o") {
    const right = await evaluateTestAnd(ctx, args, newPos + 1);
    value = value || right.value;
    newPos = right.pos;
  }
  return { value, pos: newPos };
}
__name(evaluateTestOr, "evaluateTestOr");
async function evaluateTestAnd(ctx, args, pos) {
  let { value, pos: newPos } = await evaluateTestNot(ctx, args, pos);
  while (args[newPos] === "-a") {
    const right = await evaluateTestNot(ctx, args, newPos + 1);
    value = value && right.value;
    newPos = right.pos;
  }
  return { value, pos: newPos };
}
__name(evaluateTestAnd, "evaluateTestAnd");
async function evaluateTestNot(ctx, args, pos) {
  if (args[pos] === "!") {
    const { value, pos: newPos } = await evaluateTestNot(ctx, args, pos + 1);
    return { value: !value, pos: newPos };
  }
  return evaluateTestPrimary(ctx, args, pos);
}
__name(evaluateTestNot, "evaluateTestNot");
async function evaluateTestPrimary(ctx, args, pos) {
  const token = args[pos];
  if (token === "(") {
    const { value, pos: newPos } = await evaluateTestExpr(ctx, args, pos + 1);
    return { value, pos: args[newPos] === ")" ? newPos + 1 : newPos };
  }
  const next = args[pos + 1];
  if (isStringCompareOp(next)) {
    const left = token;
    const right = args[pos + 2] ?? "";
    return { value: compareStrings(next, left, right), pos: pos + 3 };
  }
  if (isNumericOp(next)) {
    const leftParsed = parseNumericDecimal(token);
    const rightParsed = parseNumericDecimal(args[pos + 2] ?? "0");
    if (!leftParsed.valid || !rightParsed.valid) {
      return { value: false, pos: pos + 3 };
    }
    const value = compareNumeric(next, leftParsed.value, rightParsed.value);
    return { value, pos: pos + 3 };
  }
  if (isBinaryFileTestOperator(next)) {
    const left = token;
    const right = args[pos + 2] ?? "";
    const value = await evaluateBinaryFileTest(ctx, next, left, right);
    return { value, pos: pos + 3 };
  }
  if (isFileTestOperator(token)) {
    const operand = args[pos + 1] ?? "";
    const value = await evaluateFileTest(ctx, token, operand);
    return { value, pos: pos + 2 };
  }
  if (isStringTestOp(token)) {
    const operand = args[pos + 1] ?? "";
    return { value: evaluateStringTest(token, operand), pos: pos + 2 };
  }
  if (token === "-v") {
    const varName = args[pos + 1] ?? "";
    const value = await evaluateVariableTest(ctx, varName);
    return { value, pos: pos + 2 };
  }
  if (token === "-o") {
    const optName = args[pos + 1] ?? "";
    const value = evaluateShellOption(ctx, optName);
    return { value, pos: pos + 2 };
  }
  return { value: token !== void 0 && token !== "", pos: pos + 1 };
}
__name(evaluateTestPrimary, "evaluateTestPrimary");
function matchPattern(value, pattern, nocasematch = false, extglob = false) {
  const regex = `^${patternToRegexStr(pattern, extglob)}$`;
  const flags = nocasematch ? "is" : "s";
  return new RegExp(regex, flags).test(value);
}
__name(matchPattern, "matchPattern");
function patternToRegexStr(pattern, extglob) {
  let regex = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (extglob && (char === "@" || char === "*" || char === "+" || char === "?" || char === "!") && i + 1 < pattern.length && pattern[i + 1] === "(") {
      const closeIdx = findMatchingParen(pattern, i + 1);
      if (closeIdx !== -1) {
        const content = pattern.slice(i + 2, closeIdx);
        const alternatives = splitExtglobAlternatives(content);
        const altRegexes = alternatives.map((alt) => patternToRegexStr(alt, extglob));
        const altGroup = altRegexes.length > 0 ? altRegexes.join("|") : "(?:)";
        if (char === "@") {
          regex += `(?:${altGroup})`;
        } else if (char === "*") {
          regex += `(?:${altGroup})*`;
        } else if (char === "+") {
          regex += `(?:${altGroup})+`;
        } else if (char === "?") {
          regex += `(?:${altGroup})?`;
        } else if (char === "!") {
          const hasMorePattern = closeIdx < pattern.length - 1;
          if (hasMorePattern) {
            const lengths = alternatives.map((alt) => computePatternLength(alt, extglob));
            const allSameLength = lengths.every((l) => l !== null) && lengths.every((l) => l === lengths[0]);
            if (allSameLength && lengths[0] !== null) {
              const n = lengths[0];
              if (n === 0) {
                regex += "(?:.+)";
              } else {
                const parts = [];
                if (n > 0) {
                  parts.push(`.{0,${n - 1}}`);
                }
                parts.push(`.{${n + 1},}`);
                parts.push(`(?!(?:${altGroup})).{${n}}`);
                regex += `(?:${parts.join("|")})`;
              }
            } else {
              regex += `(?:(?!(?:${altGroup})).)*?`;
            }
          } else {
            regex += `(?!(?:${altGroup})$).*`;
          }
        }
        i = closeIdx;
        continue;
      }
    }
    if (char === "\\") {
      if (i + 1 < pattern.length) {
        const next = pattern[i + 1];
        if (/[\\^$.|+(){}[\]*?]/.test(next)) {
          regex += `\\${next}`;
        } else {
          regex += next;
        }
        i++;
      } else {
        regex += "\\\\";
      }
    } else if (char === "*") {
      regex += ".*";
    } else if (char === "?") {
      regex += ".";
    } else if (char === "[") {
      const closeIdx = pattern.indexOf("]", i + 1);
      if (closeIdx !== -1) {
        regex += pattern.slice(i, closeIdx + 1);
        i = closeIdx;
      } else {
        regex += "\\[";
      }
    } else if (/[\\^$.|+(){}]/.test(char)) {
      regex += `\\${char}`;
    } else {
      regex += char;
    }
  }
  return regex;
}
__name(patternToRegexStr, "patternToRegexStr");
function findMatchingParen(pattern, openIdx) {
  let depth = 1;
  let i = openIdx + 1;
  while (i < pattern.length && depth > 0) {
    const c = pattern[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "(") {
      depth++;
    } else if (c === ")") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
    i++;
  }
  return -1;
}
__name(findMatchingParen, "findMatchingParen");
function splitExtglobAlternatives(content) {
  const alternatives = [];
  let current = "";
  let depth = 0;
  let i = 0;
  while (i < content.length) {
    const c = content[i];
    if (c === "\\") {
      current += c;
      if (i + 1 < content.length) {
        current += content[i + 1];
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    if (c === "(") {
      depth++;
      current += c;
    } else if (c === ")") {
      depth--;
      current += c;
    } else if (c === "|" && depth === 0) {
      alternatives.push(current);
      current = "";
    } else {
      current += c;
    }
    i++;
  }
  alternatives.push(current);
  return alternatives;
}
__name(splitExtglobAlternatives, "splitExtglobAlternatives");
function computePatternLength(pattern, extglob) {
  let length = 0;
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (extglob && (c === "@" || c === "*" || c === "+" || c === "?" || c === "!") && i + 1 < pattern.length && pattern[i + 1] === "(") {
      const closeIdx = findMatchingParen(pattern, i + 1);
      if (closeIdx !== -1) {
        if (c === "@") {
          const content = pattern.slice(i + 2, closeIdx);
          const alts = splitExtglobAlternatives(content);
          const altLengths = alts.map((a) => computePatternLength(a, extglob));
          if (altLengths.every((l) => l !== null) && altLengths.every((l) => l === altLengths[0])) {
            length += altLengths[0];
            i = closeIdx + 1;
            continue;
          }
          return null;
        }
        return null;
      }
    }
    if (c === "*") {
      return null;
    }
    if (c === "?") {
      length += 1;
      i++;
      continue;
    }
    if (c === "[") {
      const closeIdx = pattern.indexOf("]", i + 1);
      if (closeIdx !== -1) {
        length += 1;
        i = closeIdx + 1;
        continue;
      }
      length += 1;
      i++;
      continue;
    }
    if (c === "\\") {
      length += 1;
      i += 2;
      continue;
    }
    length += 1;
    i++;
  }
  return length;
}
__name(computePatternLength, "computePatternLength");
function evaluateShellOption(ctx, option) {
  const optionMap = {
    // Implemented options (set -o)
    errexit: /* @__PURE__ */ __name(() => ctx.state.options.errexit === true, "errexit"),
    nounset: /* @__PURE__ */ __name(() => ctx.state.options.nounset === true, "nounset"),
    pipefail: /* @__PURE__ */ __name(() => ctx.state.options.pipefail === true, "pipefail"),
    xtrace: /* @__PURE__ */ __name(() => ctx.state.options.xtrace === true, "xtrace"),
    // Single-letter aliases for implemented options
    e: /* @__PURE__ */ __name(() => ctx.state.options.errexit === true, "e"),
    u: /* @__PURE__ */ __name(() => ctx.state.options.nounset === true, "u"),
    x: /* @__PURE__ */ __name(() => ctx.state.options.xtrace === true, "x")
  };
  const getter = optionMap[option];
  if (getter) {
    return getter();
  }
  return false;
}
__name(evaluateShellOption, "evaluateShellOption");
async function evalArithExpr(ctx, expr) {
  expr = expr.trim();
  if (expr === "")
    return 0;
  if (/^[+-]?(\d+#[a-zA-Z0-9@_]+|0[xX][0-9a-fA-F]+|0[0-7]+|\d+)$/.test(expr)) {
    return parseNumeric(expr);
  }
  try {
    const parser = new Parser();
    const arithAst = parseArithmeticExpression(parser, expr);
    return await evaluateArithmetic(ctx, arithAst.expression);
  } catch {
    return parseNumeric(expr);
  }
}
__name(evalArithExpr, "evalArithExpr");
function parseBaseN(digits, base) {
  let result2 = 0;
  for (const char of digits) {
    let digitValue;
    if (char >= "0" && char <= "9") {
      digitValue = char.charCodeAt(0) - 48;
    } else if (char >= "a" && char <= "z") {
      digitValue = char.charCodeAt(0) - 97 + 10;
    } else if (char >= "A" && char <= "Z") {
      digitValue = char.charCodeAt(0) - 65 + 36;
    } else if (char === "@") {
      digitValue = 62;
    } else if (char === "_") {
      digitValue = 63;
    } else {
      return Number.NaN;
    }
    if (digitValue >= base) {
      return Number.NaN;
    }
    result2 = result2 * base + digitValue;
  }
  return result2;
}
__name(parseBaseN, "parseBaseN");
function parseNumeric(value) {
  value = value.trim();
  if (value === "")
    return 0;
  let negative = false;
  if (value.startsWith("-")) {
    negative = true;
    value = value.slice(1);
  } else if (value.startsWith("+")) {
    value = value.slice(1);
  }
  let result2;
  const baseMatch = value.match(/^(\d+)#([a-zA-Z0-9@_]+)$/);
  if (baseMatch) {
    const base = Number.parseInt(baseMatch[1], 10);
    if (base >= 2 && base <= 64) {
      result2 = parseBaseN(baseMatch[2], base);
    } else {
      result2 = 0;
    }
  } else if (/^0[xX][0-9a-fA-F]+$/.test(value)) {
    result2 = Number.parseInt(value, 16);
  } else if (/^0[0-7]+$/.test(value)) {
    result2 = Number.parseInt(value, 8);
  } else {
    result2 = Number.parseInt(value, 10);
  }
  if (Number.isNaN(result2)) {
    result2 = 0;
  }
  return negative ? -result2 : result2;
}
__name(parseNumeric, "parseNumeric");
function parseNumericDecimal(value) {
  value = value.trim();
  if (value === "")
    return { value: 0, valid: true };
  let negative = false;
  if (value.startsWith("-")) {
    negative = true;
    value = value.slice(1);
  } else if (value.startsWith("+")) {
    value = value.slice(1);
  }
  if (!/^\d+$/.test(value)) {
    return { value: 0, valid: false };
  }
  const result2 = Number.parseInt(value, 10);
  if (Number.isNaN(result2)) {
    return { value: 0, valid: false };
  }
  return { value: negative ? -result2 : result2, valid: true };
}
__name(parseNumericDecimal, "parseNumericDecimal");
function posixEreToJsRegex(pattern) {
  let result2 = "";
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === "\\" && i + 1 < pattern.length) {
      result2 += pattern[i] + pattern[i + 1];
      i += 2;
    } else if (pattern[i] === "[") {
      const classResult = convertPosixCharClass(pattern, i);
      result2 += classResult.converted;
      i = classResult.endIndex;
    } else {
      result2 += pattern[i];
      i++;
    }
  }
  return result2;
}
__name(posixEreToJsRegex, "posixEreToJsRegex");
function convertPosixCharClass(pattern, startIndex) {
  let i = startIndex + 1;
  let result2 = "[";
  if (i < pattern.length && (pattern[i] === "^" || pattern[i] === "!")) {
    result2 += "^";
    i++;
  }
  let hasLiteralCloseBracket = false;
  if (i < pattern.length && pattern[i] === "]") {
    hasLiteralCloseBracket = true;
    i++;
  }
  let hasLiteralOpenBracket = false;
  if (i < pattern.length && pattern[i] === "[" && i + 1 < pattern.length && pattern[i + 1] !== ":") {
    hasLiteralOpenBracket = true;
    i++;
  }
  let classContent = "";
  let foundClose = false;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "]") {
      foundClose = true;
      i++;
      break;
    }
    if (ch === "[" && i + 1 < pattern.length && pattern[i + 1] === ":") {
      const endPos = pattern.indexOf(":]", i + 2);
      if (endPos !== -1) {
        const className = pattern.slice(i + 2, endPos);
        classContent += posixClassToJsClass(className);
        i = endPos + 2;
        continue;
      }
    }
    if (ch === "[" && i + 1 < pattern.length) {
      const next = pattern[i + 1];
      if (next === "." || next === "=") {
        const endMarker = `${next}]`;
        const endPos = pattern.indexOf(endMarker, i + 2);
        if (endPos !== -1) {
          const content = pattern.slice(i + 2, endPos);
          classContent += content;
          i = endPos + 2;
          continue;
        }
      }
    }
    if (ch === "\\" && i + 1 < pattern.length) {
      classContent += ch + pattern[i + 1];
      i += 2;
      continue;
    }
    classContent += ch;
    i++;
  }
  if (!foundClose) {
    return { converted: "\\[", endIndex: startIndex + 1 };
  }
  if (hasLiteralCloseBracket) {
    result2 += "\\]";
  }
  if (hasLiteralOpenBracket) {
    result2 += "\\[";
  }
  result2 += classContent;
  result2 += "]";
  return { converted: result2, endIndex: i };
}
__name(convertPosixCharClass, "convertPosixCharClass");
function posixClassToJsClass(className) {
  const mapping = {
    alnum: "a-zA-Z0-9",
    alpha: "a-zA-Z",
    ascii: "\\x00-\\x7F",
    blank: " \\t",
    cntrl: "\\x00-\\x1F\\x7F",
    digit: "0-9",
    graph: "!-~",
    lower: "a-z",
    print: " -~",
    punct: "!-/:-@\\[-`{-~",
    space: " \\t\\n\\r\\f\\v",
    upper: "A-Z",
    word: "a-zA-Z0-9_",
    xdigit: "0-9A-Fa-f"
  };
  return mapping[className] ?? "";
}
__name(posixClassToJsClass, "posixClassToJsClass");

// dist/interpreter/builtins/declare-array-parsing.js
function parseArrayElements(content) {
  const elements = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;
  let hasContent = false;
  for (const char of content) {
    if (escaped) {
      current += char;
      escaped = false;
      hasContent = true;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "'" && !inDoubleQuote) {
      if (!inSingleQuote) {
        hasContent = true;
      }
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (char === '"' && !inSingleQuote) {
      if (!inDoubleQuote) {
        hasContent = true;
      }
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if ((char === " " || char === "	" || char === "\n") && !inSingleQuote && !inDoubleQuote) {
      if (hasContent) {
        elements.push(current);
        current = "";
        hasContent = false;
      }
      continue;
    }
    current += char;
    hasContent = true;
  }
  if (hasContent) {
    elements.push(current);
  }
  return elements;
}
__name(parseArrayElements, "parseArrayElements");
function parseAssocArrayLiteral(content) {
  const entries = [];
  let pos = 0;
  while (pos < content.length) {
    while (pos < content.length && /\s/.test(content[pos])) {
      pos++;
    }
    if (pos >= content.length)
      break;
    if (content[pos] !== "[") {
      pos++;
      continue;
    }
    pos++;
    let key = "";
    if (content[pos] === "'" || content[pos] === '"') {
      const quote = content[pos];
      pos++;
      while (pos < content.length && content[pos] !== quote) {
        key += content[pos];
        pos++;
      }
      if (content[pos] === quote)
        pos++;
    } else {
      while (pos < content.length && content[pos] !== "]" && content[pos] !== "=") {
        key += content[pos];
        pos++;
      }
    }
    while (pos < content.length && content[pos] !== "]") {
      pos++;
    }
    if (content[pos] === "]")
      pos++;
    if (content[pos] !== "=")
      continue;
    pos++;
    let value = "";
    if (content[pos] === "'" || content[pos] === '"') {
      const quote = content[pos];
      pos++;
      while (pos < content.length && content[pos] !== quote) {
        if (content[pos] === "\\" && pos + 1 < content.length) {
          pos++;
          value += content[pos];
        } else {
          value += content[pos];
        }
        pos++;
      }
      if (content[pos] === quote)
        pos++;
    } else {
      while (pos < content.length && !/\s/.test(content[pos])) {
        value += content[pos];
        pos++;
      }
    }
    entries.push([key, value]);
  }
  return entries;
}
__name(parseAssocArrayLiteral, "parseAssocArrayLiteral");

// dist/interpreter/builtins/variable-assignment.js
function parseAssignment(arg) {
  const arrayMatch = arg.match(/^([a-zA-Z_][a-zA-Z0-9_]*)=\((.*)\)$/s);
  if (arrayMatch) {
    return {
      name: arrayMatch[1],
      isArray: true,
      arrayElements: parseArrayElements(arrayMatch[2])
    };
  }
  const indexMatch = arg.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[([^\]]+)\]=(.*)$/s);
  if (indexMatch) {
    return {
      name: indexMatch[1],
      isArray: false,
      arrayIndex: indexMatch[2],
      value: indexMatch[3]
    };
  }
  if (arg.includes("=")) {
    const eqIdx = arg.indexOf("=");
    return {
      name: arg.slice(0, eqIdx),
      isArray: false,
      value: arg.slice(eqIdx + 1)
    };
  }
  return {
    name: arg,
    isArray: false
  };
}
__name(parseAssignment, "parseAssignment");
async function evaluateArrayIndex(ctx, indexExpr) {
  try {
    const parser = new Parser();
    const arithAst = parseArithmeticExpression(parser, indexExpr);
    return await evaluateArithmetic(ctx, arithAst.expression);
  } catch {
    const num = parseInt(indexExpr, 10);
    return Number.isNaN(num) ? 0 : num;
  }
}
__name(evaluateArrayIndex, "evaluateArrayIndex");
async function setVariable(ctx, assignment, options = {}) {
  const { name, isArray: isArray2, arrayElements, value, arrayIndex } = assignment;
  const { makeReadonly = false, checkReadonly = true } = options;
  if (checkReadonly) {
    const error = checkReadonlyError(ctx, name);
    if (error)
      return error;
  }
  if (isArray2 && arrayElements) {
    for (let i = 0; i < arrayElements.length; i++) {
      ctx.state.env[`${name}_${i}`] = arrayElements[i];
    }
    ctx.state.env[`${name}__length`] = String(arrayElements.length);
  } else if (arrayIndex !== void 0 && value !== void 0) {
    const index = await evaluateArrayIndex(ctx, arrayIndex);
    ctx.state.env[`${name}_${index}`] = value;
    const currentLength = parseInt(ctx.state.env[`${name}__length`] ?? "0", 10);
    if (index >= currentLength) {
      ctx.state.env[`${name}__length`] = String(index + 1);
    }
  } else if (value !== void 0) {
    ctx.state.env[name] = value;
  }
  if (makeReadonly) {
    markReadonly(ctx, name);
  }
  return null;
}
__name(setVariable, "setVariable");
function markLocalVarDepth(ctx, name) {
  ctx.state.localVarDepth = ctx.state.localVarDepth || /* @__PURE__ */ new Map();
  ctx.state.localVarDepth.set(name, ctx.state.callDepth);
}
__name(markLocalVarDepth, "markLocalVarDepth");
function getLocalVarDepth(ctx, name) {
  return ctx.state.localVarDepth?.get(name);
}
__name(getLocalVarDepth, "getLocalVarDepth");
function clearLocalVarDepth(ctx, name) {
  ctx.state.localVarDepth?.delete(name);
}
__name(clearLocalVarDepth, "clearLocalVarDepth");
function pushLocalVarStack(ctx, name, currentValue) {
  ctx.state.localVarStack = ctx.state.localVarStack || /* @__PURE__ */ new Map();
  const stack = ctx.state.localVarStack.get(name) || [];
  stack.push({
    value: currentValue,
    scopeIndex: ctx.state.localScopes.length - 1
  });
  ctx.state.localVarStack.set(name, stack);
}
__name(pushLocalVarStack, "pushLocalVarStack");
function popLocalVarStack(ctx, name) {
  const stack = ctx.state.localVarStack?.get(name);
  if (!stack || stack.length === 0) {
    return void 0;
  }
  return stack.pop();
}
__name(popLocalVarStack, "popLocalVarStack");
function clearLocalVarStackForScope(ctx, scopeIndex) {
  if (!ctx.state.localVarStack)
    return;
  for (const [name, stack] of ctx.state.localVarStack.entries()) {
    while (stack.length > 0 && stack[stack.length - 1].scopeIndex === scopeIndex) {
      stack.pop();
    }
    if (stack.length === 0) {
      ctx.state.localVarStack.delete(name);
    }
  }
}
__name(clearLocalVarStackForScope, "clearLocalVarStackForScope");

// dist/interpreter/helpers/shell-constants.js
var POSIX_SPECIAL_BUILTINS = /* @__PURE__ */ new Set([
  ":",
  ".",
  "break",
  "continue",
  "eval",
  "exec",
  "exit",
  "export",
  "readonly",
  "return",
  "set",
  "shift",
  "trap",
  "unset"
]);
function isPosixSpecialBuiltin(name) {
  return POSIX_SPECIAL_BUILTINS.has(name);
}
__name(isPosixSpecialBuiltin, "isPosixSpecialBuiltin");
var SHELL_KEYWORDS = /* @__PURE__ */ new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "case",
  "esac",
  "for",
  "select",
  "while",
  "until",
  "do",
  "done",
  "in",
  "function",
  "{",
  "}",
  "time",
  "[[",
  "]]",
  "!"
]);
var SHELL_BUILTINS = /* @__PURE__ */ new Set([
  ":",
  "true",
  "false",
  "cd",
  "export",
  "unset",
  "exit",
  "local",
  "set",
  "break",
  "continue",
  "return",
  "eval",
  "shift",
  "getopts",
  "compgen",
  "complete",
  "compopt",
  "pushd",
  "popd",
  "dirs",
  "source",
  ".",
  "read",
  "mapfile",
  "readarray",
  "declare",
  "typeset",
  "readonly",
  "let",
  "command",
  "shopt",
  "exec",
  "test",
  "[",
  "echo",
  "printf",
  "pwd",
  "alias",
  "unalias",
  "type",
  "hash",
  "ulimit",
  "umask",
  "trap",
  "times",
  "wait",
  "kill",
  "jobs",
  "fg",
  "bg",
  "disown",
  "suspend",
  "fc",
  "history",
  "help",
  "enable",
  "builtin",
  "caller"
]);

// dist/interpreter/redirections.js
async function checkOutputRedirectTarget(ctx, filePath, target, options) {
  try {
    const stat = await ctx.fs.stat(filePath);
    if (stat.isDirectory) {
      return `bash: ${target}: Is a directory
`;
    }
    if (options.checkNoclobber && ctx.state.options.noclobber && !options.isClobber && target !== "/dev/null") {
      return `bash: ${target}: cannot overwrite existing file
`;
    }
  } catch {
  }
  return null;
}
__name(checkOutputRedirectTarget, "checkOutputRedirectTarget");
function getFileEncoding(content) {
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) > 255) {
      return "utf8";
    }
  }
  return "binary";
}
__name(getFileEncoding, "getFileEncoding");
function parseRwFdContent(fdContent) {
  if (!fdContent.startsWith("__rw__:")) {
    return null;
  }
  const afterPrefix = fdContent.slice(7);
  const firstColonIdx = afterPrefix.indexOf(":");
  if (firstColonIdx === -1)
    return null;
  const pathLength = Number.parseInt(afterPrefix.slice(0, firstColonIdx), 10);
  if (Number.isNaN(pathLength) || pathLength < 0)
    return null;
  const pathStart = firstColonIdx + 1;
  const path = afterPrefix.slice(pathStart, pathStart + pathLength);
  const positionStart = pathStart + pathLength + 1;
  const remaining = afterPrefix.slice(positionStart);
  const posColonIdx = remaining.indexOf(":");
  if (posColonIdx === -1)
    return null;
  const position = Number.parseInt(remaining.slice(0, posColonIdx), 10);
  if (Number.isNaN(position) || position < 0)
    return null;
  const content = remaining.slice(posColonIdx + 1);
  return { path, position, content };
}
__name(parseRwFdContent, "parseRwFdContent");
async function preExpandRedirectTargets(ctx, redirections) {
  const targets = /* @__PURE__ */ new Map();
  for (let i = 0; i < redirections.length; i++) {
    const redir = redirections[i];
    if (redir.target.type === "HereDoc") {
      continue;
    }
    const isFdRedirect = redir.operator === ">&" || redir.operator === "<&";
    if (isFdRedirect) {
      if (hasQuotedMultiValueAt(ctx, redir.target)) {
        return { targets, error: "bash: $@: ambiguous redirect\n" };
      }
      targets.set(i, await expandWord(ctx, redir.target));
    } else {
      const expandResult = await expandRedirectTarget(ctx, redir.target);
      if ("error" in expandResult) {
        return { targets, error: expandResult.error };
      }
      targets.set(i, expandResult.target);
    }
  }
  return { targets };
}
__name(preExpandRedirectTargets, "preExpandRedirectTargets");
function allocateFd(ctx) {
  if (ctx.state.nextFd === void 0) {
    ctx.state.nextFd = 10;
  }
  const fd = ctx.state.nextFd;
  ctx.state.nextFd++;
  return fd;
}
__name(allocateFd, "allocateFd");
async function processFdVariableRedirections(ctx, redirections) {
  for (const redir of redirections) {
    if (!redir.fdVariable) {
      continue;
    }
    if (!ctx.state.fileDescriptors) {
      ctx.state.fileDescriptors = /* @__PURE__ */ new Map();
    }
    if ((redir.operator === ">&" || redir.operator === "<&") && redir.target.type === "Word") {
      const target = await expandWord(ctx, redir.target);
      if (target === "-") {
        const existingFd = ctx.state.env[redir.fdVariable];
        if (existingFd !== void 0) {
          const fdNum = Number.parseInt(existingFd, 10);
          if (!Number.isNaN(fdNum)) {
            ctx.state.fileDescriptors.delete(fdNum);
          }
        }
        continue;
      }
    }
    const fd = allocateFd(ctx);
    ctx.state.env[redir.fdVariable] = String(fd);
    if (redir.target.type === "Word") {
      const target = await expandWord(ctx, redir.target);
      if (redir.operator === ">&" || redir.operator === "<&") {
        const sourceFd = Number.parseInt(target, 10);
        if (!Number.isNaN(sourceFd)) {
          const content = ctx.state.fileDescriptors.get(sourceFd);
          if (content !== void 0) {
            ctx.state.fileDescriptors.set(fd, content);
          }
          continue;
        }
      }
      if (redir.operator === ">" || redir.operator === ">>" || redir.operator === ">|" || redir.operator === "&>" || redir.operator === "&>>") {
        const filePath = ctx.fs.resolvePath(ctx.state.cwd, target);
        if (redir.operator === ">" || redir.operator === ">|" || redir.operator === "&>") {
          await ctx.fs.writeFile(filePath, "", "binary");
        }
        ctx.state.fileDescriptors.set(fd, `__file__:${filePath}`);
      } else if (redir.operator === "<<<") {
        ctx.state.fileDescriptors.set(fd, `${target}
`);
      } else if (redir.operator === "<" || redir.operator === "<>") {
        try {
          const filePath = ctx.fs.resolvePath(ctx.state.cwd, target);
          const content = await ctx.fs.readFile(filePath);
          ctx.state.fileDescriptors.set(fd, content);
        } catch {
          return result("", `bash: ${target}: No such file or directory
`, 1);
        }
      }
    }
  }
  return null;
}
__name(processFdVariableRedirections, "processFdVariableRedirections");
async function preOpenOutputRedirects(ctx, redirections) {
  for (const redir of redirections) {
    if (redir.target.type === "HereDoc") {
      continue;
    }
    const isGreaterAmpersand = redir.operator === ">&";
    if (redir.operator !== ">" && redir.operator !== ">|" && redir.operator !== "&>" && !isGreaterAmpersand) {
      continue;
    }
    let target;
    if (isGreaterAmpersand) {
      target = await expandWord(ctx, redir.target);
      if (target === "-" || !Number.isNaN(Number.parseInt(target, 10)) || redir.fd != null) {
        continue;
      }
    } else {
      const expandResult = await expandRedirectTarget(ctx, redir.target);
      if ("error" in expandResult) {
        return result("", expandResult.error, 1);
      }
      target = expandResult.target;
    }
    const filePath = ctx.fs.resolvePath(ctx.state.cwd, target);
    const isClobber = redir.operator === ">|";
    try {
      const stat = await ctx.fs.stat(filePath);
      if (stat.isDirectory) {
        return result("", `bash: ${target}: Is a directory
`, 1);
      }
      if (ctx.state.options.noclobber && !isClobber && !stat.isDirectory && target !== "/dev/null") {
        return result("", `bash: ${target}: cannot overwrite existing file
`, 1);
      }
    } catch {
    }
    if (target !== "/dev/null" && target !== "/dev/stdout" && target !== "/dev/stderr" && target !== "/dev/full") {
      await ctx.fs.writeFile(filePath, "", "binary");
    }
    if (target === "/dev/full") {
      return result("", `bash: /dev/full: No space left on device
`, 1);
    }
  }
  return null;
}
__name(preOpenOutputRedirects, "preOpenOutputRedirects");
async function applyRedirections(ctx, result2, redirections, preExpandedTargets) {
  let { stdout, stderr, exitCode } = result2;
  for (let i = 0; i < redirections.length; i++) {
    const redir = redirections[i];
    if (redir.target.type === "HereDoc") {
      continue;
    }
    let target;
    const preExpanded = preExpandedTargets?.get(i);
    if (preExpanded !== void 0) {
      target = preExpanded;
    } else {
      const isFdRedirect = redir.operator === ">&" || redir.operator === "<&";
      if (isFdRedirect) {
        if (hasQuotedMultiValueAt(ctx, redir.target)) {
          stderr += "bash: $@: ambiguous redirect\n";
          exitCode = 1;
          stdout = "";
          continue;
        }
        target = await expandWord(ctx, redir.target);
      } else {
        const expandResult = await expandRedirectTarget(ctx, redir.target);
        if ("error" in expandResult) {
          stderr += expandResult.error;
          exitCode = 1;
          stdout = "";
          continue;
        }
        target = expandResult.target;
      }
    }
    if (redir.fdVariable) {
      continue;
    }
    switch (redir.operator) {
      case ">":
      case ">|": {
        const fd = redir.fd ?? 1;
        const isClobber = redir.operator === ">|";
        if (fd === 1) {
          if (target === "/dev/stdout") {
            break;
          }
          if (target === "/dev/stderr") {
            stderr += stdout;
            stdout = "";
            break;
          }
          if (target === "/dev/full") {
            stderr += `bash: echo: write error: No space left on device
`;
            exitCode = 1;
            stdout = "";
            break;
          }
          const filePath = ctx.fs.resolvePath(ctx.state.cwd, target);
          const error = await checkOutputRedirectTarget(ctx, filePath, target, {
            checkNoclobber: true,
            isClobber
          });
          if (error) {
            stderr += error;
            exitCode = 1;
            stdout = "";
            break;
          }
          await ctx.fs.writeFile(filePath, stdout, getFileEncoding(stdout));
          stdout = "";
        } else if (fd === 2) {
          if (target === "/dev/stderr") {
            break;
          }
          if (target === "/dev/stdout") {
            stdout += stderr;
            stderr = "";
            break;
          }
          if (target === "/dev/full") {
            stderr += `bash: echo: write error: No space left on device
`;
            exitCode = 1;
            break;
          }
          if (target === "/dev/null") {
            stderr = "";
          } else {
            const filePath = ctx.fs.resolvePath(ctx.state.cwd, target);
            const error = await checkOutputRedirectTarget(ctx, filePath, target, {
              checkNoclobber: true,
              isClobber
            });
            if (error) {
              stderr += error;
              exitCode = 1;
              break;
            }
            await ctx.fs.writeFile(filePath, stderr, getFileEncoding(stderr));
            stderr = "";
          }
        }
        break;
      }
      case ">>": {
        const fd = redir.fd ?? 1;
        if (fd === 1) {
          if (target === "/dev/stdout") {
            break;
          }
          if (target === "/dev/stderr") {
            stderr += stdout;
            stdout = "";
            break;
          }
          if (target === "/dev/full") {
            stderr += `bash: echo: write error: No space left on device
`;
            exitCode = 1;
            stdout = "";
            break;
          }
          const filePath = ctx.fs.resolvePath(ctx.state.cwd, target);
          const error = await checkOutputRedirectTarget(ctx, filePath, target, {});
          if (error) {
            stderr += error;
            exitCode = 1;
            stdout = "";
            break;
          }
          await ctx.fs.appendFile(filePath, stdout, getFileEncoding(stdout));
          stdout = "";
        } else if (fd === 2) {
          if (target === "/dev/stderr") {
            break;
          }
          if (target === "/dev/stdout") {
            stdout += stderr;
            stderr = "";
            break;
          }
          if (target === "/dev/full") {
            stderr += `bash: echo: write error: No space left on device
`;
            exitCode = 1;
            break;
          }
          const filePath2 = ctx.fs.resolvePath(ctx.state.cwd, target);
          const error2 = await checkOutputRedirectTarget(ctx, filePath2, target, {});
          if (error2) {
            stderr += error2;
            exitCode = 1;
            break;
          }
          await ctx.fs.appendFile(filePath2, stderr, getFileEncoding(stderr));
          stderr = "";
        }
        break;
      }
      case ">&":
      case "<&": {
        const fd = redir.fd ?? 1;
        if (target === "-") {
          break;
        }
        if (target.endsWith("-")) {
          const sourceFdStr = target.slice(0, -1);
          const sourceFd = Number.parseInt(sourceFdStr, 10);
          if (!Number.isNaN(sourceFd)) {
            const sourceInfo = ctx.state.fileDescriptors?.get(sourceFd);
            if (sourceInfo !== void 0) {
              if (!ctx.state.fileDescriptors) {
                ctx.state.fileDescriptors = /* @__PURE__ */ new Map();
              }
              ctx.state.fileDescriptors.set(fd, sourceInfo);
              if (sourceFd >= 3) {
                ctx.state.fileDescriptors?.delete(sourceFd);
              }
            } else if (sourceFd === 1 || sourceFd === 2) {
              if (!ctx.state.fileDescriptors) {
                ctx.state.fileDescriptors = /* @__PURE__ */ new Map();
              }
              ctx.state.fileDescriptors.set(fd, `__dupout__:${sourceFd}`);
            } else if (sourceFd === 0) {
              if (!ctx.state.fileDescriptors) {
                ctx.state.fileDescriptors = /* @__PURE__ */ new Map();
              }
              ctx.state.fileDescriptors.set(fd, `__dupin__:${sourceFd}`);
            } else if (sourceFd >= 3) {
              stderr += `bash: ${sourceFd}: Bad file descriptor
`;
              exitCode = 1;
            }
          }
          break;
        }
        if (target === "2" || target === "&2") {
          if (fd === 1) {
            stderr += stdout;
            stdout = "";
          }
        } else if (target === "1" || target === "&1") {
          if (fd === 2) {
            stdout += stderr;
            stderr = "";
          } else {
            stdout += stderr;
            stderr = "";
          }
        } else {
          const targetFd = Number.parseInt(target, 10);
          if (!Number.isNaN(targetFd)) {
            const fdInfo = ctx.state.fileDescriptors?.get(targetFd);
            if (fdInfo?.startsWith("__file__:")) {
              const resolvedPath = fdInfo.slice(9);
              if (fd === 1) {
                await ctx.fs.appendFile(resolvedPath, stdout, getFileEncoding(stdout));
                stdout = "";
              } else if (fd === 2) {
                await ctx.fs.appendFile(resolvedPath, stderr, getFileEncoding(stderr));
                stderr = "";
              }
            } else if (fdInfo?.startsWith("__rw__:")) {
              const parsed = parseRwFdContent(fdInfo);
              if (parsed) {
                if (fd === 1) {
                  await ctx.fs.appendFile(parsed.path, stdout, getFileEncoding(stdout));
                  stdout = "";
                } else if (fd === 2) {
                  await ctx.fs.appendFile(parsed.path, stderr, getFileEncoding(stderr));
                  stderr = "";
                }
              }
            } else if (fdInfo?.startsWith("__dupout__:")) {
              const sourceFd = Number.parseInt(fdInfo.slice(11), 10);
              if (sourceFd === 1) {
              } else if (sourceFd === 2) {
                if (fd === 1) {
                  stderr += stdout;
                  stdout = "";
                }
              } else {
                const sourceInfo = ctx.state.fileDescriptors?.get(sourceFd);
                if (sourceInfo?.startsWith("__file__:")) {
                  const resolvedPath = sourceInfo.slice(9);
                  if (fd === 1) {
                    await ctx.fs.appendFile(resolvedPath, stdout, getFileEncoding(stdout));
                    stdout = "";
                  } else if (fd === 2) {
                    await ctx.fs.appendFile(resolvedPath, stderr, getFileEncoding(stderr));
                    stderr = "";
                  }
                }
              }
            } else if (fdInfo?.startsWith("__dupin__:")) {
              stderr += `bash: ${targetFd}: Bad file descriptor
`;
              exitCode = 1;
              stdout = "";
            } else if (targetFd >= 3) {
              stderr += `bash: ${targetFd}: Bad file descriptor
`;
              exitCode = 1;
              stdout = "";
            }
          } else if (redir.operator === ">&") {
            const filePath = ctx.fs.resolvePath(ctx.state.cwd, target);
            const error = await checkOutputRedirectTarget(ctx, filePath, target, {
              checkNoclobber: true
            });
            if (error) {
              stderr = error;
              exitCode = 1;
              stdout = "";
              break;
            }
            if (redir.fd == null) {
              const combined = stdout + stderr;
              await ctx.fs.writeFile(filePath, combined, getFileEncoding(combined));
              stdout = "";
              stderr = "";
            } else if (fd === 1) {
              await ctx.fs.writeFile(filePath, stdout, getFileEncoding(stdout));
              stdout = "";
            } else if (fd === 2) {
              await ctx.fs.writeFile(filePath, stderr, getFileEncoding(stderr));
              stderr = "";
            }
          }
        }
        break;
      }
      case "&>": {
        if (target === "/dev/full") {
          stderr = `bash: echo: write error: No space left on device
`;
          exitCode = 1;
          stdout = "";
          break;
        }
        const filePath = ctx.fs.resolvePath(ctx.state.cwd, target);
        const error = await checkOutputRedirectTarget(ctx, filePath, target, {
          checkNoclobber: true
        });
        if (error) {
          stderr = error;
          exitCode = 1;
          stdout = "";
          break;
        }
        const combined = stdout + stderr;
        await ctx.fs.writeFile(filePath, combined, getFileEncoding(combined));
        stdout = "";
        stderr = "";
        break;
      }
      case "&>>": {
        if (target === "/dev/full") {
          stderr = `bash: echo: write error: No space left on device
`;
          exitCode = 1;
          stdout = "";
          break;
        }
        const filePath = ctx.fs.resolvePath(ctx.state.cwd, target);
        const error = await checkOutputRedirectTarget(ctx, filePath, target, {});
        if (error) {
          stderr = error;
          exitCode = 1;
          stdout = "";
          break;
        }
        const combined = stdout + stderr;
        await ctx.fs.appendFile(filePath, combined, getFileEncoding(combined));
        stdout = "";
        stderr = "";
        break;
      }
    }
  }
  const fd1Info = ctx.state.fileDescriptors?.get(1);
  if (fd1Info) {
    if (fd1Info === "__dupout__:2") {
      stderr += stdout;
      stdout = "";
    } else if (fd1Info.startsWith("__file__:")) {
      const filePath = fd1Info.slice(9);
      await ctx.fs.appendFile(filePath, stdout, getFileEncoding(stdout));
      stdout = "";
    } else if (fd1Info.startsWith("__file_append__:")) {
      const filePath = fd1Info.slice(16);
      await ctx.fs.appendFile(filePath, stdout, getFileEncoding(stdout));
      stdout = "";
    }
  }
  const fd2Info = ctx.state.fileDescriptors?.get(2);
  if (fd2Info) {
    if (fd2Info === "__dupout__:1") {
      stdout += stderr;
      stderr = "";
    } else if (fd2Info.startsWith("__file__:")) {
      const filePath = fd2Info.slice(9);
      await ctx.fs.appendFile(filePath, stderr, getFileEncoding(stderr));
      stderr = "";
    } else if (fd2Info.startsWith("__file_append__:")) {
      const filePath = fd2Info.slice(16);
      await ctx.fs.appendFile(filePath, stderr, getFileEncoding(stderr));
      stderr = "";
    }
  }
  return result(stdout, stderr, exitCode);
}
__name(applyRedirections, "applyRedirections");

// dist/interpreter/functions.js
function executeFunctionDef(ctx, node) {
  if (ctx.state.options.posix && POSIX_SPECIAL_BUILTINS.has(node.name)) {
    const stderr = `bash: line ${ctx.state.currentLine}: \`${node.name}': is a special builtin
`;
    throw new ExitError(2, "", stderr);
  }
  const funcWithSource = {
    ...node,
    sourceFile: node.sourceFile ?? ctx.state.currentSource ?? "main"
  };
  ctx.state.functions.set(node.name, funcWithSource);
  return OK;
}
__name(executeFunctionDef, "executeFunctionDef");
async function processInputRedirections(ctx, redirections) {
  let stdin = "";
  for (const redir of redirections) {
    if ((redir.operator === "<<" || redir.operator === "<<-") && redir.target.type === "HereDoc") {
      const hereDoc = redir.target;
      let content = await expandWord(ctx, hereDoc.content);
      if (hereDoc.stripTabs) {
        content = content.split("\n").map((line) => line.replace(/^\t+/, "")).join("\n");
      }
      const fd = redir.fd ?? 0;
      if (fd === 0) {
        stdin = content;
      }
    } else if (redir.operator === "<<<" && redir.target.type === "Word") {
      stdin = `${await expandWord(ctx, redir.target)}
`;
    } else if (redir.operator === "<" && redir.target.type === "Word") {
      const target = await expandWord(ctx, redir.target);
      const filePath = ctx.fs.resolvePath(ctx.state.cwd, target);
      try {
        stdin = await ctx.fs.readFile(filePath);
      } catch {
      }
    }
  }
  return stdin;
}
__name(processInputRedirections, "processInputRedirections");
async function callFunction(ctx, func, args, stdin = "", callLine) {
  ctx.state.callDepth++;
  if (ctx.state.callDepth > ctx.limits.maxCallDepth) {
    ctx.state.callDepth--;
    throwExecutionLimit(`${func.name}: maximum recursion depth (${ctx.limits.maxCallDepth}) exceeded, increase executionLimits.maxCallDepth`, "recursion");
  }
  if (!ctx.state.funcNameStack) {
    ctx.state.funcNameStack = [];
  }
  if (!ctx.state.callLineStack) {
    ctx.state.callLineStack = [];
  }
  if (!ctx.state.sourceStack) {
    ctx.state.sourceStack = [];
  }
  ctx.state.funcNameStack.unshift(func.name);
  ctx.state.callLineStack.unshift(callLine ?? ctx.state.currentLine);
  ctx.state.sourceStack.unshift(func.sourceFile ?? "main");
  ctx.state.localScopes.push(/* @__PURE__ */ new Map());
  if (!ctx.state.localExportedVars) {
    ctx.state.localExportedVars = [];
  }
  ctx.state.localExportedVars.push(/* @__PURE__ */ new Set());
  const savedPositional = {};
  for (let i = 0; i < args.length; i++) {
    savedPositional[String(i + 1)] = ctx.state.env[String(i + 1)];
    ctx.state.env[String(i + 1)] = args[i];
  }
  savedPositional["@"] = ctx.state.env["@"];
  savedPositional["#"] = ctx.state.env["#"];
  ctx.state.env["@"] = args.join(" ");
  ctx.state.env["#"] = String(args.length);
  const cleanup = /* @__PURE__ */ __name(() => {
    const scopeIndex = ctx.state.localScopes.length - 1;
    const localScope = ctx.state.localScopes.pop();
    if (localScope) {
      for (const [varName, originalValue] of localScope) {
        if (originalValue === void 0) {
          delete ctx.state.env[varName];
        } else {
          ctx.state.env[varName] = originalValue;
        }
      }
    }
    clearLocalVarStackForScope(ctx, scopeIndex);
    if (ctx.state.fullyUnsetLocals) {
      for (const [name, entryScope] of ctx.state.fullyUnsetLocals.entries()) {
        if (entryScope === scopeIndex) {
          ctx.state.fullyUnsetLocals.delete(name);
        }
      }
    }
    if (ctx.state.localExportedVars && ctx.state.localExportedVars.length > 0) {
      const localExports = ctx.state.localExportedVars.pop();
      if (localExports) {
        for (const name of localExports) {
          ctx.state.exportedVars?.delete(name);
        }
      }
    }
    for (const [key, value] of Object.entries(savedPositional)) {
      if (value === void 0) {
        delete ctx.state.env[key];
      } else {
        ctx.state.env[key] = value;
      }
    }
    ctx.state.funcNameStack?.shift();
    ctx.state.callLineStack?.shift();
    ctx.state.sourceStack?.shift();
    ctx.state.callDepth--;
  }, "cleanup");
  const { targets: preExpandedTargets, error: expandError } = await preExpandRedirectTargets(ctx, func.redirections);
  if (expandError) {
    cleanup();
    return result("", expandError, 1);
  }
  try {
    const redirectionStdin = await processInputRedirections(ctx, func.redirections);
    const effectiveStdin = stdin || redirectionStdin;
    const execResult = await ctx.executeCommand(func.body, effectiveStdin);
    cleanup();
    return applyRedirections(ctx, execResult, func.redirections, preExpandedTargets);
  } catch (error) {
    cleanup();
    if (error instanceof ReturnError) {
      const returnResult = result(error.stdout, error.stderr, error.exitCode);
      return applyRedirections(ctx, returnResult, func.redirections, preExpandedTargets);
    }
    throw error;
  }
}
__name(callFunction, "callFunction");

// dist/interpreter/builtins/compgen.js
var SHELL_KEYWORDS2 = [
  "!",
  "[[",
  "]]",
  "case",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "fi",
  "for",
  "function",
  "if",
  "in",
  "then",
  "time",
  "until",
  "while",
  "{",
  "}"
];
var SHELL_BUILTINS2 = [
  ".",
  ":",
  "[",
  "alias",
  "bg",
  "bind",
  "break",
  "builtin",
  "caller",
  "cd",
  "command",
  "compgen",
  "complete",
  "compopt",
  "continue",
  "declare",
  "dirs",
  "disown",
  "echo",
  "enable",
  "eval",
  "exec",
  "exit",
  "export",
  "false",
  "fc",
  "fg",
  "getopts",
  "hash",
  "help",
  "history",
  "jobs",
  "kill",
  "let",
  "local",
  "logout",
  "mapfile",
  "popd",
  "printf",
  "pushd",
  "pwd",
  "read",
  "readarray",
  "readonly",
  "return",
  "set",
  "shift",
  "shopt",
  "source",
  "suspend",
  "test",
  "times",
  "trap",
  "true",
  "type",
  "typeset",
  "ulimit",
  "umask",
  "unalias",
  "unset",
  "wait"
];
var SHOPT_OPTIONS = [
  "autocd",
  "assoc_expand_once",
  "cdable_vars",
  "cdspell",
  "checkhash",
  "checkjobs",
  "checkwinsize",
  "cmdhist",
  "compat31",
  "compat32",
  "compat40",
  "compat41",
  "compat42",
  "compat43",
  "compat44",
  "complete_fullquote",
  "direxpand",
  "dirspell",
  "dotglob",
  "execfail",
  "expand_aliases",
  "extdebug",
  "extglob",
  "extquote",
  "failglob",
  "force_fignore",
  "globasciiranges",
  "globstar",
  "gnu_errfmt",
  "histappend",
  "histreedit",
  "histverify",
  "hostcomplete",
  "huponexit",
  "inherit_errexit",
  "interactive_comments",
  "lastpipe",
  "lithist",
  "localvar_inherit",
  "localvar_unset",
  "login_shell",
  "mailwarn",
  "no_empty_cmd_completion",
  "nocaseglob",
  "nocasematch",
  "nullglob",
  "progcomp",
  "progcomp_alias",
  "promptvars",
  "restricted_shell",
  "shift_verbose",
  "sourcepath",
  "xpg_echo"
];
var HELP_TOPICS = SHELL_BUILTINS2;
async function handleCompgen(ctx, args) {
  const actionTypes = [];
  let wordlist = null;
  let prefix = "";
  let suffix = "";
  let searchPrefix = null;
  let plusdirsOption = false;
  let dirnamesOption = false;
  let defaultOption = false;
  let excludePattern = null;
  let functionName = null;
  let commandString = null;
  const processedArgs = [];
  const validActions = [
    "alias",
    "arrayvar",
    "binding",
    "builtin",
    "command",
    "directory",
    "disabled",
    "enabled",
    "export",
    "file",
    "function",
    "group",
    "helptopic",
    "hostname",
    "job",
    "keyword",
    "running",
    "service",
    "setopt",
    "shopt",
    "signal",
    "stopped",
    "user",
    "variable"
  ];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-v") {
      actionTypes.push("variable");
    } else if (arg === "-e") {
      actionTypes.push("export");
    } else if (arg === "-f") {
      actionTypes.push("file");
    } else if (arg === "-d") {
      actionTypes.push("directory");
    } else if (arg === "-k") {
      actionTypes.push("keyword");
    } else if (arg === "-A") {
      i++;
      if (i >= args.length) {
        return failure("compgen: -A: option requires an argument\n", 2);
      }
      const actionType = args[i];
      if (!validActions.includes(actionType)) {
        return failure(`compgen: ${actionType}: invalid action name
`, 2);
      }
      actionTypes.push(actionType);
    } else if (arg === "-W") {
      i++;
      if (i >= args.length) {
        return failure("compgen: -W: option requires an argument\n", 2);
      }
      wordlist = args[i];
    } else if (arg === "-P") {
      i++;
      if (i >= args.length) {
        return failure("compgen: -P: option requires an argument\n", 2);
      }
      prefix = args[i];
    } else if (arg === "-S") {
      i++;
      if (i >= args.length) {
        return failure("compgen: -S: option requires an argument\n", 2);
      }
      suffix = args[i];
    } else if (arg === "-o") {
      i++;
      if (i >= args.length) {
        return failure("compgen: -o: option requires an argument\n", 2);
      }
      const opt = args[i];
      if (opt === "plusdirs") {
        plusdirsOption = true;
      } else if (opt === "dirnames") {
        dirnamesOption = true;
      } else if (opt === "default") {
        defaultOption = true;
      } else if (opt === "filenames" || opt === "nospace" || opt === "bashdefault" || opt === "noquote") {
      } else {
        return failure(`compgen: ${opt}: invalid option name
`, 2);
      }
    } else if (arg === "-F") {
      i++;
      if (i >= args.length) {
        return failure("compgen: -F: option requires an argument\n", 2);
      }
      functionName = args[i];
    } else if (arg === "-C") {
      i++;
      if (i >= args.length) {
        return failure("compgen: -C: option requires an argument\n", 2);
      }
      commandString = args[i];
    } else if (arg === "-X") {
      i++;
      if (i >= args.length) {
        return failure("compgen: -X: option requires an argument\n", 2);
      }
      excludePattern = args[i];
    } else if (arg === "-G") {
      i++;
      if (i >= args.length) {
        return failure("compgen: -G: option requires an argument\n", 2);
      }
    } else if (arg === "--") {
      processedArgs.push(...args.slice(i + 1));
      break;
    } else if (!arg.startsWith("-")) {
      processedArgs.push(arg);
    }
  }
  searchPrefix = processedArgs[0] ?? null;
  const completions = [];
  if (dirnamesOption) {
    const dirCompletions = await getDirectoryCompletions(ctx, searchPrefix);
    completions.push(...dirCompletions);
  }
  if (defaultOption) {
    const fileCompletions = await getFileCompletions(ctx, searchPrefix);
    completions.push(...fileCompletions);
  }
  for (const actionType of actionTypes) {
    if (actionType === "variable") {
      const vars = getVariableNames(ctx, searchPrefix);
      completions.push(...vars);
    } else if (actionType === "export") {
      const vars = getExportedVariableNames(ctx, searchPrefix);
      completions.push(...vars);
    } else if (actionType === "function") {
      const funcs = getFunctionNames(ctx, searchPrefix);
      completions.push(...funcs);
    } else if (actionType === "builtin") {
      const builtins = getBuiltinNames(searchPrefix);
      completions.push(...builtins);
    } else if (actionType === "keyword") {
      const keywords = getKeywordNames(searchPrefix);
      completions.push(...keywords);
    } else if (actionType === "alias") {
      const aliases = getAliasNames(ctx, searchPrefix);
      completions.push(...aliases);
    } else if (actionType === "shopt") {
      const shopts = getShoptNames(searchPrefix);
      completions.push(...shopts);
    } else if (actionType === "helptopic") {
      const topics = getHelpTopicNames(searchPrefix);
      completions.push(...topics);
    } else if (actionType === "directory") {
      const dirs = await getDirectoryCompletions(ctx, searchPrefix);
      completions.push(...dirs);
    } else if (actionType === "file") {
      const files = await getFileCompletions(ctx, searchPrefix);
      completions.push(...files);
    } else if (actionType === "user") {
      const users = getUserNames(searchPrefix);
      completions.push(...users);
    } else if (actionType === "command") {
      const commands = await getCommandCompletions(ctx, searchPrefix);
      completions.push(...commands);
    }
  }
  if (wordlist !== null) {
    try {
      const expandedWordlist = await expandWordlistString(ctx, wordlist);
      const words = splitWordlist(ctx, expandedWordlist);
      for (const word of words) {
        if (searchPrefix === null || word.startsWith(searchPrefix)) {
          completions.push(word);
        }
      }
    } catch {
      return result("", "", 1);
    }
  }
  if (plusdirsOption) {
    const dirCompletions = await getDirectoryCompletions(ctx, searchPrefix);
    for (const dir of dirCompletions) {
      if (!completions.includes(dir)) {
        completions.push(dir);
      }
    }
  }
  let functionStdout = "";
  if (functionName !== null) {
    const func = ctx.state.functions.get(functionName);
    if (func) {
      const savedEnv = {};
      savedEnv.COMP_WORDS__length = ctx.state.env.COMP_WORDS__length;
      ctx.state.env.COMP_WORDS__length = "0";
      savedEnv.COMP_CWORD = ctx.state.env.COMP_CWORD;
      ctx.state.env.COMP_CWORD = "-1";
      savedEnv.COMP_LINE = ctx.state.env.COMP_LINE;
      ctx.state.env.COMP_LINE = "";
      savedEnv.COMP_POINT = ctx.state.env.COMP_POINT;
      ctx.state.env.COMP_POINT = "0";
      const savedCompreply = {};
      for (const key of Object.keys(ctx.state.env)) {
        if (key === "COMPREPLY" || key.startsWith("COMPREPLY_") || key === "COMPREPLY__length") {
          savedCompreply[key] = ctx.state.env[key];
          delete ctx.state.env[key];
        }
      }
      const funcArgs = ["compgen", processedArgs[0] ?? "", ""];
      try {
        const funcResult = await callFunction(ctx, func, funcArgs, "");
        if (funcResult.exitCode !== 0) {
          restoreEnv(ctx, savedEnv);
          restoreEnv(ctx, savedCompreply);
          return result("", funcResult.stderr, 1);
        }
        functionStdout = funcResult.stdout;
        const compreplyValues = getCompreplyValues(ctx);
        completions.push(...compreplyValues);
      } catch {
        restoreEnv(ctx, savedEnv);
        restoreEnv(ctx, savedCompreply);
        return result("", "", 1);
      }
      restoreEnv(ctx, savedEnv);
      restoreEnv(ctx, savedCompreply);
    }
  }
  if (commandString !== null) {
    try {
      const ast = parse(commandString);
      const cmdResult = await ctx.executeScript(ast);
      if (cmdResult.exitCode !== 0) {
        return result("", cmdResult.stderr, cmdResult.exitCode);
      }
      if (cmdResult.stdout) {
        const lines = cmdResult.stdout.split("\n");
        for (const line of lines) {
          if (line.length > 0) {
            completions.push(line);
          }
        }
      }
    } catch (error) {
      if (error.name === "ParseException") {
        return failure(`compgen: -C: ${error.message}
`, 2);
      }
      throw error;
    }
  }
  let filteredCompletions = completions;
  if (excludePattern !== null) {
    const isNegated = excludePattern.startsWith("!");
    const pattern = isNegated ? excludePattern.slice(1) : excludePattern;
    filteredCompletions = completions.filter((c) => {
      const matches = matchPattern(c, pattern, false, true);
      return isNegated ? matches : !matches;
    });
  }
  if (filteredCompletions.length === 0 && searchPrefix !== null) {
    return result(functionStdout, "", 1);
  }
  const completionOutput = filteredCompletions.map((c) => `${prefix}${c}${suffix}`).join("\n");
  const output = functionStdout + (completionOutput ? `${completionOutput}
` : "");
  return success(output);
}
__name(handleCompgen, "handleCompgen");
function getVariableNames(ctx, prefix) {
  const names = /* @__PURE__ */ new Set();
  for (const key of Object.keys(ctx.state.env)) {
    if (key.includes("_") && /^[a-zA-Z_][a-zA-Z0-9_]*_\d+$/.test(key)) {
      continue;
    }
    if (key.endsWith("__length")) {
      continue;
    }
    const baseName = key.split("_")[0];
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
      names.add(key);
    } else if (baseName && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(baseName) && ctx.state.env[`${baseName}__length`] !== void 0) {
      names.add(baseName);
    }
  }
  let resultArr = Array.from(names);
  if (prefix !== null) {
    resultArr = resultArr.filter((n) => n.startsWith(prefix));
  }
  return resultArr.sort();
}
__name(getVariableNames, "getVariableNames");
function getExportedVariableNames(ctx, prefix) {
  const exportedVars = ctx.state.exportedVars ?? /* @__PURE__ */ new Set();
  let resultArr = Array.from(exportedVars);
  if (prefix !== null) {
    resultArr = resultArr.filter((n) => n.startsWith(prefix));
  }
  resultArr = resultArr.filter((n) => {
    if (n.includes("_") && /^[a-zA-Z_][a-zA-Z0-9_]*_\d+$/.test(n)) {
      return false;
    }
    if (n.endsWith("__length")) {
      return false;
    }
    return ctx.state.env[n] !== void 0;
  });
  return resultArr.sort();
}
__name(getExportedVariableNames, "getExportedVariableNames");
function getFunctionNames(ctx, prefix) {
  let resultArr = Array.from(ctx.state.functions.keys());
  if (prefix !== null) {
    resultArr = resultArr.filter((n) => n.startsWith(prefix));
  }
  return resultArr.sort();
}
__name(getFunctionNames, "getFunctionNames");
function getBuiltinNames(prefix) {
  let resultArr = [...SHELL_BUILTINS2];
  if (prefix !== null) {
    resultArr = resultArr.filter((n) => n.startsWith(prefix));
  }
  return resultArr.sort();
}
__name(getBuiltinNames, "getBuiltinNames");
function getKeywordNames(prefix) {
  let resultArr = [...SHELL_KEYWORDS2];
  if (prefix !== null) {
    resultArr = resultArr.filter((n) => n.startsWith(prefix));
  }
  return resultArr.sort();
}
__name(getKeywordNames, "getKeywordNames");
function getAliasNames(ctx, prefix) {
  const names = [];
  for (const key of Object.keys(ctx.state.env)) {
    if (key.startsWith("BASH_ALIAS_")) {
      const aliasName = key.slice("BASH_ALIAS_".length);
      names.push(aliasName);
    }
  }
  let resultArr = names;
  if (prefix !== null) {
    resultArr = resultArr.filter((n) => n.startsWith(prefix));
  }
  return resultArr.sort();
}
__name(getAliasNames, "getAliasNames");
function getShoptNames(prefix) {
  let resultArr = [...SHOPT_OPTIONS];
  if (prefix !== null) {
    resultArr = resultArr.filter((n) => n.startsWith(prefix));
  }
  return resultArr.sort();
}
__name(getShoptNames, "getShoptNames");
function getHelpTopicNames(prefix) {
  let resultArr = [...HELP_TOPICS];
  if (prefix !== null) {
    resultArr = resultArr.filter((n) => n.startsWith(prefix));
  }
  return resultArr.sort();
}
__name(getHelpTopicNames, "getHelpTopicNames");
async function getDirectoryCompletions(ctx, prefix) {
  const results = [];
  try {
    let searchDir = ctx.state.cwd;
    let matchPrefix = prefix ?? "";
    if (prefix) {
      const lastSlash = prefix.lastIndexOf("/");
      if (lastSlash !== -1) {
        const dirPart = prefix.slice(0, lastSlash) || "/";
        matchPrefix = prefix.slice(lastSlash + 1);
        if (dirPart.startsWith("/")) {
          searchDir = dirPart;
        } else {
          searchDir = `${ctx.state.cwd}/${dirPart}`;
        }
      }
    }
    const entries = await ctx.fs.readdir(searchDir);
    for (const entry of entries) {
      const fullPath = `${searchDir}/${entry}`;
      try {
        const stat = await ctx.fs.stat(fullPath);
        if (stat.isDirectory) {
          if (!matchPrefix || entry.startsWith(matchPrefix)) {
            if (prefix?.includes("/")) {
              const lastSlash = prefix.lastIndexOf("/");
              const dirPart = prefix.slice(0, lastSlash + 1);
              results.push(dirPart + entry);
            } else {
              results.push(entry);
            }
          }
        }
      } catch {
      }
    }
  } catch {
  }
  return results.sort();
}
__name(getDirectoryCompletions, "getDirectoryCompletions");
async function getFileCompletions(ctx, prefix) {
  const results = [];
  try {
    let searchDir = ctx.state.cwd;
    let matchPrefix = prefix ?? "";
    if (prefix) {
      const lastSlash = prefix.lastIndexOf("/");
      if (lastSlash !== -1) {
        const dirPart = prefix.slice(0, lastSlash) || "/";
        matchPrefix = prefix.slice(lastSlash + 1);
        if (dirPart.startsWith("/")) {
          searchDir = dirPart;
        } else {
          searchDir = `${ctx.state.cwd}/${dirPart}`;
        }
      }
    }
    const entries = await ctx.fs.readdir(searchDir);
    for (const entry of entries) {
      if (!matchPrefix || entry.startsWith(matchPrefix)) {
        if (prefix?.includes("/")) {
          const lastSlash = prefix.lastIndexOf("/");
          const dirPart = prefix.slice(0, lastSlash + 1);
          results.push(dirPart + entry);
        } else {
          results.push(entry);
        }
      }
    }
  } catch {
  }
  return results.sort();
}
__name(getFileCompletions, "getFileCompletions");
function getUserNames(_prefix) {
  return ["root", "nobody"];
}
__name(getUserNames, "getUserNames");
async function getCommandCompletions(ctx, prefix) {
  const commands = /* @__PURE__ */ new Set();
  for (const builtin of SHELL_BUILTINS2) {
    commands.add(builtin);
  }
  for (const func of ctx.state.functions.keys()) {
    commands.add(func);
  }
  for (const key of Object.keys(ctx.state.env)) {
    if (key.startsWith("BASH_ALIAS_")) {
      commands.add(key.slice("BASH_ALIAS_".length));
    }
  }
  for (const keyword of SHELL_KEYWORDS2) {
    commands.add(keyword);
  }
  const path = ctx.state.env.PATH ?? "/usr/bin:/bin";
  for (const dir of path.split(":")) {
    if (!dir)
      continue;
    try {
      const entries = await ctx.fs.readdir(dir);
      for (const entry of entries) {
        commands.add(entry);
      }
    } catch {
    }
  }
  let resultArr = Array.from(commands);
  if (prefix !== null) {
    resultArr = resultArr.filter((c) => c.startsWith(prefix));
  }
  return resultArr.sort();
}
__name(getCommandCompletions, "getCommandCompletions");
async function expandWordlistString(ctx, wordlist) {
  const parser = new Parser();
  const wordNode = parser.parseWordFromString(wordlist, false, false);
  return await expandWord(ctx, wordNode);
}
__name(expandWordlistString, "expandWordlistString");
function splitWordlist(ctx, wordlist) {
  const ifs = ctx.state.env.IFS ?? " 	\n";
  if (ifs.length === 0) {
    return [wordlist];
  }
  const ifsSet = new Set(ifs.split(""));
  const words = [];
  let currentWord = "";
  let i = 0;
  while (i < wordlist.length) {
    const char = wordlist[i];
    if (char === "\\" && i + 1 < wordlist.length) {
      const nextChar = wordlist[i + 1];
      currentWord += nextChar;
      i += 2;
    } else if (ifsSet.has(char)) {
      if (currentWord.length > 0) {
        words.push(currentWord);
        currentWord = "";
      }
      i++;
    } else {
      currentWord += char;
      i++;
    }
  }
  if (currentWord.length > 0) {
    words.push(currentWord);
  }
  return words;
}
__name(splitWordlist, "splitWordlist");
function restoreEnv(ctx, saved) {
  for (const [key, value] of Object.entries(saved)) {
    if (value === void 0) {
      delete ctx.state.env[key];
    } else {
      ctx.state.env[key] = value;
    }
  }
}
__name(restoreEnv, "restoreEnv");
function getCompreplyValues(ctx) {
  const values = [];
  const lengthKey = "COMPREPLY__length";
  const arrayLength = ctx.state.env[lengthKey];
  if (arrayLength !== void 0) {
    const elements = getArrayElements(ctx, "COMPREPLY");
    for (const [, value] of elements) {
      values.push(value);
    }
  } else if (ctx.state.env.COMPREPLY !== void 0) {
    values.push(ctx.state.env.COMPREPLY);
  }
  return values;
}
__name(getCompreplyValues, "getCompreplyValues");

// dist/interpreter/builtins/complete.js
var VALID_OPTIONS = [
  "bashdefault",
  "default",
  "dirnames",
  "filenames",
  "noquote",
  "nosort",
  "nospace",
  "plusdirs"
];
function handleComplete(ctx, args) {
  if (!ctx.state.completionSpecs) {
    ctx.state.completionSpecs = /* @__PURE__ */ new Map();
  }
  let printMode = false;
  let removeMode = false;
  let isDefault = false;
  let wordlist;
  let funcName;
  let commandStr;
  const options = [];
  const actions = [];
  const commands = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-p") {
      printMode = true;
    } else if (arg === "-r") {
      removeMode = true;
    } else if (arg === "-D") {
      isDefault = true;
    } else if (arg === "-W") {
      i++;
      if (i >= args.length) {
        return failure("complete: -W: option requires an argument\n", 2);
      }
      wordlist = args[i];
    } else if (arg === "-F") {
      i++;
      if (i >= args.length) {
        return failure("complete: -F: option requires an argument\n", 2);
      }
      funcName = args[i];
    } else if (arg === "-o") {
      i++;
      if (i >= args.length) {
        return failure("complete: -o: option requires an argument\n", 2);
      }
      const opt = args[i];
      if (!VALID_OPTIONS.includes(opt)) {
        return failure(`complete: ${opt}: invalid option name
`, 2);
      }
      options.push(opt);
    } else if (arg === "-A") {
      i++;
      if (i >= args.length) {
        return failure("complete: -A: option requires an argument\n", 2);
      }
      actions.push(args[i]);
    } else if (arg === "-C") {
      i++;
      if (i >= args.length) {
        return failure("complete: -C: option requires an argument\n", 2);
      }
      commandStr = args[i];
    } else if (arg === "-G") {
      i++;
      if (i >= args.length) {
        return failure("complete: -G: option requires an argument\n", 2);
      }
    } else if (arg === "-P") {
      i++;
      if (i >= args.length) {
        return failure("complete: -P: option requires an argument\n", 2);
      }
    } else if (arg === "-S") {
      i++;
      if (i >= args.length) {
        return failure("complete: -S: option requires an argument\n", 2);
      }
    } else if (arg === "-X") {
      i++;
      if (i >= args.length) {
        return failure("complete: -X: option requires an argument\n", 2);
      }
    } else if (arg === "--") {
      commands.push(...args.slice(i + 1));
      break;
    } else if (!arg.startsWith("-")) {
      commands.push(arg);
    }
  }
  if (removeMode) {
    if (commands.length === 0) {
      ctx.state.completionSpecs.clear();
      return success("");
    }
    for (const cmd of commands) {
      ctx.state.completionSpecs.delete(cmd);
    }
    return success("");
  }
  if (printMode) {
    if (commands.length === 0) {
      return printCompletionSpecs(ctx);
    }
    return printCompletionSpecs(ctx, commands);
  }
  if (args.length === 0 || commands.length === 0 && !wordlist && !funcName && !commandStr && options.length === 0 && actions.length === 0 && !isDefault) {
    return printCompletionSpecs(ctx);
  }
  if (funcName && commands.length === 0 && !isDefault) {
    return failure("complete: -F: option requires a command name\n", 2);
  }
  if (isDefault) {
    const spec = {
      isDefault: true
    };
    if (wordlist !== void 0)
      spec.wordlist = wordlist;
    if (funcName !== void 0)
      spec.function = funcName;
    if (commandStr !== void 0)
      spec.command = commandStr;
    if (options.length > 0)
      spec.options = options;
    if (actions.length > 0)
      spec.actions = actions;
    ctx.state.completionSpecs.set("__default__", spec);
    return success("");
  }
  for (const cmd of commands) {
    const spec = {};
    if (wordlist !== void 0)
      spec.wordlist = wordlist;
    if (funcName !== void 0)
      spec.function = funcName;
    if (commandStr !== void 0)
      spec.command = commandStr;
    if (options.length > 0)
      spec.options = options;
    if (actions.length > 0)
      spec.actions = actions;
    ctx.state.completionSpecs.set(cmd, spec);
  }
  return success("");
}
__name(handleComplete, "handleComplete");
function printCompletionSpecs(ctx, commands) {
  const specs = ctx.state.completionSpecs;
  if (!specs || specs.size === 0) {
    if (commands && commands.length > 0) {
      let stderr = "";
      for (const cmd of commands) {
        stderr += `complete: ${cmd}: no completion specification
`;
      }
      return result("", stderr, 1);
    }
    return success("");
  }
  const output = [];
  const targetCommands = commands || Array.from(specs.keys());
  for (const cmd of targetCommands) {
    if (cmd === "__default__")
      continue;
    const spec = specs.get(cmd);
    if (!spec) {
      if (commands) {
        return result(output.join("\n") + (output.length > 0 ? "\n" : ""), `complete: ${cmd}: no completion specification
`, 1);
      }
      continue;
    }
    let line = "complete";
    if (spec.options) {
      for (const opt of spec.options) {
        line += ` -o ${opt}`;
      }
    }
    if (spec.actions) {
      for (const action of spec.actions) {
        line += ` -A ${action}`;
      }
    }
    if (spec.wordlist !== void 0) {
      if (spec.wordlist.includes(" ") || spec.wordlist.includes("'")) {
        line += ` -W '${spec.wordlist}'`;
      } else {
        line += ` -W ${spec.wordlist}`;
      }
    }
    if (spec.function !== void 0) {
      line += ` -F ${spec.function}`;
    }
    if (spec.isDefault) {
      line += " -D";
    }
    line += ` ${cmd}`;
    output.push(line);
  }
  if (output.length === 0) {
    return success("");
  }
  return success(`${output.join("\n")}
`);
}
__name(printCompletionSpecs, "printCompletionSpecs");

// dist/interpreter/builtins/compopt.js
var VALID_OPTIONS2 = [
  "bashdefault",
  "default",
  "dirnames",
  "filenames",
  "noquote",
  "nosort",
  "nospace",
  "plusdirs"
];
function handleCompopt(ctx, args) {
  if (!ctx.state.completionSpecs) {
    ctx.state.completionSpecs = /* @__PURE__ */ new Map();
  }
  let isDefault = false;
  let isEmptyLine = false;
  const enableOptions = [];
  const disableOptions = [];
  const commands = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-D") {
      isDefault = true;
    } else if (arg === "-E") {
      isEmptyLine = true;
    } else if (arg === "-o") {
      i++;
      if (i >= args.length) {
        return failure("compopt: -o: option requires an argument\n", 2);
      }
      const opt = args[i];
      if (!VALID_OPTIONS2.includes(opt)) {
        return failure(`compopt: ${opt}: invalid option name
`, 2);
      }
      enableOptions.push(opt);
    } else if (arg === "+o") {
      i++;
      if (i >= args.length) {
        return failure("compopt: +o: option requires an argument\n", 2);
      }
      const opt = args[i];
      if (!VALID_OPTIONS2.includes(opt)) {
        return failure(`compopt: ${opt}: invalid option name
`, 2);
      }
      disableOptions.push(opt);
    } else if (arg === "--") {
      commands.push(...args.slice(i + 1));
      break;
    } else if (!arg.startsWith("-") && !arg.startsWith("+")) {
      commands.push(arg);
    }
  }
  if (isDefault) {
    const spec = ctx.state.completionSpecs.get("__default__") ?? {
      isDefault: true
    };
    const currentOptions = new Set(spec.options ?? []);
    for (const opt of enableOptions) {
      currentOptions.add(opt);
    }
    for (const opt of disableOptions) {
      currentOptions.delete(opt);
    }
    spec.options = currentOptions.size > 0 ? Array.from(currentOptions) : void 0;
    ctx.state.completionSpecs.set("__default__", spec);
    return success("");
  }
  if (isEmptyLine) {
    const spec = ctx.state.completionSpecs.get("__empty__") ?? {};
    const currentOptions = new Set(spec.options ?? []);
    for (const opt of enableOptions) {
      currentOptions.add(opt);
    }
    for (const opt of disableOptions) {
      currentOptions.delete(opt);
    }
    spec.options = currentOptions.size > 0 ? Array.from(currentOptions) : void 0;
    ctx.state.completionSpecs.set("__empty__", spec);
    return success("");
  }
  if (commands.length > 0) {
    for (const cmd of commands) {
      const spec = ctx.state.completionSpecs.get(cmd) ?? {};
      const currentOptions = new Set(spec.options ?? []);
      for (const opt of enableOptions) {
        currentOptions.add(opt);
      }
      for (const opt of disableOptions) {
        currentOptions.delete(opt);
      }
      spec.options = currentOptions.size > 0 ? Array.from(currentOptions) : void 0;
      ctx.state.completionSpecs.set(cmd, spec);
    }
    return success("");
  }
  return failure("compopt: not currently executing completion function\n", 1);
}
__name(handleCompopt, "handleCompopt");

// dist/interpreter/builtins/continue.js
function handleContinue(ctx, args) {
  if (ctx.state.loopDepth === 0) {
    if (ctx.state.parentHasLoopContext) {
      throw new SubshellExitError();
    }
    return OK;
  }
  if (args.length > 1) {
    throw new ExitError(1, "", "bash: continue: too many arguments\n");
  }
  let levels = 1;
  if (args.length > 0) {
    const n = Number.parseInt(args[0], 10);
    if (Number.isNaN(n) || n < 1) {
      throw new ExitError(1, "", `bash: continue: ${args[0]}: numeric argument required
`);
    }
    levels = n;
  }
  throw new ContinueError(levels);
}
__name(handleContinue, "handleContinue");

// dist/interpreter/helpers/tilde.js
function expandTildesInValue(ctx, value) {
  const home = ctx.state.env.HOME || "/home/user";
  const parts = value.split(":");
  const expanded = parts.map((part) => {
    if (part === "~") {
      return home;
    }
    if (part === "~root") {
      return "/root";
    }
    if (part.startsWith("~/")) {
      return home + part.slice(1);
    }
    if (part.startsWith("~root/")) {
      return `/root${part.slice(5)}`;
    }
    return part;
  });
  return expanded.join(":");
}
__name(expandTildesInValue, "expandTildesInValue");

// dist/interpreter/helpers/quoting.js
function needsDollarQuoting(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}
__name(needsDollarQuoting, "needsDollarQuoting");
function dollarQuote(value) {
  let result2 = "$'";
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    const code = value.charCodeAt(i);
    if (code === 7) {
      result2 += "\\a";
    } else if (code === 8) {
      result2 += "\\b";
    } else if (code === 9) {
      result2 += "\\t";
    } else if (code === 10) {
      result2 += "\\n";
    } else if (code === 11) {
      result2 += "\\v";
    } else if (code === 12) {
      result2 += "\\f";
    } else if (code === 13) {
      result2 += "\\r";
    } else if (code === 27) {
      result2 += "\\e";
    } else if (code === 39) {
      result2 += "\\'";
    } else if (code === 92) {
      result2 += "\\\\";
    } else if (code < 32 || code === 127) {
      result2 += `\\${code.toString(8).padStart(3, "0")}`;
    } else {
      result2 += char;
    }
  }
  result2 += "'";
  return result2;
}
__name(dollarQuote, "dollarQuote");
function quoteValue(value) {
  if (needsDollarQuoting(value)) {
    return dollarQuote(value);
  }
  if (/^[a-zA-Z0-9_/.:\-@%+,=]*$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}
__name(quoteValue, "quoteValue");
function quoteArrayValue(value) {
  if (needsDollarQuoting(value)) {
    return dollarQuote(value);
  }
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}
__name(quoteArrayValue, "quoteArrayValue");
function quoteDeclareValue(value) {
  if (needsDollarQuoting(value)) {
    return dollarQuote(value);
  }
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}
__name(quoteDeclareValue, "quoteDeclareValue");

// dist/interpreter/builtins/declare-print.js
function getVariableFlags(ctx, name) {
  let flags = "";
  if (ctx.state.integerVars?.has(name)) {
    flags += "i";
  }
  if (ctx.state.lowercaseVars?.has(name)) {
    flags += "l";
  }
  if (isNameref(ctx, name)) {
    flags += "n";
  }
  if (ctx.state.readonlyVars?.has(name)) {
    flags += "r";
  }
  if (ctx.state.uppercaseVars?.has(name)) {
    flags += "u";
  }
  if (ctx.state.exportedVars?.has(name)) {
    flags += "x";
  }
  return flags === "" ? "--" : `-${flags}`;
}
__name(getVariableFlags, "getVariableFlags");
function formatAssocValue(value) {
  if (value === "") {
    return "''";
  }
  if (/[\s'\\]/.test(value)) {
    const escaped = value.replace(/'/g, "'\\''");
    return `'${escaped}'`;
  }
  return value;
}
__name(formatAssocValue, "formatAssocValue");
function printSpecificVariables(ctx, names) {
  let stdout = "";
  let stderr = "";
  let anyNotFound = false;
  for (const name of names) {
    const flags = getVariableFlags(ctx, name);
    const isAssoc = ctx.state.associativeArrays?.has(name);
    if (isAssoc) {
      const keys = getAssocArrayKeys(ctx, name);
      if (keys.length === 0) {
        stdout += `declare -A ${name}=()
`;
      } else {
        const elements = keys.map((key) => {
          const value2 = ctx.state.env[`${name}_${key}`] ?? "";
          const formattedValue = formatAssocValue(value2);
          return `['${key}']=${formattedValue}`;
        });
        stdout += `declare -A ${name}=(${elements.join(" ")})
`;
      }
      continue;
    }
    const arrayIndices = getArrayIndices(ctx, name);
    if (arrayIndices.length > 0) {
      const elements = arrayIndices.map((index) => {
        const value2 = ctx.state.env[`${name}_${index}`] ?? "";
        return `[${index}]=${quoteArrayValue(value2)}`;
      });
      stdout += `declare -a ${name}=(${elements.join(" ")})
`;
      continue;
    }
    if (ctx.state.env[`${name}__length`] !== void 0) {
      stdout += `declare -a ${name}=()
`;
      continue;
    }
    const value = ctx.state.env[name];
    if (value !== void 0) {
      stdout += `declare ${flags} ${name}=${quoteDeclareValue(value)}
`;
    } else {
      const isDeclared = ctx.state.declaredVars?.has(name);
      const isLocalVar = ctx.state.localVarDepth?.has(name);
      if (isDeclared || isLocalVar) {
        stdout += `declare ${flags} ${name}
`;
      } else {
        stderr += `bash: declare: ${name}: not found
`;
        anyNotFound = true;
      }
    }
  }
  return result(stdout, stderr, anyNotFound ? 1 : 0);
}
__name(printSpecificVariables, "printSpecificVariables");
function printAllVariables(ctx, filters) {
  const { filterExport, filterReadonly, filterNameref, filterIndexedArray, filterAssocArray } = filters;
  const hasFilter = filterExport || filterReadonly || filterNameref || filterIndexedArray || filterAssocArray;
  let stdout = "";
  const varNames = /* @__PURE__ */ new Set();
  for (const key of Object.keys(ctx.state.env)) {
    if (key.startsWith("BASH_"))
      continue;
    if (key.endsWith("__length")) {
      const baseName = key.slice(0, -8);
      varNames.add(baseName);
      continue;
    }
    const underscoreIdx = key.lastIndexOf("_");
    if (underscoreIdx > 0) {
      const baseName = key.slice(0, underscoreIdx);
      const suffix = key.slice(underscoreIdx + 1);
      if (/^\d+$/.test(suffix) || ctx.state.associativeArrays?.has(baseName)) {
        varNames.add(baseName);
        continue;
      }
    }
    varNames.add(key);
  }
  if (ctx.state.localVarDepth) {
    for (const name of ctx.state.localVarDepth.keys()) {
      varNames.add(name);
    }
  }
  if (ctx.state.associativeArrays) {
    for (const name of ctx.state.associativeArrays) {
      varNames.add(name);
    }
  }
  const sortedNames = Array.from(varNames).sort();
  for (const name of sortedNames) {
    const flags = getVariableFlags(ctx, name);
    const isAssoc = ctx.state.associativeArrays?.has(name);
    const arrayIndices = getArrayIndices(ctx, name);
    const isIndexedArray = !isAssoc && (arrayIndices.length > 0 || ctx.state.env[`${name}__length`] !== void 0);
    if (hasFilter) {
      if (filterAssocArray && !isAssoc)
        continue;
      if (filterIndexedArray && !isIndexedArray)
        continue;
      if (filterExport && !ctx.state.exportedVars?.has(name))
        continue;
      if (filterReadonly && !ctx.state.readonlyVars?.has(name))
        continue;
      if (filterNameref && !isNameref(ctx, name))
        continue;
    }
    if (isAssoc) {
      const keys = getAssocArrayKeys(ctx, name);
      if (keys.length === 0) {
        stdout += `declare -A ${name}=()
`;
      } else {
        const elements = keys.map((key) => {
          const value2 = ctx.state.env[`${name}_${key}`] ?? "";
          const formattedValue = formatAssocValue(value2);
          return `['${key}']=${formattedValue}`;
        });
        stdout += `declare -A ${name}=(${elements.join(" ")})
`;
      }
      continue;
    }
    if (arrayIndices.length > 0) {
      const elements = arrayIndices.map((index) => {
        const value2 = ctx.state.env[`${name}_${index}`] ?? "";
        return `[${index}]=${quoteArrayValue(value2)}`;
      });
      stdout += `declare -a ${name}=(${elements.join(" ")})
`;
      continue;
    }
    if (ctx.state.env[`${name}__length`] !== void 0) {
      stdout += `declare -a ${name}=()
`;
      continue;
    }
    const value = ctx.state.env[name];
    if (value !== void 0) {
      stdout += `declare ${flags} ${name}=${quoteDeclareValue(value)}
`;
    }
  }
  return success(stdout);
}
__name(printAllVariables, "printAllVariables");
function listAssociativeArrays(ctx) {
  let stdout = "";
  const assocNames = Array.from(ctx.state.associativeArrays ?? []).sort();
  for (const name of assocNames) {
    const keys = getAssocArrayKeys(ctx, name);
    if (keys.length === 0) {
      stdout += `declare -A ${name}=()
`;
    } else {
      const elements = keys.map((key) => {
        const value = ctx.state.env[`${name}_${key}`] ?? "";
        const formattedValue = formatAssocValue(value);
        return `['${key}']=${formattedValue}`;
      });
      stdout += `declare -A ${name}=(${elements.join(" ")})
`;
    }
  }
  return success(stdout);
}
__name(listAssociativeArrays, "listAssociativeArrays");
function listIndexedArrays(ctx) {
  let stdout = "";
  const arrayNames = /* @__PURE__ */ new Set();
  for (const key of Object.keys(ctx.state.env)) {
    if (key.startsWith("BASH_"))
      continue;
    if (key.endsWith("__length")) {
      const baseName = key.slice(0, -8);
      if (!ctx.state.associativeArrays?.has(baseName)) {
        arrayNames.add(baseName);
      }
      continue;
    }
    const lastUnderscore = key.lastIndexOf("_");
    if (lastUnderscore > 0) {
      const baseName = key.slice(0, lastUnderscore);
      const suffix = key.slice(lastUnderscore + 1);
      if (/^\d+$/.test(suffix)) {
        if (!ctx.state.associativeArrays?.has(baseName)) {
          arrayNames.add(baseName);
        }
      }
    }
  }
  const sortedNames = Array.from(arrayNames).sort();
  for (const name of sortedNames) {
    const indices = getArrayIndices(ctx, name);
    if (indices.length === 0) {
      stdout += `declare -a ${name}=()
`;
    } else {
      const elements = indices.map((index) => {
        const value = ctx.state.env[`${name}_${index}`] ?? "";
        return `[${index}]=${quoteArrayValue(value)}`;
      });
      stdout += `declare -a ${name}=(${elements.join(" ")})
`;
    }
  }
  return success(stdout);
}
__name(listIndexedArrays, "listIndexedArrays");
function listAllVariables(ctx) {
  let stdout = "";
  const varNames = /* @__PURE__ */ new Set();
  for (const key of Object.keys(ctx.state.env)) {
    if (key.startsWith("BASH_"))
      continue;
    if (key.endsWith("__length")) {
      const baseName = key.slice(0, -8);
      varNames.add(baseName);
      continue;
    }
    const underscoreIdx = key.lastIndexOf("_");
    if (underscoreIdx > 0) {
      const baseName = key.slice(0, underscoreIdx);
      const suffix = key.slice(underscoreIdx + 1);
      if (/^\d+$/.test(suffix) || ctx.state.associativeArrays?.has(baseName)) {
        varNames.add(baseName);
        continue;
      }
    }
    varNames.add(key);
  }
  const sortedNames = Array.from(varNames).sort();
  for (const name of sortedNames) {
    const isAssoc = ctx.state.associativeArrays?.has(name);
    if (isAssoc) {
      continue;
    }
    const arrayIndices = getArrayIndices(ctx, name);
    if (arrayIndices.length > 0 || ctx.state.env[`${name}__length`] !== void 0) {
      continue;
    }
    const value = ctx.state.env[name];
    if (value !== void 0) {
      stdout += `${name}=${quoteValue(value)}
`;
    }
  }
  return success(stdout);
}
__name(listAllVariables, "listAllVariables");

// dist/interpreter/builtins/declare.js
function markInteger(ctx, name) {
  ctx.state.integerVars ??= /* @__PURE__ */ new Set();
  ctx.state.integerVars.add(name);
}
__name(markInteger, "markInteger");
function isInteger(ctx, name) {
  return ctx.state.integerVars?.has(name) ?? false;
}
__name(isInteger, "isInteger");
function markLowercase(ctx, name) {
  ctx.state.lowercaseVars ??= /* @__PURE__ */ new Set();
  ctx.state.lowercaseVars.add(name);
  ctx.state.uppercaseVars?.delete(name);
}
__name(markLowercase, "markLowercase");
function isLowercase(ctx, name) {
  return ctx.state.lowercaseVars?.has(name) ?? false;
}
__name(isLowercase, "isLowercase");
function markUppercase(ctx, name) {
  ctx.state.uppercaseVars ??= /* @__PURE__ */ new Set();
  ctx.state.uppercaseVars.add(name);
  ctx.state.lowercaseVars?.delete(name);
}
__name(markUppercase, "markUppercase");
function isUppercase(ctx, name) {
  return ctx.state.uppercaseVars?.has(name) ?? false;
}
__name(isUppercase, "isUppercase");
function applyCaseTransform(ctx, name, value) {
  if (isLowercase(ctx, name)) {
    return value.toLowerCase();
  }
  if (isUppercase(ctx, name)) {
    return value.toUpperCase();
  }
  return value;
}
__name(applyCaseTransform, "applyCaseTransform");
async function evaluateIntegerValue(ctx, value) {
  try {
    const parser = new Parser();
    const arithAst = parseArithmeticExpression(parser, value);
    const result2 = await evaluateArithmetic(ctx, arithAst.expression);
    return String(result2);
  } catch {
    return "0";
  }
}
__name(evaluateIntegerValue, "evaluateIntegerValue");
function parseArrayAssignment(arg) {
  const nameMatch = arg.match(/^[a-zA-Z_][a-zA-Z0-9_]*/);
  if (!nameMatch)
    return null;
  const name = nameMatch[0];
  let pos = name.length;
  if (arg[pos] !== "[")
    return null;
  let depth = 0;
  const subscriptStart = pos + 1;
  for (; pos < arg.length; pos++) {
    if (arg[pos] === "[")
      depth++;
    else if (arg[pos] === "]") {
      depth--;
      if (depth === 0)
        break;
    }
  }
  if (depth !== 0)
    return null;
  const indexExpr = arg.slice(subscriptStart, pos);
  pos++;
  if (arg[pos] !== "=")
    return null;
  pos++;
  const value = arg.slice(pos);
  return { name, indexExpr, value };
}
__name(parseArrayAssignment, "parseArrayAssignment");
async function handleDeclare(ctx, args) {
  let declareArray = false;
  let declareAssoc = false;
  let declareReadonly = false;
  let declareExport = false;
  let printMode = false;
  let declareNameref = false;
  let removeNameref = false;
  let removeArray = false;
  let removeExport = false;
  let declareInteger = false;
  let declareLowercase = false;
  let declareUppercase = false;
  let functionMode = false;
  let functionNamesOnly = false;
  let declareGlobal = false;
  const processedArgs = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-a") {
      declareArray = true;
    } else if (arg === "-A") {
      declareAssoc = true;
    } else if (arg === "-r") {
      declareReadonly = true;
    } else if (arg === "-x") {
      declareExport = true;
    } else if (arg === "-p") {
      printMode = true;
    } else if (arg === "-n") {
      declareNameref = true;
    } else if (arg === "+n") {
      removeNameref = true;
    } else if (arg === "+a") {
      removeArray = true;
    } else if (arg === "+x") {
      removeExport = true;
    } else if (arg === "--") {
      processedArgs.push(...args.slice(i + 1));
      break;
    } else if (arg.startsWith("+")) {
      for (const flag of arg.slice(1)) {
        if (flag === "n")
          removeNameref = true;
        else if (flag === "a")
          removeArray = true;
        else if (flag === "x")
          removeExport = true;
        else if (flag === "r") {
        } else if (flag === "i") {
        } else if (flag === "f" || flag === "F") {
        } else {
          return result("", `bash: typeset: +${flag}: invalid option
`, 2);
        }
      }
    } else if (arg === "-i") {
      declareInteger = true;
    } else if (arg === "-l") {
      declareLowercase = true;
    } else if (arg === "-u") {
      declareUppercase = true;
    } else if (arg === "-f") {
      functionMode = true;
    } else if (arg === "-F") {
      functionNamesOnly = true;
    } else if (arg === "-g") {
      declareGlobal = true;
    } else if (arg.startsWith("-")) {
      for (const flag of arg.slice(1)) {
        if (flag === "a")
          declareArray = true;
        else if (flag === "A")
          declareAssoc = true;
        else if (flag === "r")
          declareReadonly = true;
        else if (flag === "x")
          declareExport = true;
        else if (flag === "p")
          printMode = true;
        else if (flag === "n")
          declareNameref = true;
        else if (flag === "i")
          declareInteger = true;
        else if (flag === "l")
          declareLowercase = true;
        else if (flag === "u")
          declareUppercase = true;
        else if (flag === "f")
          functionMode = true;
        else if (flag === "F")
          functionNamesOnly = true;
        else if (flag === "g")
          declareGlobal = true;
        else {
          return result("", `bash: typeset: -${flag}: invalid option
`, 2);
        }
      }
    } else {
      processedArgs.push(arg);
    }
  }
  const isInsideFunction = ctx.state.localScopes.length > 0;
  const createLocal = isInsideFunction && !declareGlobal;
  const saveToLocalScope = /* @__PURE__ */ __name((name) => {
    if (!createLocal)
      return;
    const currentScope = ctx.state.localScopes[ctx.state.localScopes.length - 1];
    if (!currentScope.has(name)) {
      currentScope.set(name, ctx.state.env[name]);
    }
  }, "saveToLocalScope");
  const saveArrayToLocalScope = /* @__PURE__ */ __name((name) => {
    if (!createLocal)
      return;
    const currentScope = ctx.state.localScopes[ctx.state.localScopes.length - 1];
    if (!currentScope.has(name)) {
      currentScope.set(name, ctx.state.env[name]);
    }
    const prefix = `${name}_`;
    for (const key of Object.keys(ctx.state.env)) {
      if (key.startsWith(prefix) && !key.includes("__")) {
        if (!currentScope.has(key)) {
          currentScope.set(key, ctx.state.env[key]);
        }
      }
    }
    const lengthKey = `${name}__length`;
    if (ctx.state.env[lengthKey] !== void 0 && !currentScope.has(lengthKey)) {
      currentScope.set(lengthKey, ctx.state.env[lengthKey]);
    }
  }, "saveArrayToLocalScope");
  const markAsLocalIfNeeded = /* @__PURE__ */ __name((name) => {
    if (createLocal) {
      markLocalVarDepth(ctx, name);
    }
  }, "markAsLocalIfNeeded");
  if (functionNamesOnly) {
    if (processedArgs.length === 0) {
      const funcNames = Array.from(ctx.state.functions.keys()).sort();
      let stdout2 = "";
      for (const name of funcNames) {
        stdout2 += `declare -f ${name}
`;
      }
      return success(stdout2);
    }
    let allExist = true;
    let stdout = "";
    for (const name of processedArgs) {
      if (ctx.state.functions.has(name)) {
        stdout += `${name}
`;
      } else {
        allExist = false;
      }
    }
    return result(stdout, "", allExist ? 0 : 1);
  }
  if (functionMode) {
    if (processedArgs.length === 0) {
      let stdout = "";
      const funcNames = Array.from(ctx.state.functions.keys()).sort();
      for (const name of funcNames) {
        stdout += `${name} ()
{
    # function body
}
`;
      }
      return success(stdout);
    }
    let allExist = true;
    for (const name of processedArgs) {
      if (!ctx.state.functions.has(name)) {
        allExist = false;
      }
    }
    return result("", "", allExist ? 0 : 1);
  }
  if (printMode && processedArgs.length > 0) {
    return printSpecificVariables(ctx, processedArgs);
  }
  if (printMode && processedArgs.length === 0) {
    return printAllVariables(ctx, {
      filterExport: declareExport,
      filterReadonly: declareReadonly,
      filterNameref: declareNameref,
      filterIndexedArray: declareArray,
      filterAssocArray: declareAssoc
    });
  }
  if (processedArgs.length === 0 && declareAssoc && !printMode) {
    return listAssociativeArrays(ctx);
  }
  if (processedArgs.length === 0 && declareArray && !printMode) {
    return listIndexedArrays(ctx);
  }
  if (processedArgs.length === 0 && !printMode) {
    return listAllVariables(ctx);
  }
  let stderr = "";
  let exitCode = 0;
  for (const arg of processedArgs) {
    const arrayMatch = arg.match(/^([a-zA-Z_][a-zA-Z0-9_]*)=\((.*)\)$/s);
    if (arrayMatch && !removeArray) {
      const name = arrayMatch[1];
      const content = arrayMatch[2];
      if (declareAssoc) {
        const existingIndices = getArrayIndices(ctx, name);
        if (existingIndices.length > 0) {
          stderr += `bash: declare: ${name}: cannot convert indexed to associative array
`;
          exitCode = 1;
          continue;
        }
      }
      if (declareArray || !declareAssoc && !declareArray) {
        if (ctx.state.associativeArrays?.has(name)) {
          stderr += `bash: declare: ${name}: cannot convert associative to indexed array
`;
          exitCode = 1;
          continue;
        }
      }
      saveArrayToLocalScope(name);
      if (declareAssoc) {
        ctx.state.associativeArrays ??= /* @__PURE__ */ new Set();
        ctx.state.associativeArrays.add(name);
      }
      clearArray(ctx, name);
      delete ctx.state.env[name];
      delete ctx.state.env[`${name}__length`];
      if (declareAssoc && content.includes("[")) {
        const entries = parseAssocArrayLiteral(content);
        for (const [key, rawValue] of entries) {
          const value = expandTildesInValue(ctx, rawValue);
          ctx.state.env[`${name}_${key}`] = value;
        }
      } else if (declareAssoc) {
        const elements = parseArrayElements(content);
        for (let i = 0; i < elements.length; i += 2) {
          const key = elements[i];
          const value = i + 1 < elements.length ? expandTildesInValue(ctx, elements[i + 1]) : "";
          ctx.state.env[`${name}_${key}`] = value;
        }
      } else {
        const elements = parseArrayElements(content);
        const hasKeyedElements = elements.some((el) => /^\[[^\]]+\]=/.test(el));
        if (hasKeyedElements) {
          let currentIndex = 0;
          for (const element of elements) {
            const keyedMatch = element.match(/^\[([^\]]+)\]=(.*)$/);
            if (keyedMatch) {
              const indexExpr = keyedMatch[1];
              const rawValue = keyedMatch[2];
              const value = expandTildesInValue(ctx, rawValue);
              let index;
              if (/^-?\d+$/.test(indexExpr)) {
                index = Number.parseInt(indexExpr, 10);
              } else {
                try {
                  const parser = new Parser();
                  const arithAst = parseArithmeticExpression(parser, indexExpr);
                  index = await evaluateArithmetic(ctx, arithAst.expression);
                } catch {
                  index = 0;
                }
              }
              ctx.state.env[`${name}_${index}`] = value;
              currentIndex = index + 1;
            } else {
              const value = expandTildesInValue(ctx, element);
              ctx.state.env[`${name}_${currentIndex}`] = value;
              currentIndex++;
            }
          }
        } else {
          for (let i = 0; i < elements.length; i++) {
            ctx.state.env[`${name}_${i}`] = elements[i];
          }
          ctx.state.env[`${name}__length`] = String(elements.length);
        }
      }
      markAsLocalIfNeeded(name);
      if (declareReadonly) {
        markReadonly(ctx, name);
      }
      if (declareExport) {
        markExported(ctx, name);
      }
      continue;
    }
    if (removeNameref) {
      const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
      unmarkNameref(ctx, name);
      if (!arg.includes("=")) {
        continue;
      }
    }
    if (removeExport) {
      const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
      unmarkExported(ctx, name);
      if (!arg.includes("=")) {
        continue;
      }
    }
    const arrayAssignMatch = parseArrayAssignment(arg);
    if (arrayAssignMatch) {
      const { name, indexExpr, value } = arrayAssignMatch;
      const error = checkReadonlyError(ctx, name);
      if (error)
        return error;
      saveArrayToLocalScope(name);
      let index;
      try {
        const parser = new Parser();
        const arithAst = parseArithmeticExpression(parser, indexExpr);
        index = await evaluateArithmetic(ctx, arithAst.expression);
      } catch {
        const num = parseInt(indexExpr, 10);
        index = Number.isNaN(num) ? 0 : num;
      }
      ctx.state.env[`${name}_${index}`] = value;
      const currentLength = parseInt(ctx.state.env[`${name}__length`] ?? "0", 10);
      if (index >= currentLength) {
        ctx.state.env[`${name}__length`] = String(index + 1);
      }
      markAsLocalIfNeeded(name);
      if (declareReadonly) {
        markReadonly(ctx, name);
      }
      if (declareExport) {
        markExported(ctx, name);
      }
      continue;
    }
    const arrayAppendMatch = arg.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\+=\((.*)\)$/s);
    if (arrayAppendMatch && !removeArray) {
      const name = arrayAppendMatch[1];
      const content = arrayAppendMatch[2];
      const error = checkReadonlyError(ctx, name);
      if (error)
        return error;
      saveArrayToLocalScope(name);
      const newElements = parseArrayElements(content);
      if (ctx.state.associativeArrays?.has(name)) {
        const entries = parseAssocArrayLiteral(content);
        for (const [key, rawValue] of entries) {
          const value = expandTildesInValue(ctx, rawValue);
          ctx.state.env[`${name}_${key}`] = value;
        }
      } else {
        const existingIndices = getArrayIndices(ctx, name);
        let startIndex = 0;
        if (existingIndices.length === 0 && ctx.state.env[name] !== void 0) {
          const scalarValue = ctx.state.env[name];
          ctx.state.env[`${name}_0`] = scalarValue;
          delete ctx.state.env[name];
          startIndex = 1;
        } else if (existingIndices.length > 0) {
          startIndex = Math.max(...existingIndices) + 1;
        }
        for (let i = 0; i < newElements.length; i++) {
          ctx.state.env[`${name}_${startIndex + i}`] = expandTildesInValue(ctx, newElements[i]);
        }
        const newLength = startIndex + newElements.length;
        ctx.state.env[`${name}__length`] = String(newLength);
      }
      markAsLocalIfNeeded(name);
      if (declareReadonly) {
        markReadonly(ctx, name);
      }
      if (declareExport) {
        markExported(ctx, name);
      }
      continue;
    }
    const appendMatch = arg.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\+=(.*)$/);
    if (appendMatch) {
      const name = appendMatch[1];
      let appendValue = expandTildesInValue(ctx, appendMatch[2]);
      const error = checkReadonlyError(ctx, name);
      if (error)
        return error;
      saveToLocalScope(name);
      if (declareInteger) {
        markInteger(ctx, name);
      }
      if (declareLowercase) {
        markLowercase(ctx, name);
      }
      if (declareUppercase) {
        markUppercase(ctx, name);
      }
      const existingIndices = getArrayIndices(ctx, name);
      const isArray2 = existingIndices.length > 0 || ctx.state.associativeArrays?.has(name);
      if (isInteger(ctx, name)) {
        const existing = ctx.state.env[name] ?? "0";
        const existingNum = parseInt(existing, 10) || 0;
        const appendNum = parseInt(await evaluateIntegerValue(ctx, appendValue), 10) || 0;
        appendValue = String(existingNum + appendNum);
        ctx.state.env[name] = appendValue;
      } else if (isArray2) {
        appendValue = applyCaseTransform(ctx, name, appendValue);
        const element0Key = `${name}_0`;
        const existing = ctx.state.env[element0Key] ?? "";
        ctx.state.env[element0Key] = existing + appendValue;
      } else {
        appendValue = applyCaseTransform(ctx, name, appendValue);
        const existing = ctx.state.env[name] ?? "";
        ctx.state.env[name] = existing + appendValue;
      }
      markAsLocalIfNeeded(name);
      if (declareReadonly) {
        markReadonly(ctx, name);
      }
      if (declareExport) {
        markExported(ctx, name);
      }
      if (ctx.state.options.allexport && !removeExport) {
        ctx.state.exportedVars = ctx.state.exportedVars || /* @__PURE__ */ new Set();
        ctx.state.exportedVars.add(name);
      }
      continue;
    }
    if (arg.includes("=")) {
      const eqIdx = arg.indexOf("=");
      const name = arg.slice(0, eqIdx);
      let value = arg.slice(eqIdx + 1);
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
        stderr += `bash: typeset: \`${name}': not a valid identifier
`;
        exitCode = 1;
        continue;
      }
      const error = checkReadonlyError(ctx, name);
      if (error)
        return error;
      saveToLocalScope(name);
      if (declareNameref) {
        if (value !== "" && !/^[a-zA-Z_][a-zA-Z0-9_]*(\[.+\])?$/.test(value)) {
          stderr += `bash: declare: \`${value}': invalid variable name for name reference
`;
          exitCode = 1;
          continue;
        }
        ctx.state.env[name] = value;
        markNameref(ctx, name);
        if (value !== "" && targetExists(ctx, value)) {
          markNamerefBound(ctx, name);
        }
        markAsLocalIfNeeded(name);
        if (declareReadonly) {
          markReadonly(ctx, name);
        }
        if (declareExport) {
          markExported(ctx, name);
        }
        continue;
      }
      if (declareInteger) {
        markInteger(ctx, name);
      }
      if (declareLowercase) {
        markLowercase(ctx, name);
      }
      if (declareUppercase) {
        markUppercase(ctx, name);
      }
      if (isInteger(ctx, name)) {
        value = await evaluateIntegerValue(ctx, value);
      }
      value = applyCaseTransform(ctx, name, value);
      if (isNameref(ctx, name)) {
        const resolved = resolveNameref(ctx, name);
        if (resolved && resolved !== name) {
          ctx.state.env[resolved] = value;
        } else {
          ctx.state.env[name] = value;
        }
      } else {
        ctx.state.env[name] = value;
      }
      markAsLocalIfNeeded(name);
      if (declareReadonly) {
        markReadonly(ctx, name);
      }
      if (declareExport) {
        markExported(ctx, name);
      }
      if (ctx.state.options.allexport && !removeExport) {
        ctx.state.exportedVars = ctx.state.exportedVars || /* @__PURE__ */ new Set();
        ctx.state.exportedVars.add(name);
      }
    } else {
      const name = arg;
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
        stderr += `bash: typeset: \`${name}': not a valid identifier
`;
        exitCode = 1;
        continue;
      }
      if (declareArray || declareAssoc) {
        saveArrayToLocalScope(name);
      } else {
        saveToLocalScope(name);
      }
      if (declareNameref) {
        markNameref(ctx, name);
        const existingValue = ctx.state.env[name];
        if (existingValue !== void 0 && existingValue !== "" && !/^[a-zA-Z_][a-zA-Z0-9_]*(\[.+\])?$/.test(existingValue)) {
          markNamerefInvalid(ctx, name);
        } else if (existingValue && targetExists(ctx, existingValue)) {
          markNamerefBound(ctx, name);
        }
        markAsLocalIfNeeded(name);
        if (declareReadonly) {
          markReadonly(ctx, name);
        }
        if (declareExport) {
          markExported(ctx, name);
        }
        continue;
      }
      if (declareInteger) {
        markInteger(ctx, name);
      }
      if (declareLowercase) {
        markLowercase(ctx, name);
      }
      if (declareUppercase) {
        markUppercase(ctx, name);
      }
      if (declareAssoc) {
        const existingIndices = getArrayIndices(ctx, name);
        if (existingIndices.length > 0) {
          stderr += `bash: declare: ${name}: cannot convert indexed to associative array
`;
          exitCode = 1;
          continue;
        }
        ctx.state.associativeArrays ??= /* @__PURE__ */ new Set();
        ctx.state.associativeArrays.add(name);
      }
      const hasArrayElements = Object.keys(ctx.state.env).some((key) => key.startsWith(`${name}_`) && !key.startsWith(`${name}__length`));
      if (!(name in ctx.state.env) && !hasArrayElements) {
        if (declareArray || declareAssoc) {
          ctx.state.env[`${name}__length`] = "0";
        } else {
          ctx.state.declaredVars ??= /* @__PURE__ */ new Set();
          ctx.state.declaredVars.add(name);
        }
      }
      markAsLocalIfNeeded(name);
      if (declareReadonly) {
        markReadonly(ctx, name);
      }
      if (declareExport) {
        markExported(ctx, name);
      }
    }
  }
  return result("", stderr, exitCode);
}
__name(handleDeclare, "handleDeclare");
async function handleReadonly(ctx, args) {
  let _declareArray = false;
  let _declareAssoc = false;
  let _printMode = false;
  const processedArgs = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-a") {
      _declareArray = true;
    } else if (arg === "-A") {
      _declareAssoc = true;
    } else if (arg === "-p") {
      _printMode = true;
    } else if (arg === "--") {
      processedArgs.push(...args.slice(i + 1));
      break;
    } else if (!arg.startsWith("-")) {
      processedArgs.push(arg);
    }
  }
  if (processedArgs.length === 0) {
    let stdout = "";
    const readonlyNames = Array.from(ctx.state.readonlyVars || []).sort();
    for (const name of readonlyNames) {
      const value = ctx.state.env[name];
      if (value !== void 0) {
        const escapedValue = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        stdout += `declare -r ${name}="${escapedValue}"
`;
      }
    }
    return success(stdout);
  }
  for (const arg of processedArgs) {
    const arrayAppendMatch = arg.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\+=\((.*)\)$/s);
    if (arrayAppendMatch) {
      const name = arrayAppendMatch[1];
      const content = arrayAppendMatch[2];
      const error2 = checkReadonlyError(ctx, name);
      if (error2)
        return error2;
      const newElements = parseArrayElements(content);
      if (ctx.state.associativeArrays?.has(name)) {
        const entries = parseAssocArrayLiteral(content);
        for (const [key, rawValue] of entries) {
          const value = expandTildesInValue(ctx, rawValue);
          ctx.state.env[`${name}_${key}`] = value;
        }
      } else {
        const existingIndices = getArrayIndices(ctx, name);
        let startIndex = 0;
        if (existingIndices.length === 0 && ctx.state.env[name] !== void 0) {
          const scalarValue = ctx.state.env[name];
          ctx.state.env[`${name}_0`] = scalarValue;
          delete ctx.state.env[name];
          startIndex = 1;
        } else if (existingIndices.length > 0) {
          startIndex = Math.max(...existingIndices) + 1;
        }
        for (let i = 0; i < newElements.length; i++) {
          ctx.state.env[`${name}_${startIndex + i}`] = expandTildesInValue(ctx, newElements[i]);
        }
        const newLength = startIndex + newElements.length;
        ctx.state.env[`${name}__length`] = String(newLength);
      }
      markReadonly(ctx, name);
      continue;
    }
    const appendMatch = arg.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\+=(.*)$/);
    if (appendMatch) {
      const name = appendMatch[1];
      const appendValue = expandTildesInValue(ctx, appendMatch[2]);
      const error2 = checkReadonlyError(ctx, name);
      if (error2)
        return error2;
      const existing = ctx.state.env[name] ?? "";
      ctx.state.env[name] = existing + appendValue;
      markReadonly(ctx, name);
      continue;
    }
    const assignment = parseAssignment(arg);
    if (assignment.value === void 0 && !assignment.isArray) {
      markReadonly(ctx, assignment.name);
      continue;
    }
    const error = await setVariable(ctx, assignment, { makeReadonly: true });
    if (error) {
      return error;
    }
  }
  return OK;
}
__name(handleReadonly, "handleReadonly");

// dist/interpreter/builtins/dirs.js
function getStack(ctx) {
  ctx.state.directoryStack ??= [];
  return ctx.state.directoryStack;
}
__name(getStack, "getStack");
function formatPath(path, home) {
  if (home && path === home) {
    return "~";
  }
  if (home && path.startsWith(`${home}/`)) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}
__name(formatPath, "formatPath");
function normalizePath(path) {
  const parts = path.split("/").filter((p) => p && p !== ".");
  const result2 = [];
  for (const part of parts) {
    if (part === "..") {
      result2.pop();
    } else {
      result2.push(part);
    }
  }
  return `/${result2.join("/")}`;
}
__name(normalizePath, "normalizePath");
async function handlePushd(ctx, args) {
  const stack = getStack(ctx);
  let targetDir;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      if (i + 1 < args.length) {
        if (targetDir !== void 0) {
          return failure("bash: pushd: too many arguments\n", 2);
        }
        targetDir = args[i + 1];
        i++;
      }
    } else if (arg.startsWith("-") && arg !== "-") {
      return failure(`bash: pushd: ${arg}: invalid option
`, 2);
    } else {
      if (targetDir !== void 0) {
        return failure("bash: pushd: too many arguments\n", 2);
      }
      targetDir = arg;
    }
  }
  if (targetDir === void 0) {
    if (stack.length < 2) {
      return failure("bash: pushd: no other directory\n", 1);
    }
    const top = stack[0];
    stack[0] = stack[1];
    stack[1] = top;
    targetDir = stack[0];
  }
  let resolvedDir;
  if (targetDir.startsWith("/")) {
    resolvedDir = targetDir;
  } else if (targetDir === "..") {
    const parts = ctx.state.cwd.split("/").filter((p) => p);
    parts.pop();
    resolvedDir = `/${parts.join("/")}`;
  } else if (targetDir === ".") {
    resolvedDir = ctx.state.cwd;
  } else if (targetDir.startsWith("~")) {
    const home2 = ctx.state.env.HOME || "/";
    resolvedDir = home2 + targetDir.slice(1);
  } else {
    resolvedDir = `${ctx.state.cwd}/${targetDir}`;
  }
  resolvedDir = normalizePath(resolvedDir);
  try {
    const stat = await ctx.fs.stat(resolvedDir);
    if (!stat.isDirectory) {
      return failure(`bash: pushd: ${targetDir}: Not a directory
`, 1);
    }
  } catch {
    return failure(`bash: pushd: ${targetDir}: No such file or directory
`, 1);
  }
  stack.unshift(ctx.state.cwd);
  ctx.state.previousDir = ctx.state.cwd;
  ctx.state.cwd = resolvedDir;
  ctx.state.env.PWD = resolvedDir;
  ctx.state.env.OLDPWD = ctx.state.previousDir;
  const home = ctx.state.env.HOME || "";
  const output = `${[resolvedDir, ...stack].map((p) => formatPath(p, home)).join(" ")}
`;
  return success(output);
}
__name(handlePushd, "handlePushd");
function handlePopd(ctx, args) {
  const stack = getStack(ctx);
  for (const arg of args) {
    if (arg === "--") {
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      return failure(`bash: popd: ${arg}: invalid option
`, 2);
    }
    return failure("bash: popd: too many arguments\n", 2);
  }
  if (stack.length === 0) {
    return failure("bash: popd: directory stack empty\n", 1);
  }
  const newDir = stack.shift();
  if (!newDir) {
    return failure("bash: popd: directory stack empty\n", 1);
  }
  ctx.state.previousDir = ctx.state.cwd;
  ctx.state.cwd = newDir;
  ctx.state.env.PWD = newDir;
  ctx.state.env.OLDPWD = ctx.state.previousDir;
  const home = ctx.state.env.HOME || "";
  const output = `${[newDir, ...stack].map((p) => formatPath(p, home)).join(" ")}
`;
  return success(output);
}
__name(handlePopd, "handlePopd");
function handleDirs(ctx, args) {
  const stack = getStack(ctx);
  let clearStack = false;
  let longFormat = false;
  let perLine = false;
  let withNumbers = false;
  for (const arg of args) {
    if (arg === "--") {
      continue;
    }
    if (arg.startsWith("-")) {
      for (const flag of arg.slice(1)) {
        if (flag === "c")
          clearStack = true;
        else if (flag === "l")
          longFormat = true;
        else if (flag === "p")
          perLine = true;
        else if (flag === "v") {
          perLine = true;
          withNumbers = true;
        } else {
          return failure(`bash: dirs: -${flag}: invalid option
`, 2);
        }
      }
    } else {
      return failure("bash: dirs: too many arguments\n", 1);
    }
  }
  if (clearStack) {
    ctx.state.directoryStack = [];
    return OK;
  }
  const fullStack = [ctx.state.cwd, ...stack];
  const home = ctx.state.env.HOME || "";
  let output;
  if (withNumbers) {
    output = fullStack.map((p, i) => {
      const path = longFormat ? p : formatPath(p, home);
      return ` ${i}  ${path}`;
    }).join("\n");
    output += "\n";
  } else if (perLine) {
    output = fullStack.map((p) => longFormat ? p : formatPath(p, home)).join("\n") + "\n";
  } else {
    output = fullStack.map((p) => longFormat ? p : formatPath(p, home)).join(" ") + "\n";
  }
  return success(output);
}
__name(handleDirs, "handleDirs");

// dist/interpreter/builtins/eval.js
async function handleEval(ctx, args, stdin) {
  let evalArgs = args;
  if (evalArgs.length > 0) {
    const first = evalArgs[0];
    if (first === "--") {
      evalArgs = evalArgs.slice(1);
    } else if (first.startsWith("-") && first !== "-" && first.length > 1) {
      return failure(`bash: eval: ${first}: invalid option
eval: usage: eval [arg ...]
`, 2);
    }
  }
  if (evalArgs.length === 0) {
    return OK;
  }
  const command = evalArgs.join(" ");
  if (command.trim() === "") {
    return OK;
  }
  const savedGroupStdin = ctx.state.groupStdin;
  const effectiveStdin = stdin ?? ctx.state.groupStdin;
  if (effectiveStdin !== void 0) {
    ctx.state.groupStdin = effectiveStdin;
  }
  try {
    const ast = parse(command);
    return await ctx.executeScript(ast);
  } catch (error) {
    if (error instanceof BreakError || error instanceof ContinueError || error instanceof ReturnError || error instanceof ExitError) {
      throw error;
    }
    if (error.name === "ParseException") {
      return failure(`bash: eval: ${error.message}
`);
    }
    throw error;
  } finally {
    ctx.state.groupStdin = savedGroupStdin;
  }
}
__name(handleEval, "handleEval");

// dist/interpreter/builtins/exit.js
function handleExit(ctx, args) {
  let exitCode;
  let stderr = "";
  if (args.length === 0) {
    exitCode = ctx.state.lastExitCode;
  } else {
    const arg = args[0];
    const parsed = Number.parseInt(arg, 10);
    if (arg === "" || Number.isNaN(parsed) || !/^-?\d+$/.test(arg)) {
      stderr = `bash: exit: ${arg}: numeric argument required
`;
      exitCode = 2;
    } else {
      exitCode = (parsed % 256 + 256) % 256;
    }
  }
  throw new ExitError(exitCode, "", stderr);
}
__name(handleExit, "handleExit");

// dist/interpreter/builtins/export.js
function handleExport(ctx, args) {
  let unexport = false;
  const processedArgs = [];
  for (const arg of args) {
    if (arg === "-n") {
      unexport = true;
    } else if (arg === "-p") {
    } else if (arg === "--") {
    } else {
      processedArgs.push(arg);
    }
  }
  if (processedArgs.length === 0 && !unexport) {
    let stdout = "";
    const exportedVars = ctx.state.exportedVars ?? /* @__PURE__ */ new Set();
    const sortedNames = Array.from(exportedVars).sort();
    for (const name of sortedNames) {
      const value = ctx.state.env[name];
      if (value !== void 0) {
        const escapedValue = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        stdout += `declare -x ${name}="${escapedValue}"
`;
      }
    }
    return success(stdout);
  }
  if (unexport) {
    for (const arg of processedArgs) {
      let name;
      let value;
      if (arg.includes("=")) {
        const eqIdx = arg.indexOf("=");
        name = arg.slice(0, eqIdx);
        value = expandTildesInValue(ctx, arg.slice(eqIdx + 1));
        ctx.state.env[name] = value;
      } else {
        name = arg;
      }
      unmarkExported(ctx, name);
    }
    return OK;
  }
  let stderr = "";
  let exitCode = 0;
  for (const arg of processedArgs) {
    let name;
    let value;
    let isAppend = false;
    const appendMatch = arg.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\+=(.*)$/);
    if (appendMatch) {
      name = appendMatch[1];
      value = expandTildesInValue(ctx, appendMatch[2]);
      isAppend = true;
    } else if (arg.includes("=")) {
      const eqIdx = arg.indexOf("=");
      name = arg.slice(0, eqIdx);
      value = expandTildesInValue(ctx, arg.slice(eqIdx + 1));
    } else {
      name = arg;
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      stderr += `bash: export: \`${arg}': not a valid identifier
`;
      exitCode = 1;
      continue;
    }
    if (value !== void 0) {
      if (isAppend) {
        const existing = ctx.state.env[name] ?? "";
        ctx.state.env[name] = existing + value;
      } else {
        ctx.state.env[name] = value;
      }
    } else {
      if (!(name in ctx.state.env)) {
        ctx.state.env[name] = "";
      }
    }
    markExported(ctx, name);
  }
  return result("", stderr, exitCode);
}
__name(handleExport, "handleExport");

// dist/interpreter/builtins/getopts.js
function handleGetopts(ctx, args) {
  if (args.length < 2) {
    return failure("bash: getopts: usage: getopts optstring name [arg ...]\n");
  }
  const optstring = args[0];
  const varName = args[1];
  const invalidVarName = !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(varName);
  const silentMode = optstring.startsWith(":");
  const actualOptstring = silentMode ? optstring.slice(1) : optstring;
  let argsToProcess;
  if (args.length > 2) {
    argsToProcess = args.slice(2);
  } else {
    const paramCount = Number.parseInt(ctx.state.env["#"] || "0", 10);
    argsToProcess = [];
    for (let i = 1; i <= paramCount; i++) {
      argsToProcess.push(ctx.state.env[String(i)] || "");
    }
  }
  let optind = Number.parseInt(ctx.state.env.OPTIND || "1", 10);
  if (optind < 1) {
    optind = 1;
  }
  const charIndex = Number.parseInt(ctx.state.env.__GETOPTS_CHARINDEX || "0", 10);
  ctx.state.env.OPTARG = "";
  if (optind > argsToProcess.length) {
    if (!invalidVarName) {
      ctx.state.env[varName] = "?";
    }
    ctx.state.env.OPTIND = String(argsToProcess.length + 1);
    ctx.state.env.__GETOPTS_CHARINDEX = "0";
    return { exitCode: invalidVarName ? 2 : 1, stdout: "", stderr: "" };
  }
  const currentArg = argsToProcess[optind - 1];
  if (!currentArg || currentArg === "-" || !currentArg.startsWith("-")) {
    if (!invalidVarName) {
      ctx.state.env[varName] = "?";
    }
    return { exitCode: invalidVarName ? 2 : 1, stdout: "", stderr: "" };
  }
  if (currentArg === "--") {
    ctx.state.env.OPTIND = String(optind + 1);
    ctx.state.env.__GETOPTS_CHARINDEX = "0";
    if (!invalidVarName) {
      ctx.state.env[varName] = "?";
    }
    return { exitCode: invalidVarName ? 2 : 1, stdout: "", stderr: "" };
  }
  const startIndex = charIndex === 0 ? 1 : charIndex;
  const optChar = currentArg[startIndex];
  if (!optChar) {
    ctx.state.env.OPTIND = String(optind + 1);
    ctx.state.env.__GETOPTS_CHARINDEX = "0";
    return handleGetopts(ctx, args);
  }
  const optIndex = actualOptstring.indexOf(optChar);
  if (optIndex === -1) {
    let stderrMsg = "";
    if (!silentMode) {
      stderrMsg = `bash: illegal option -- ${optChar}
`;
    } else {
      ctx.state.env.OPTARG = optChar;
    }
    if (!invalidVarName) {
      ctx.state.env[varName] = "?";
    }
    if (startIndex + 1 < currentArg.length) {
      ctx.state.env.__GETOPTS_CHARINDEX = String(startIndex + 1);
      ctx.state.env.OPTIND = String(optind);
    } else {
      ctx.state.env.OPTIND = String(optind + 1);
      ctx.state.env.__GETOPTS_CHARINDEX = "0";
    }
    return { exitCode: invalidVarName ? 2 : 0, stdout: "", stderr: stderrMsg };
  }
  const requiresArg = optIndex + 1 < actualOptstring.length && actualOptstring[optIndex + 1] === ":";
  if (requiresArg) {
    if (startIndex + 1 < currentArg.length) {
      ctx.state.env.OPTARG = currentArg.slice(startIndex + 1);
      ctx.state.env.OPTIND = String(optind + 1);
      ctx.state.env.__GETOPTS_CHARINDEX = "0";
    } else {
      if (optind >= argsToProcess.length) {
        let stderrMsg = "";
        if (!silentMode) {
          stderrMsg = `bash: option requires an argument -- ${optChar}
`;
          if (!invalidVarName) {
            ctx.state.env[varName] = "?";
          }
        } else {
          ctx.state.env.OPTARG = optChar;
          if (!invalidVarName) {
            ctx.state.env[varName] = ":";
          }
        }
        ctx.state.env.OPTIND = String(optind + 1);
        ctx.state.env.__GETOPTS_CHARINDEX = "0";
        return {
          exitCode: invalidVarName ? 2 : 0,
          stdout: "",
          stderr: stderrMsg
        };
      }
      ctx.state.env.OPTARG = argsToProcess[optind];
      ctx.state.env.OPTIND = String(optind + 2);
      ctx.state.env.__GETOPTS_CHARINDEX = "0";
    }
  } else {
    if (startIndex + 1 < currentArg.length) {
      ctx.state.env.__GETOPTS_CHARINDEX = String(startIndex + 1);
      ctx.state.env.OPTIND = String(optind);
    } else {
      ctx.state.env.OPTIND = String(optind + 1);
      ctx.state.env.__GETOPTS_CHARINDEX = "0";
    }
  }
  if (!invalidVarName) {
    ctx.state.env[varName] = optChar;
  }
  return { exitCode: invalidVarName ? 2 : 0, stdout: "", stderr: "" };
}
__name(handleGetopts, "handleGetopts");

// dist/interpreter/builtins/hash.js
async function handleHash(ctx, args) {
  if (!ctx.state.hashTable) {
    ctx.state.hashTable = /* @__PURE__ */ new Map();
  }
  let clearTable = false;
  let deleteMode = false;
  let listMode = false;
  let pathMode = false;
  let showPath = false;
  let pathname = "";
  const names = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--") {
      i++;
      names.push(...args.slice(i));
      break;
    }
    if (arg === "-r") {
      clearTable = true;
      i++;
    } else if (arg === "-d") {
      deleteMode = true;
      i++;
    } else if (arg === "-l") {
      listMode = true;
      i++;
    } else if (arg === "-t") {
      showPath = true;
      i++;
    } else if (arg === "-p") {
      pathMode = true;
      i++;
      if (i >= args.length) {
        return failure("bash: hash: -p: option requires an argument\n", 1);
      }
      pathname = args[i];
      i++;
    } else if (arg.startsWith("-") && arg.length > 1) {
      for (const char of arg.slice(1)) {
        if (char === "r") {
          clearTable = true;
        } else if (char === "d") {
          deleteMode = true;
        } else if (char === "l") {
          listMode = true;
        } else if (char === "t") {
          showPath = true;
        } else if (char === "p") {
          return failure("bash: hash: -p: option requires an argument\n", 1);
        } else {
          return failure(`bash: hash: -${char}: invalid option
`, 1);
        }
      }
      i++;
    } else {
      names.push(arg);
      i++;
    }
  }
  if (clearTable) {
    ctx.state.hashTable.clear();
    return OK;
  }
  if (deleteMode) {
    if (names.length === 0) {
      return failure("bash: hash: -d: option requires an argument\n", 1);
    }
    let hasError2 = false;
    let stderr2 = "";
    for (const name of names) {
      if (!ctx.state.hashTable.has(name)) {
        stderr2 += `bash: hash: ${name}: not found
`;
        hasError2 = true;
      } else {
        ctx.state.hashTable.delete(name);
      }
    }
    if (hasError2) {
      return failure(stderr2, 1);
    }
    return OK;
  }
  if (showPath) {
    if (names.length === 0) {
      return failure("bash: hash: -t: option requires an argument\n", 1);
    }
    let stdout = "";
    let hasError2 = false;
    let stderr2 = "";
    for (const name of names) {
      const cachedPath = ctx.state.hashTable.get(name);
      if (cachedPath) {
        if (names.length > 1) {
          stdout += `${name}	${cachedPath}
`;
        } else {
          stdout += `${cachedPath}
`;
        }
      } else {
        stderr2 += `bash: hash: ${name}: not found
`;
        hasError2 = true;
      }
    }
    if (hasError2) {
      return { exitCode: 1, stdout, stderr: stderr2 };
    }
    return success(stdout);
  }
  if (pathMode) {
    if (names.length === 0) {
      return failure("bash: hash: usage: hash [-lr] [-p pathname] [-dt] [name ...]\n", 1);
    }
    const name = names[0];
    ctx.state.hashTable.set(name, pathname);
    return OK;
  }
  if (names.length === 0) {
    if (ctx.state.hashTable.size === 0) {
      return success("hash: hash table empty\n");
    }
    let stdout = "";
    if (listMode) {
      for (const [name, path] of ctx.state.hashTable) {
        stdout += `builtin hash -p ${path} ${name}
`;
      }
    } else {
      stdout = "hits	command\n";
      for (const [, path] of ctx.state.hashTable) {
        stdout += `   1	${path}
`;
      }
    }
    return success(stdout);
  }
  let hasError = false;
  let stderr = "";
  const pathEnv = ctx.state.env.PATH || "/usr/bin:/bin";
  const pathDirs = pathEnv.split(":");
  for (const name of names) {
    if (name.includes("/")) {
      stderr += `bash: hash: ${name}: cannot use / in name
`;
      hasError = true;
      continue;
    }
    let found = false;
    for (const dir of pathDirs) {
      if (!dir)
        continue;
      const fullPath = `${dir}/${name}`;
      if (await ctx.fs.exists(fullPath)) {
        ctx.state.hashTable.set(name, fullPath);
        found = true;
        break;
      }
    }
    if (!found) {
      stderr += `bash: hash: ${name}: not found
`;
      hasError = true;
    }
  }
  if (hasError) {
    return failure(stderr, 1);
  }
  return OK;
}
__name(handleHash, "handleHash");

// dist/interpreter/builtins/help.js
var BUILTIN_HELP = {
  ":": [
    ": [arguments]",
    `Null command.
    No effect; the command does nothing.
    Exit Status:
    Always succeeds.`
  ],
  ".": [
    ". filename [arguments]",
    `Execute commands from a file in the current shell.
    Read and execute commands from FILENAME in the current shell.
    The entries in $PATH are used to find the directory containing FILENAME.
    Exit Status:
    Returns the status of the last command executed in FILENAME.`
  ],
  "[": [
    "[ arg... ]",
    `Evaluate conditional expression.
    This is a synonym for the "test" builtin, but the last argument must
    be a literal \`]', to match the opening \`['.`
  ],
  alias: [
    "alias [-p] [name[=value] ... ]",
    `Define or display aliases.
    Without arguments, \`alias' prints the list of aliases in the reusable
    form \`alias NAME=VALUE' on standard output.
    Exit Status:
    alias returns true unless a NAME is supplied for which no alias has been
    defined.`
  ],
  bg: [
    "bg [job_spec ...]",
    `Move jobs to the background.
    Place the jobs identified by each JOB_SPEC in the background, as if they
    had been started with \`&'.`
  ],
  break: [
    "break [n]",
    `Exit for, while, or until loops.
    Exit a FOR, WHILE or UNTIL loop.  If N is specified, break N enclosing
    loops.
    Exit Status:
    The exit status is 0 unless N is not greater than or equal to 1.`
  ],
  builtin: [
    "builtin [shell-builtin [arg ...]]",
    `Execute shell builtins.
    Execute SHELL-BUILTIN with arguments ARGs without performing command
    lookup.  This is useful when you wish to reimplement a shell builtin
    as a shell function, but need to execute the builtin within the function.
    Exit Status:
    Returns the exit status of SHELL-BUILTIN, or false if SHELL-BUILTIN is
    not a shell builtin.`
  ],
  caller: [
    "caller [expr]",
    `Return the context of the current subroutine call.
    Without EXPR, returns "$line $filename".  With EXPR, returns
    "$line $subroutine $filename"; this extra information can be used to
    provide a stack trace.
    Exit Status:
    Returns 0 unless the shell is not executing a subroutine call or
    EXPR is invalid.`
  ],
  cd: [
    "cd [-L|-P] [dir]",
    `Change the shell working directory.
    Change the current directory to DIR.  The default DIR is the value of the
    HOME shell variable.

    The variable CDPATH defines the search path for the directory containing
    DIR.  Alternative directory names in CDPATH are separated by a colon (:).
    A null directory name is the same as the current directory.  If DIR begins
    with a slash (/), then CDPATH is not used.

    If the directory is not found, and the shell option \`cdable_vars' is set,
    the word is assumed to be a variable name.  If that variable has a value,
    its value is used for DIR.

    Options:
      -L	force symbolic links to be followed
      -P	use the physical directory structure without following symbolic
    	links

    The default is to follow symbolic links, as if \`-L' were specified.

    Exit Status:
    Returns 0 if the directory is changed; non-zero otherwise.`
  ],
  command: [
    "command [-pVv] command [arg ...]",
    `Execute a simple command or display information about commands.
    Runs COMMAND with ARGS suppressing shell function lookup, or display
    information about the specified COMMANDs.

    Options:
      -p	use a default value for PATH that is guaranteed to find all of
    	the standard utilities
      -v	print a description of COMMAND similar to the \`type' builtin
      -V	print a more verbose description of each COMMAND

    Exit Status:
    Returns exit status of COMMAND, or failure if COMMAND is not found.`
  ],
  compgen: [
    "compgen [-abcdefgjksuv] [-o option] [-A action] [-G globpat] [-W wordlist]  [-F function] [-C command] [-X filterpat] [-P prefix] [-S suffix] [word]",
    `Display possible completions depending on the options.
    Intended to be used from within a shell function generating possible
    completions.  If the optional WORD argument is supplied, matches against
    WORD are generated.
    Exit Status:
    Returns success unless an invalid option is supplied or an error occurs.`
  ],
  complete: [
    "complete [-abcdefgjksuv] [-pr] [-DEI] [-o option] [-A action] [-G globpat] [-W wordlist]  [-F function] [-C command] [-X filterpat] [-P prefix] [-S suffix] [name ...]",
    `Specify how arguments are to be completed.
    For each NAME, specify how arguments are to be completed.
    Exit Status:
    Returns success unless an invalid option is supplied or an error occurs.`
  ],
  continue: [
    "continue [n]",
    `Resume for, while, or until loops.
    Resumes the next iteration of the enclosing FOR, WHILE or UNTIL loop.
    If N is specified, resumes the Nth enclosing loop.
    Exit Status:
    The exit status is 0 unless N is not greater than or equal to 1.`
  ],
  declare: [
    "declare [-aAfFgilnrtux] [-p] [name[=value] ...]",
    `Set variable values and attributes.
    Declare variables and give them attributes.  If no NAMEs are given,
    display the attributes and values of all variables.

    Options:
      -a	to make NAMEs indexed arrays (if supported)
      -A	to make NAMEs associative arrays (if supported)
      -i	to make NAMEs have the \`integer' attribute
      -l	to convert the value of each NAME to lower case on assignment
      -n	make NAME a reference to the variable named by its value
      -r	to make NAMEs readonly
      -t	to make NAMEs have the \`trace' attribute
      -u	to convert the value of each NAME to upper case on assignment
      -x	to make NAMEs export

    Exit Status:
    Returns success unless an invalid option is supplied or a variable
    assignment error occurs.`
  ],
  dirs: [
    "dirs [-clpv] [+N] [-N]",
    `Display directory stack.
    Display the list of currently remembered directories.  Directories
    find their way onto the list with the \`pushd' command; you can get
    back up through the list with the \`popd' command.
    Exit Status:
    Returns success unless an invalid option is supplied or an error occurs.`
  ],
  disown: [
    "disown [-h] [-ar] [jobspec ...]",
    `Remove jobs from current shell.
    Without any JOBSPECs, remove the current job.`
  ],
  echo: [
    "echo [-neE] [arg ...]",
    `Write arguments to the standard output.
    Display the ARGs, separated by a single space character and followed by a
    newline, on the standard output.

    Options:
      -n	do not append a newline
      -e	enable interpretation of the following backslash escapes
      -E	explicitly suppress interpretation of backslash escapes

    Exit Status:
    Returns success unless a write error occurs.`
  ],
  enable: [
    "enable [-a] [-dnps] [-f filename] [name ...]",
    `Enable and disable shell builtins.
    Enables and disables builtin shell commands.
    Exit Status:
    Returns success unless NAME is not a shell builtin or an error occurs.`
  ],
  eval: [
    "eval [arg ...]",
    `Execute arguments as a shell command.
    Combine ARGs into a single string, use the result as input to the shell,
    and execute the resulting commands.
    Exit Status:
    Returns exit status of command or success if command is null.`
  ],
  exec: [
    "exec [-cl] [-a name] [command [arguments ...]] [redirection ...]",
    `Replace the shell with the given command.
    Execute COMMAND, replacing this shell with the specified program.
    ARGUMENTS become the arguments to COMMAND.  If COMMAND is not specified,
    any redirections take effect in the current shell.
    Exit Status:
    Returns success unless COMMAND is not found or a redirection error occurs.`
  ],
  exit: [
    "exit [n]",
    `Exit the shell.
    Exits the shell with a status of N.  If N is omitted, the exit status
    is that of the last command executed.`
  ],
  export: [
    "export [-fn] [name[=value] ...] or export -p",
    `Set export attribute for shell variables.
    Marks each NAME for automatic export to the environment of subsequently
    executed commands.  If VALUE is supplied, assign VALUE before exporting.

    Options:
      -f	refer to shell functions
      -n	remove the export property from each NAME
      -p	display a list of all exported variables and functions

    Exit Status:
    Returns success unless an invalid option is given or NAME is invalid.`
  ],
  false: [
    "false",
    `Return an unsuccessful result.
    Exit Status:
    Always fails.`
  ],
  fc: [
    "fc [-e ename] [-lnr] [first] [last] or fc -s [pat=rep] [command]",
    `Display or execute commands from the history list.
    Exit Status:
    Returns success or status of executed command.`
  ],
  fg: [
    "fg [job_spec]",
    `Move job to the foreground.
    Place the job identified by JOB_SPEC in the foreground, making it the
    current job.`
  ],
  getopts: [
    "getopts optstring name [arg]",
    `Parse option arguments.
    Getopts is used by shell procedures to parse positional parameters
    as options.

    OPTSTRING contains the option letters to be recognized; if a letter
    is followed by a colon, the option is expected to have an argument,
    which should be separated from it by white space.
    Exit Status:
    Returns success if an option is found; fails if the end of options is
    encountered or an error occurs.`
  ],
  hash: [
    "hash [-lr] [-p pathname] [-dt] [name ...]",
    `Remember or display program locations.
    Determine and remember the full pathname of each command NAME.
    Exit Status:
    Returns success unless NAME is not found or an invalid option is given.`
  ],
  help: [
    "help [-s] [pattern ...]",
    `Display information about builtin commands.
    Displays brief summaries of builtin commands.  If PATTERN is
    specified, gives detailed help on all commands matching PATTERN,
    otherwise the list of help topics is printed.

    Options:
      -s	output only a short usage synopsis for each topic matching
    	PATTERN

    Exit Status:
    Returns success unless PATTERN is not found.`
  ],
  history: [
    "history [-c] [-d offset] [n] or history -anrw [filename] or history -ps arg [arg...]",
    `Display or manipulate the history list.
    Display the history list with line numbers, prefixing each modified
    entry with a \`*'.
    Exit Status:
    Returns success unless an invalid option is given or an error occurs.`
  ],
  jobs: [
    "jobs [-lnprs] [jobspec ...] or jobs -x command [args]",
    `Display status of jobs.
    Lists the active jobs.
    Exit Status:
    Returns success unless an invalid option is given or an error occurs.`
  ],
  kill: [
    "kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]",
    `Send a signal to a job.
    Send the processes identified by PID or JOBSPEC the signal named by
    SIGSPEC or SIGNUM.
    Exit Status:
    Returns success unless an invalid option is given or an error occurs.`
  ],
  let: [
    "let arg [arg ...]",
    `Evaluate arithmetic expressions.
    Evaluate each ARG as an arithmetic expression.  Evaluation is done in
    fixed-width integers with no check for overflow, though division by 0
    is trapped and flagged as an error.
    Exit Status:
    If the last ARG evaluates to 0, let returns 1; 0 is returned otherwise.`
  ],
  local: [
    "local [option] name[=value] ...",
    `Define local variables.
    Create a local variable called NAME, and give it VALUE.  OPTION can
    be any option accepted by \`declare'.

    Local can only be used within a function; it makes the variable NAME
    have a visible scope restricted to that function and its children.
    Exit Status:
    Returns success unless an invalid option is supplied, a variable
    assignment error occurs, or the shell is not executing a function.`
  ],
  logout: [
    "logout [n]",
    `Exit a login shell.
    Exits a login shell with exit status N.  Returns an error if not executed
    in a login shell.`
  ],
  mapfile: [
    "mapfile [-d delim] [-n count] [-O origin] [-s count] [-t] [-u fd] [-C callback] [-c quantum] [array]",
    `Read lines from the standard input into an indexed array variable.
    Read lines from the standard input into the indexed array variable ARRAY,
    or from file descriptor FD if the -u option is supplied.

    Options:
      -d delim	Use DELIM to terminate lines, instead of newline
      -n count	Copy at most COUNT lines
      -O origin	Begin assigning to ARRAY at index ORIGIN
      -s count	Discard the first COUNT lines read
      -t	Remove a trailing DELIM from each line read (default newline)
      -u fd	Read lines from file descriptor FD instead of standard input

    Exit Status:
    Returns success unless an invalid option is given or ARRAY is readonly.`
  ],
  popd: [
    "popd [-n] [+N | -N]",
    `Remove directories from stack.
    Removes entries from the directory stack.
    Exit Status:
    Returns success unless an invalid argument is supplied or the directory
    change fails.`
  ],
  printf: [
    "printf [-v var] format [arguments]",
    `Formats and prints ARGUMENTS under control of the FORMAT.

    Options:
      -v var	assign the output to shell variable VAR rather than
    		display it on the standard output

    FORMAT is a character string which contains three types of objects: plain
    characters, which are simply copied to standard output; character escape
    sequences, which are converted and copied to the standard output; and
    format specifications, each of which causes printing of the next successive
    argument.
    Exit Status:
    Returns success unless an invalid option is given or a write or assignment
    error occurs.`
  ],
  pushd: [
    "pushd [-n] [+N | -N | dir]",
    `Add directories to stack.
    Adds a directory to the top of the directory stack, or rotates
    the stack, making the new top of the stack the current working
    directory.
    Exit Status:
    Returns success unless an invalid argument is supplied or the directory
    change fails.`
  ],
  pwd: [
    "pwd [-LP]",
    `Print the name of the current working directory.

    Options:
      -L	print the value of $PWD if it names the current working
    	directory
      -P	print the physical directory, without any symbolic links

    By default, \`pwd' behaves as if \`-L' were specified.
    Exit Status:
    Returns 0 unless an invalid option is given or the current directory
    cannot be read.`
  ],
  read: [
    "read [-ers] [-a array] [-d delim] [-i text] [-n nchars] [-N nchars] [-p prompt] [-t timeout] [-u fd] [name ...]",
    `Read a line from the standard input and split it into fields.
    Reads a single line from the standard input, or from file descriptor FD
    if the -u option is supplied.  The line is split into fields as with word
    splitting, and the first word is assigned to the first NAME, the second
    word to the second NAME, and so on, with any leftover words assigned to
    the last NAME.
    Exit Status:
    The return code is zero, unless end-of-file is encountered, read times out,
    or an invalid file descriptor is supplied as the argument to -u.`
  ],
  readarray: [
    "readarray [-d delim] [-n count] [-O origin] [-s count] [-t] [-u fd] [-C callback] [-c quantum] [array]",
    `Read lines from a file into an array variable.
    A synonym for \`mapfile'.`
  ],
  readonly: [
    "readonly [-aAf] [name[=value] ...] or readonly -p",
    `Mark shell variables as unchangeable.
    Mark each NAME as read-only; the values of these NAMEs may not be
    changed by subsequent assignment.
    Exit Status:
    Returns success unless an invalid option is given or NAME is invalid.`
  ],
  return: [
    "return [n]",
    `Return from a shell function.
    Causes a function or sourced script to exit with the return value
    specified by N.  If N is omitted, the return status is that of the
    last command executed within the function or script.
    Exit Status:
    Returns N, or failure if the shell is not executing a function or script.`
  ],
  set: [
    "set [-abefhkmnptuvxBCHP] [-o option-name] [--] [arg ...]",
    `Set or unset values of shell options and positional parameters.
    Change the value of shell attributes and positional parameters, or
    display the names and values of shell variables.

    Options:
      -e  Exit immediately if a command exits with a non-zero status.
      -u  Treat unset variables as an error when substituting.
      -x  Print commands and their arguments as they are executed.
      -o option-name
          Set the variable corresponding to option-name

    Exit Status:
    Returns success unless an invalid option is given.`
  ],
  shift: [
    "shift [n]",
    `Shift positional parameters.
    Rename the positional parameters $N+1,$N+2 ... to $1,$2 ...  If N is
    not given, it is assumed to be 1.
    Exit Status:
    Returns success unless N is negative or greater than $#.`
  ],
  shopt: [
    "shopt [-pqsu] [-o] [optname ...]",
    `Set and unset shell options.
    Change the setting of each shell option OPTNAME.  Without any option
    arguments, list each supplied OPTNAME, or all shell options if no
    OPTNAMEs are given, with an indication of whether or not each is set.

    Options:
      -o	restrict OPTNAMEs to those defined for use with \`set -o'
      -p	print each shell option with an indication of its status
      -q	suppress output
      -s	enable (set) each OPTNAME
      -u	disable (unset) each OPTNAME

    Exit Status:
    Returns success if OPTNAME is enabled; fails if an invalid option is
    given or OPTNAME is disabled.`
  ],
  source: [
    "source filename [arguments]",
    `Execute commands from a file in the current shell.
    Read and execute commands from FILENAME in the current shell.
    The entries in $PATH are used to find the directory containing FILENAME.
    Exit Status:
    Returns the status of the last command executed in FILENAME.`
  ],
  suspend: [
    "suspend [-f]",
    `Suspend shell execution.
    Suspend the execution of this shell until it receives a SIGCONT signal.`
  ],
  test: [
    "test [expr]",
    `Evaluate conditional expression.
    Exits with a status of 0 (true) or 1 (false) depending on
    the evaluation of EXPR.  Expressions may be unary or binary.
    Exit Status:
    Returns success if EXPR evaluates to true; fails if EXPR evaluates to
    false or an invalid argument is given.`
  ],
  times: [
    "times",
    `Display process times.
    Prints the accumulated user and system times for the shell and all of its
    child processes.
    Exit Status:
    Always succeeds.`
  ],
  trap: [
    "trap [-lp] [[arg] signal_spec ...]",
    `Trap signals and other events.
    Defines and activates handlers to be run when the shell receives signals
    or other conditions.
    Exit Status:
    Returns success unless a SIGSPEC is invalid or an invalid option is given.`
  ],
  true: [
    "true",
    `Return a successful result.
    Exit Status:
    Always succeeds.`
  ],
  type: [
    "type [-afptP] name [name ...]",
    `Display information about command type.
    For each NAME, indicate how it would be interpreted if used as a
    command name.

    Options:
      -a	display all locations containing an executable named NAME
      -f	suppress shell function lookup
      -P	force a PATH search for each NAME, even if it is an alias,
    	builtin, or function, and returns the name of the disk file
    	that would be executed
      -p	returns either the name of the disk file that would be executed,
    	or nothing if \`type -t NAME' would not return \`file'
      -t	output a single word which is one of \`alias', \`keyword',
    	\`function', \`builtin', \`file' or \`', if NAME is an alias,
    	shell reserved word, shell function, shell builtin, disk file,
    	or not found, respectively

    Exit Status:
    Returns success if all of the NAMEs are found; fails if any are not found.`
  ],
  typeset: [
    "typeset [-aAfFgilnrtux] [-p] name[=value] ...",
    `Set variable values and attributes.
    A synonym for \`declare'.`
  ],
  ulimit: [
    "ulimit [-SHabcdefiklmnpqrstuvxPT] [limit]",
    `Modify shell resource limits.
    Provides control over the resources available to the shell and processes
    it creates, on systems that allow such control.
    Exit Status:
    Returns success unless an invalid option is supplied or an error occurs.`
  ],
  umask: [
    "umask [-p] [-S] [mode]",
    `Display or set file mode mask.
    Sets the user file-creation mask to MODE.  If MODE is omitted, prints
    the current value of the mask.
    Exit Status:
    Returns success unless MODE is invalid or an invalid option is given.`
  ],
  unalias: [
    "unalias [-a] name [name ...]",
    `Remove each NAME from the list of defined aliases.
    Exit Status:
    Returns success unless a NAME is not an existing alias.`
  ],
  unset: [
    "unset [-f] [-v] [-n] [name ...]",
    `Unset values and attributes of shell variables and functions.
    For each NAME, remove the corresponding variable or function.

    Options:
      -f	treat each NAME as a shell function
      -v	treat each NAME as a shell variable
      -n	treat each NAME as a name reference and unset the variable itself
    	rather than the variable it references

    Without options, unset first tries to unset a variable, and if that fails,
    tries to unset a function.
    Exit Status:
    Returns success unless an invalid option is given or a NAME is read-only.`
  ],
  wait: [
    "wait [-fn] [id ...]",
    `Wait for job completion and return exit status.
    Waits for each process identified by an ID, which may be a process ID or a
    job specification, and reports its termination status.
    Exit Status:
    Returns the status of the last ID; fails if ID is invalid or an invalid
    option is given.`
  ]
};
var ALL_BUILTINS = Object.keys(BUILTIN_HELP).sort();
function handleHelp(_ctx, args) {
  let shortForm = false;
  const patterns = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--") {
      i++;
      while (i < args.length) {
        patterns.push(args[i]);
        i++;
      }
      break;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        const flag = arg[j];
        if (flag === "s") {
          shortForm = true;
        } else {
          return failure(`bash: help: -${flag}: invalid option
`, 2);
        }
      }
      i++;
    } else {
      patterns.push(arg);
      i++;
    }
  }
  if (patterns.length === 0) {
    return listAllBuiltins();
  }
  let stdout = "";
  let hasError = false;
  let stderr = "";
  for (const pattern of patterns) {
    const matches = findMatchingBuiltins(pattern);
    if (matches.length === 0) {
      stderr += `bash: help: no help topics match \`${pattern}'.  Try \`help help' or \`man -k ${pattern}' or \`info ${pattern}'.
`;
      hasError = true;
      continue;
    }
    for (const name of matches) {
      const [synopsis, description] = BUILTIN_HELP[name];
      if (shortForm) {
        stdout += `${name}: ${synopsis}
`;
      } else {
        stdout += `${name}: ${synopsis}
${description}
`;
      }
    }
  }
  return {
    exitCode: hasError ? 1 : 0,
    stdout,
    stderr
  };
}
__name(handleHelp, "handleHelp");
function findMatchingBuiltins(pattern) {
  const regexPattern = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  const regex = new RegExp(`^${regexPattern}$`);
  return ALL_BUILTINS.filter((name) => regex.test(name));
}
__name(findMatchingBuiltins, "findMatchingBuiltins");
function listAllBuiltins() {
  const lines = [];
  lines.push("just-bash shell builtins");
  lines.push("These shell commands are defined internally. Type `help' to see this list.");
  lines.push("Type `help name' to find out more about the function `name'.");
  lines.push("");
  const maxWidth = 36;
  const builtins = ALL_BUILTINS.slice();
  const midpoint = Math.ceil(builtins.length / 2);
  for (let i = 0; i < midpoint; i++) {
    const left = builtins[i] || "";
    const right = builtins[i + midpoint] || "";
    const leftPadded = left.padEnd(maxWidth);
    lines.push(right ? `${leftPadded}${right}` : left);
  }
  return success(`${lines.join("\n")}
`);
}
__name(listAllBuiltins, "listAllBuiltins");

// dist/interpreter/builtins/let.js
function parseLetArgs(args) {
  const expressions = [];
  let current = "";
  let parenDepth = 0;
  for (const arg of args) {
    for (const ch of arg) {
      if (ch === "(")
        parenDepth++;
      else if (ch === ")")
        parenDepth--;
    }
    if (current) {
      current += ` ${arg}`;
    } else {
      current = arg;
    }
    if (parenDepth === 0) {
      expressions.push(current);
      current = "";
    }
  }
  if (current) {
    expressions.push(current);
  }
  return expressions;
}
__name(parseLetArgs, "parseLetArgs");
async function handleLet(ctx, args) {
  if (args.length === 0) {
    return failure("bash: let: expression expected\n");
  }
  const expressions = parseLetArgs(args);
  let lastResult = 0;
  for (const expr of expressions) {
    try {
      const script = parse(`(( ${expr} ))`);
      const statement = script.statements[0];
      if (statement && statement.pipelines.length > 0 && statement.pipelines[0].commands.length > 0) {
        const command = statement.pipelines[0].commands[0];
        if (command.type === "ArithmeticCommand") {
          const arithNode = command;
          lastResult = await evaluateArithmetic(ctx, arithNode.expression.expression);
        }
      }
    } catch (error) {
      return failure(`bash: let: ${expr}: ${error.message}
`);
    }
  }
  return result("", "", lastResult === 0 ? 1 : 0);
}
__name(handleLet, "handleLet");

// dist/interpreter/builtins/local.js
async function handleLocal(ctx, args) {
  if (ctx.state.localScopes.length === 0) {
    return failure("bash: local: can only be used in a function\n");
  }
  const currentScope = ctx.state.localScopes[ctx.state.localScopes.length - 1];
  let stderr = "";
  let exitCode = 0;
  let declareNameref = false;
  let declareArray = false;
  let _printMode = false;
  const processedArgs = [];
  for (const arg of args) {
    if (arg === "-n") {
      declareNameref = true;
    } else if (arg === "-a") {
      declareArray = true;
    } else if (arg === "-p") {
      _printMode = true;
    } else if (arg.startsWith("-") && !arg.includes("=")) {
      for (const flag of arg.slice(1)) {
        if (flag === "n")
          declareNameref = true;
        else if (flag === "a")
          declareArray = true;
        else if (flag === "p")
          _printMode = true;
      }
    } else {
      processedArgs.push(arg);
    }
  }
  if (processedArgs.length === 0) {
    let stdout = "";
    const localNames = Array.from(currentScope.keys()).filter((key) => !key.includes("_") || !key.match(/_\d+$/)).filter((key) => !key.includes("__length")).sort();
    for (const name of localNames) {
      const value = ctx.state.env[name];
      if (value !== void 0) {
        stdout += `${name}=${value}
`;
      }
    }
    return result(stdout, "", 0);
  }
  for (const arg of processedArgs) {
    let name;
    let value;
    const arrayMatch = arg.match(/^([a-zA-Z_][a-zA-Z0-9_]*)=\((.*)\)$/s);
    if (arrayMatch) {
      name = arrayMatch[1];
      const content = arrayMatch[2];
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
        stderr += `bash: local: \`${arg}': not a valid identifier
`;
        exitCode = 1;
        continue;
      }
      checkReadonlyError(ctx, name, "bash");
      if (!currentScope.has(name)) {
        currentScope.set(name, ctx.state.env[name]);
        const prefix2 = `${name}_`;
        for (const key of Object.keys(ctx.state.env)) {
          if (key.startsWith(prefix2) && !key.includes("__")) {
            if (!currentScope.has(key)) {
              currentScope.set(key, ctx.state.env[key]);
            }
          }
        }
      }
      const prefix = `${name}_`;
      for (const key of Object.keys(ctx.state.env)) {
        if (key.startsWith(prefix) && !key.includes("__")) {
          delete ctx.state.env[key];
        }
      }
      const elements = parseArrayElements(content);
      for (let i = 0; i < elements.length; i++) {
        ctx.state.env[`${name}_${i}`] = elements[i];
      }
      ctx.state.env[`${name}__length`] = String(elements.length);
      markLocalVarDepth(ctx, name);
      if (declareNameref) {
        markNameref(ctx, name);
      }
      continue;
    }
    const arrayAppendMatch = arg.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\+=\((.*)\)$/s);
    if (arrayAppendMatch) {
      name = arrayAppendMatch[1];
      const content = arrayAppendMatch[2];
      checkReadonlyError(ctx, name, "bash");
      if (!currentScope.has(name)) {
        currentScope.set(name, ctx.state.env[name]);
        const prefix = `${name}_`;
        for (const key of Object.keys(ctx.state.env)) {
          if (key.startsWith(prefix) && !key.includes("__")) {
            if (!currentScope.has(key)) {
              currentScope.set(key, ctx.state.env[key]);
            }
          }
        }
        const lengthKey = `${name}__length`;
        if (ctx.state.env[lengthKey] !== void 0 && !currentScope.has(lengthKey)) {
          currentScope.set(lengthKey, ctx.state.env[lengthKey]);
        }
      }
      const newElements = parseArrayElements(content);
      const existingIndices = getArrayIndices(ctx, name);
      let startIndex = 0;
      if (existingIndices.length === 0 && ctx.state.env[name] !== void 0) {
        const scalarValue = ctx.state.env[name];
        ctx.state.env[`${name}_0`] = scalarValue;
        delete ctx.state.env[name];
        startIndex = 1;
      } else if (existingIndices.length > 0) {
        startIndex = Math.max(...existingIndices) + 1;
      }
      for (let i = 0; i < newElements.length; i++) {
        ctx.state.env[`${name}_${startIndex + i}`] = expandTildesInValue(ctx, newElements[i]);
      }
      const newLength = startIndex + newElements.length;
      ctx.state.env[`${name}__length`] = String(newLength);
      markLocalVarDepth(ctx, name);
      if (declareNameref) {
        markNameref(ctx, name);
      }
      continue;
    }
    const appendMatch = arg.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\+=(.*)$/);
    if (appendMatch) {
      name = appendMatch[1];
      const appendValue = expandTildesInValue(ctx, appendMatch[2]);
      checkReadonlyError(ctx, name, "bash");
      if (!currentScope.has(name)) {
        currentScope.set(name, ctx.state.env[name]);
      }
      const existing = ctx.state.env[name] ?? "";
      ctx.state.env[name] = existing + appendValue;
      markLocalVarDepth(ctx, name);
      if (declareNameref) {
        markNameref(ctx, name);
      }
      continue;
    }
    const indexMatch = arg.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[([^\]]+)\]=(.*)$/s);
    if (indexMatch) {
      name = indexMatch[1];
      const indexExpr = indexMatch[2];
      const indexValue = expandTildesInValue(ctx, indexMatch[3]);
      checkReadonlyError(ctx, name, "bash");
      if (!currentScope.has(name)) {
        currentScope.set(name, ctx.state.env[name]);
        const prefix = `${name}_`;
        for (const key of Object.keys(ctx.state.env)) {
          if (key.startsWith(prefix) && !key.includes("__")) {
            if (!currentScope.has(key)) {
              currentScope.set(key, ctx.state.env[key]);
            }
          }
        }
        const lengthKey = `${name}__length`;
        if (ctx.state.env[lengthKey] !== void 0 && !currentScope.has(lengthKey)) {
          currentScope.set(lengthKey, ctx.state.env[lengthKey]);
        }
      }
      let index;
      try {
        const parser = new Parser();
        const arithAst = parseArithmeticExpression(parser, indexExpr);
        index = await evaluateArithmetic(ctx, arithAst.expression);
      } catch {
        const num = parseInt(indexExpr, 10);
        index = Number.isNaN(num) ? 0 : num;
      }
      ctx.state.env[`${name}_${index}`] = indexValue;
      const currentLength = parseInt(ctx.state.env[`${name}__length`] ?? "0", 10);
      if (index >= currentLength) {
        ctx.state.env[`${name}__length`] = String(index + 1);
      }
      markLocalVarDepth(ctx, name);
      if (declareNameref) {
        markNameref(ctx, name);
      }
      continue;
    }
    if (arg.includes("=")) {
      const eqIdx = arg.indexOf("=");
      name = arg.slice(0, eqIdx);
      value = expandTildesInValue(ctx, arg.slice(eqIdx + 1));
    } else {
      name = arg;
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      stderr += `bash: local: \`${arg}': not a valid identifier
`;
      exitCode = 1;
      continue;
    }
    const wasAlreadyLocal = currentScope.has(name);
    if (value !== void 0) {
      let savedValue = ctx.state.env[name];
      if (ctx.state.tempEnvBindings) {
        const tempEnvAccessed = ctx.state.accessedTempEnvVars?.has(name);
        const tempEnvMutated = ctx.state.mutatedTempEnvVars?.has(name);
        if (!tempEnvAccessed && !tempEnvMutated) {
          for (let i = ctx.state.tempEnvBindings.length - 1; i >= 0; i--) {
            const bindings = ctx.state.tempEnvBindings[i];
            if (bindings.has(name)) {
              savedValue = bindings.get(name);
              break;
            }
          }
        }
      }
      pushLocalVarStack(ctx, name, savedValue);
    }
    if (!wasAlreadyLocal) {
      let savedValue = ctx.state.env[name];
      if (ctx.state.tempEnvBindings) {
        for (let i = ctx.state.tempEnvBindings.length - 1; i >= 0; i--) {
          const bindings = ctx.state.tempEnvBindings[i];
          if (bindings.has(name)) {
            savedValue = bindings.get(name);
            break;
          }
        }
      }
      currentScope.set(name, savedValue);
      if (declareArray) {
        const prefix = `${name}_`;
        for (const key of Object.keys(ctx.state.env)) {
          if (key.startsWith(prefix) && !key.includes("__")) {
            if (!currentScope.has(key)) {
              currentScope.set(key, ctx.state.env[key]);
            }
          }
        }
        const lengthKey = `${name}__length`;
        if (ctx.state.env[lengthKey] !== void 0 && !currentScope.has(lengthKey)) {
          currentScope.set(lengthKey, ctx.state.env[lengthKey]);
        }
      }
    }
    if (declareArray && value === void 0) {
      const prefix = `${name}_`;
      for (const key of Object.keys(ctx.state.env)) {
        if (key.startsWith(prefix) && !key.includes("__")) {
          delete ctx.state.env[key];
        }
      }
      ctx.state.env[`${name}__length`] = "0";
    } else if (value !== void 0) {
      checkReadonlyError(ctx, name, "bash");
      if (declareNameref && value !== "" && !/^[a-zA-Z_][a-zA-Z0-9_]*(\[.+\])?$/.test(value)) {
        stderr += `bash: local: \`${value}': invalid variable name for name reference
`;
        exitCode = 1;
        continue;
      }
      ctx.state.env[name] = value;
      if (ctx.state.options.allexport) {
        ctx.state.exportedVars = ctx.state.exportedVars || /* @__PURE__ */ new Set();
        ctx.state.exportedVars.add(name);
      }
    } else {
      const hasTempEnvBinding = ctx.state.tempEnvBindings?.some((bindings) => bindings.has(name));
      if (!wasAlreadyLocal && !hasTempEnvBinding) {
        delete ctx.state.env[name];
      }
    }
    markLocalVarDepth(ctx, name);
    if (declareNameref) {
      markNameref(ctx, name);
    }
  }
  return result("", stderr, exitCode);
}
__name(handleLocal, "handleLocal");

// dist/interpreter/builtins/mapfile.js
function handleMapfile(ctx, args, stdin) {
  let delimiter = "\n";
  let maxCount = 0;
  let origin = 0;
  let skipCount = 0;
  let trimDelimiter = false;
  let arrayName = "MAPFILE";
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "-d" && i + 1 < args.length) {
      delimiter = args[i + 1] === "" ? "\0" : args[i + 1] || "\n";
      i += 2;
    } else if (arg === "-n" && i + 1 < args.length) {
      maxCount = Number.parseInt(args[i + 1], 10) || 0;
      i += 2;
    } else if (arg === "-O" && i + 1 < args.length) {
      origin = Number.parseInt(args[i + 1], 10) || 0;
      i += 2;
    } else if (arg === "-s" && i + 1 < args.length) {
      skipCount = Number.parseInt(args[i + 1], 10) || 0;
      i += 2;
    } else if (arg === "-t") {
      trimDelimiter = true;
      i++;
    } else if (arg === "-u" || arg === "-C" || arg === "-c") {
      i += 2;
    } else if (!arg.startsWith("-")) {
      arrayName = arg;
      i++;
    } else {
      i++;
    }
  }
  let effectiveStdin = stdin;
  if (!effectiveStdin && ctx.state.groupStdin !== void 0) {
    effectiveStdin = ctx.state.groupStdin;
  }
  const lines = [];
  let remaining = effectiveStdin;
  let lineCount = 0;
  let skipped = 0;
  while (remaining.length > 0) {
    const delimIndex = remaining.indexOf(delimiter);
    if (delimIndex === -1) {
      if (remaining.length > 0) {
        if (skipped < skipCount) {
          skipped++;
        } else if (maxCount === 0 || lineCount < maxCount) {
          let lastLine = remaining;
          const nulIdx = lastLine.indexOf("\0");
          if (nulIdx !== -1) {
            lastLine = lastLine.substring(0, nulIdx);
          }
          lines.push(lastLine);
          lineCount++;
        }
      }
      break;
    }
    let line = remaining.substring(0, delimIndex);
    const nulIndex = line.indexOf("\0");
    if (nulIndex !== -1) {
      line = line.substring(0, nulIndex);
    }
    if (!trimDelimiter && delimiter !== "\0") {
      line += delimiter;
    }
    remaining = remaining.substring(delimIndex + delimiter.length);
    if (skipped < skipCount) {
      skipped++;
      continue;
    }
    if (maxCount > 0 && lineCount >= maxCount) {
      break;
    }
    lines.push(line);
    lineCount++;
  }
  if (origin === 0) {
    clearArray(ctx, arrayName);
  }
  for (let j = 0; j < lines.length; j++) {
    ctx.state.env[`${arrayName}_${origin + j}`] = lines[j];
  }
  const existingLength = parseInt(ctx.state.env[`${arrayName}__length`] || "0", 10);
  const newEndIndex = origin + lines.length;
  ctx.state.env[`${arrayName}__length`] = String(Math.max(existingLength, newEndIndex));
  if (ctx.state.groupStdin !== void 0 && !stdin) {
    ctx.state.groupStdin = "";
  }
  return result("", "", 0);
}
__name(handleMapfile, "handleMapfile");

// dist/interpreter/builtins/read.js
function parseRwFdContent2(fdContent) {
  if (!fdContent.startsWith("__rw__:")) {
    return null;
  }
  const afterPrefix = fdContent.slice(7);
  const firstColonIdx = afterPrefix.indexOf(":");
  if (firstColonIdx === -1)
    return null;
  const pathLength = Number.parseInt(afterPrefix.slice(0, firstColonIdx), 10);
  if (Number.isNaN(pathLength) || pathLength < 0)
    return null;
  const pathStart = firstColonIdx + 1;
  const path = afterPrefix.slice(pathStart, pathStart + pathLength);
  const positionStart = pathStart + pathLength + 1;
  const remaining = afterPrefix.slice(positionStart);
  const posColonIdx = remaining.indexOf(":");
  if (posColonIdx === -1)
    return null;
  const position = Number.parseInt(remaining.slice(0, posColonIdx), 10);
  if (Number.isNaN(position) || position < 0)
    return null;
  const content = remaining.slice(posColonIdx + 1);
  return { path, position, content };
}
__name(parseRwFdContent2, "parseRwFdContent");
function encodeRwFdContent(path, position, content) {
  return `__rw__:${path.length}:${path}:${position}:${content}`;
}
__name(encodeRwFdContent, "encodeRwFdContent");
function handleRead(ctx, args, stdin, stdinSourceFd = -1) {
  let raw = false;
  let delimiter = "\n";
  let _prompt = "";
  let nchars = -1;
  let ncharsExact = -1;
  let arrayName = null;
  let fileDescriptor = -1;
  let timeout = -1;
  const varNames = [];
  let i = 0;
  let invalidNArg = false;
  const parseOption = /* @__PURE__ */ __name((opt, argIndex) => {
    let j = 1;
    while (j < opt.length) {
      const ch = opt[j];
      if (ch === "r") {
        raw = true;
        j++;
      } else if (ch === "s") {
        j++;
      } else if (ch === "d") {
        if (j + 1 < opt.length) {
          delimiter = opt.substring(j + 1);
          return { nextArgIndex: argIndex + 1 };
        } else if (argIndex + 1 < args.length) {
          delimiter = args[argIndex + 1];
          return { nextArgIndex: argIndex + 2 };
        }
        return { nextArgIndex: argIndex + 1 };
      } else if (ch === "n") {
        if (j + 1 < opt.length) {
          const numStr = opt.substring(j + 1);
          nchars = Number.parseInt(numStr, 10);
          if (Number.isNaN(nchars) || nchars < 0) {
            invalidNArg = true;
            nchars = 0;
          }
          return { nextArgIndex: argIndex + 1 };
        } else if (argIndex + 1 < args.length) {
          nchars = Number.parseInt(args[argIndex + 1], 10);
          if (Number.isNaN(nchars) || nchars < 0) {
            invalidNArg = true;
            nchars = 0;
          }
          return { nextArgIndex: argIndex + 2 };
        }
        return { nextArgIndex: argIndex + 1 };
      } else if (ch === "N") {
        if (j + 1 < opt.length) {
          const numStr = opt.substring(j + 1);
          ncharsExact = Number.parseInt(numStr, 10);
          if (Number.isNaN(ncharsExact) || ncharsExact < 0) {
            invalidNArg = true;
            ncharsExact = 0;
          }
          return { nextArgIndex: argIndex + 1 };
        } else if (argIndex + 1 < args.length) {
          ncharsExact = Number.parseInt(args[argIndex + 1], 10);
          if (Number.isNaN(ncharsExact) || ncharsExact < 0) {
            invalidNArg = true;
            ncharsExact = 0;
          }
          return { nextArgIndex: argIndex + 2 };
        }
        return { nextArgIndex: argIndex + 1 };
      } else if (ch === "a") {
        if (j + 1 < opt.length) {
          arrayName = opt.substring(j + 1);
          return { nextArgIndex: argIndex + 1 };
        } else if (argIndex + 1 < args.length) {
          arrayName = args[argIndex + 1];
          return { nextArgIndex: argIndex + 2 };
        }
        return { nextArgIndex: argIndex + 1 };
      } else if (ch === "p") {
        if (j + 1 < opt.length) {
          _prompt = opt.substring(j + 1);
          return { nextArgIndex: argIndex + 1 };
        } else if (argIndex + 1 < args.length) {
          _prompt = args[argIndex + 1];
          return { nextArgIndex: argIndex + 2 };
        }
        return { nextArgIndex: argIndex + 1 };
      } else if (ch === "u") {
        if (j + 1 < opt.length) {
          const numStr = opt.substring(j + 1);
          fileDescriptor = Number.parseInt(numStr, 10);
          if (Number.isNaN(fileDescriptor) || fileDescriptor < 0) {
            return { nextArgIndex: -2 };
          }
          return { nextArgIndex: argIndex + 1 };
        } else if (argIndex + 1 < args.length) {
          fileDescriptor = Number.parseInt(args[argIndex + 1], 10);
          if (Number.isNaN(fileDescriptor) || fileDescriptor < 0) {
            return { nextArgIndex: -2 };
          }
          return { nextArgIndex: argIndex + 2 };
        }
        return { nextArgIndex: argIndex + 1 };
      } else if (ch === "t") {
        if (j + 1 < opt.length) {
          const numStr = opt.substring(j + 1);
          timeout = Number.parseFloat(numStr);
          if (Number.isNaN(timeout)) {
            timeout = 0;
          }
          return { nextArgIndex: argIndex + 1 };
        } else if (argIndex + 1 < args.length) {
          timeout = Number.parseFloat(args[argIndex + 1]);
          if (Number.isNaN(timeout)) {
            timeout = 0;
          }
          return { nextArgIndex: argIndex + 2 };
        }
        return { nextArgIndex: argIndex + 1 };
      } else if (ch === "e" || ch === "i" || ch === "P") {
        if (ch === "i" && argIndex + 1 < args.length) {
          return { nextArgIndex: argIndex + 2 };
        }
        j++;
      } else {
        j++;
      }
    }
    return { nextArgIndex: argIndex + 1 };
  }, "parseOption");
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith("-") && arg.length > 1 && arg !== "--") {
      const parseResult = parseOption(arg, i);
      if (parseResult.nextArgIndex === -1) {
        return { stdout: "", stderr: "", exitCode: 2 };
      }
      if (parseResult.nextArgIndex === -2) {
        return { stdout: "", stderr: "", exitCode: 1 };
      }
      i = parseResult.nextArgIndex;
    } else if (arg === "--") {
      i++;
      while (i < args.length) {
        varNames.push(args[i]);
        i++;
      }
    } else {
      varNames.push(arg);
      i++;
    }
  }
  if (invalidNArg) {
    return result("", "", 1);
  }
  if (varNames.length === 0 && arrayName === null) {
    varNames.push("REPLY");
  }
  if (timeout === 0) {
    if (arrayName) {
      clearArray(ctx, arrayName);
    } else {
      for (const name of varNames) {
        ctx.state.env[name] = "";
      }
      if (varNames.length === 0) {
        ctx.state.env.REPLY = "";
      }
    }
    return result("", "", 0);
  }
  if (timeout < 0 && timeout !== -1) {
    return result("", "", 1);
  }
  let effectiveStdin = stdin;
  if (fileDescriptor >= 0) {
    if (ctx.state.fileDescriptors) {
      effectiveStdin = ctx.state.fileDescriptors.get(fileDescriptor) || "";
    } else {
      effectiveStdin = "";
    }
  } else if (!effectiveStdin && ctx.state.groupStdin !== void 0) {
    effectiveStdin = ctx.state.groupStdin;
  }
  const effectiveDelimiter = delimiter === "" ? "\0" : delimiter;
  let line = "";
  let consumed = 0;
  let foundDelimiter = true;
  const consumeInput = /* @__PURE__ */ __name((bytesConsumed) => {
    if (fileDescriptor >= 0 && ctx.state.fileDescriptors) {
      ctx.state.fileDescriptors.set(fileDescriptor, effectiveStdin.substring(bytesConsumed));
    } else if (stdinSourceFd >= 0 && ctx.state.fileDescriptors) {
      const fdContent = ctx.state.fileDescriptors.get(stdinSourceFd);
      if (fdContent?.startsWith("__rw__:")) {
        const parsed = parseRwFdContent2(fdContent);
        if (parsed) {
          const newPosition = parsed.position + bytesConsumed;
          ctx.state.fileDescriptors.set(stdinSourceFd, encodeRwFdContent(parsed.path, newPosition, parsed.content));
        }
      }
    } else if (ctx.state.groupStdin !== void 0 && !stdin) {
      ctx.state.groupStdin = effectiveStdin.substring(bytesConsumed);
    }
  }, "consumeInput");
  if (ncharsExact >= 0) {
    const toRead = Math.min(ncharsExact, effectiveStdin.length);
    line = effectiveStdin.substring(0, toRead);
    consumed = toRead;
    foundDelimiter = toRead >= ncharsExact;
    consumeInput(consumed);
    const varName = varNames[0] || "REPLY";
    ctx.state.env[varName] = line;
    for (let j = 1; j < varNames.length; j++) {
      ctx.state.env[varNames[j]] = "";
    }
    return result("", "", foundDelimiter ? 0 : 1);
  } else if (nchars >= 0) {
    let charCount = 0;
    let inputPos = 0;
    let hitDelimiter = false;
    while (inputPos < effectiveStdin.length && charCount < nchars) {
      const char = effectiveStdin[inputPos];
      if (char === effectiveDelimiter) {
        consumed = inputPos + 1;
        hitDelimiter = true;
        break;
      }
      if (!raw && char === "\\" && inputPos + 1 < effectiveStdin.length) {
        const nextChar = effectiveStdin[inputPos + 1];
        if (nextChar === effectiveDelimiter && effectiveDelimiter === "\n") {
          inputPos += 2;
          consumed = inputPos;
          continue;
        }
        if (nextChar === effectiveDelimiter) {
          inputPos += 2;
          charCount++;
          line += nextChar;
          consumed = inputPos;
          continue;
        }
        line += nextChar;
        inputPos += 2;
        charCount++;
        consumed = inputPos;
      } else {
        line += char;
        inputPos++;
        charCount++;
        consumed = inputPos;
      }
    }
    foundDelimiter = charCount >= nchars || hitDelimiter;
    consumeInput(consumed);
  } else {
    consumed = 0;
    let inputPos = 0;
    while (inputPos < effectiveStdin.length) {
      const char = effectiveStdin[inputPos];
      if (char === effectiveDelimiter) {
        consumed = inputPos + effectiveDelimiter.length;
        foundDelimiter = true;
        break;
      }
      if (!raw && char === "\\" && inputPos + 1 < effectiveStdin.length) {
        const nextChar = effectiveStdin[inputPos + 1];
        if (nextChar === "\n") {
          inputPos += 2;
          continue;
        }
        if (nextChar === effectiveDelimiter) {
          line += nextChar;
          inputPos += 2;
          continue;
        }
        line += char;
        line += nextChar;
        inputPos += 2;
        continue;
      }
      line += char;
      inputPos++;
    }
    if (inputPos >= effectiveStdin.length) {
      foundDelimiter = false;
      consumed = inputPos;
      if (line.length === 0 && effectiveStdin.length === 0) {
        for (const name of varNames) {
          ctx.state.env[name] = "";
        }
        if (arrayName) {
          clearArray(ctx, arrayName);
        }
        return result("", "", 1);
      }
    }
    consumeInput(consumed);
  }
  if (effectiveDelimiter === "\n" && line.endsWith("\n")) {
    line = line.slice(0, -1);
  }
  const processBackslashEscapes = /* @__PURE__ */ __name((s) => {
    if (raw)
      return s;
    return s.replace(/\\(.)/g, "$1");
  }, "processBackslashEscapes");
  if (varNames.length === 1 && varNames[0] === "REPLY") {
    ctx.state.env.REPLY = processBackslashEscapes(line);
    return result("", "", foundDelimiter ? 0 : 1);
  }
  const ifs = getIfs(ctx.state.env);
  if (arrayName) {
    const { words: words2 } = splitByIfsForRead(line, ifs, void 0, raw);
    clearArray(ctx, arrayName);
    for (let j = 0; j < words2.length; j++) {
      ctx.state.env[`${arrayName}_${j}`] = processBackslashEscapes(words2[j]);
    }
    return result("", "", foundDelimiter ? 0 : 1);
  }
  const maxSplit = varNames.length;
  const { words, wordStarts } = splitByIfsForRead(line, ifs, maxSplit, raw);
  for (let j = 0; j < varNames.length; j++) {
    const name = varNames[j];
    if (j < varNames.length - 1) {
      ctx.state.env[name] = processBackslashEscapes(words[j] ?? "");
    } else {
      if (j < wordStarts.length) {
        let value = line.substring(wordStarts[j]);
        value = stripTrailingIfsWhitespace(value, ifs, raw);
        value = processBackslashEscapes(value);
        ctx.state.env[name] = value;
      } else {
        ctx.state.env[name] = "";
      }
    }
  }
  return result("", "", foundDelimiter ? 0 : 1);
}
__name(handleRead, "handleRead");

// dist/interpreter/builtins/return.js
function handleReturn(ctx, args) {
  if (ctx.state.callDepth === 0 && ctx.state.sourceDepth === 0) {
    return failure("bash: return: can only `return' from a function or sourced script\n");
  }
  let exitCode = ctx.state.lastExitCode;
  if (args.length > 0) {
    const arg = args[0];
    const n = Number.parseInt(arg, 10);
    if (arg === "" || Number.isNaN(n) || !/^-?\d+$/.test(arg)) {
      return failure(`bash: return: ${arg}: numeric argument required
`, 2);
    }
    exitCode = (n % 256 + 256) % 256;
  }
  throw new ReturnError(exitCode);
}
__name(handleReturn, "handleReturn");

// dist/interpreter/builtins/set.js
var SET_USAGE = `set: usage: set [-eux] [+eux] [-o option] [+o option]
Options:
  -e            Exit immediately if a command exits with non-zero status
  +e            Disable -e
  -u            Treat unset variables as an error when substituting
  +u            Disable -u
  -x            Print commands and their arguments as they are executed
  +x            Disable -x
  -o errexit    Same as -e
  +o errexit    Disable errexit
  -o nounset    Same as -u
  +o nounset    Disable nounset
  -o pipefail   Return status of last failing command in pipeline
  +o pipefail   Disable pipefail
  -o xtrace     Same as -x
  +o xtrace     Disable xtrace
`;
var SHORT_OPTION_MAP = {
  e: "errexit",
  u: "nounset",
  x: "xtrace",
  v: "verbose",
  // Implemented options
  f: "noglob",
  C: "noclobber",
  a: "allexport",
  n: "noexec",
  // No-ops (accepted for compatibility)
  h: null,
  b: null,
  m: null,
  B: null,
  H: null,
  P: null,
  T: null,
  E: null,
  p: null
};
var LONG_OPTION_MAP = {
  errexit: "errexit",
  pipefail: "pipefail",
  nounset: "nounset",
  xtrace: "xtrace",
  verbose: "verbose",
  // Implemented options
  noclobber: "noclobber",
  noglob: "noglob",
  allexport: "allexport",
  noexec: "noexec",
  posix: "posix",
  vi: "vi",
  emacs: "emacs",
  // No-ops (accepted for compatibility)
  notify: null,
  monitor: null,
  braceexpand: null,
  histexpand: null,
  physical: null,
  functrace: null,
  errtrace: null,
  privileged: null,
  hashall: null,
  ignoreeof: null,
  "interactive-comments": null,
  keyword: null,
  onecmd: null
};
var DISPLAY_OPTIONS = [
  "errexit",
  "nounset",
  "pipefail",
  "verbose",
  "xtrace",
  "posix",
  "allexport",
  "noclobber",
  "noglob",
  "noexec",
  "vi",
  "emacs"
];
var NOOP_DISPLAY_OPTIONS = [
  "braceexpand",
  "errtrace",
  "functrace",
  "hashall",
  "histexpand",
  "history",
  "ignoreeof",
  "interactive-comments",
  "keyword",
  "monitor",
  "nolog",
  "notify",
  "onecmd",
  "physical",
  "privileged"
];
function setShellOption(ctx, optionKey, value) {
  if (optionKey !== null) {
    if (value) {
      if (optionKey === "vi") {
        ctx.state.options.emacs = false;
      } else if (optionKey === "emacs") {
        ctx.state.options.vi = false;
      }
    }
    ctx.state.options[optionKey] = value;
    updateShellopts(ctx);
  }
}
__name(setShellOption, "setShellOption");
function hasNonOptionArg(args, i) {
  return i + 1 < args.length && !args[i + 1].startsWith("-") && !args[i + 1].startsWith("+");
}
__name(hasNonOptionArg, "hasNonOptionArg");
function formatArrayOutput(ctx, arrayName) {
  const indices = getArrayIndices(ctx, arrayName);
  if (indices.length === 0) {
    return `${arrayName}=()`;
  }
  const elements = indices.map((i) => {
    const value = ctx.state.env[`${arrayName}_${i}`] ?? "";
    return `[${i}]=${quoteArrayValue(value)}`;
  });
  return `${arrayName}=(${elements.join(" ")})`;
}
__name(formatArrayOutput, "formatArrayOutput");
function quoteAssocKey(key) {
  if (/^[a-zA-Z0-9_]+$/.test(key)) {
    return key;
  }
  const escaped = key.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}
__name(quoteAssocKey, "quoteAssocKey");
function formatAssocArrayOutput(ctx, arrayName) {
  const keys = getAssocArrayKeys(ctx, arrayName);
  if (keys.length === 0) {
    return `${arrayName}=()`;
  }
  const elements = keys.map((k) => {
    const value = ctx.state.env[`${arrayName}_${k}`] ?? "";
    return `[${quoteAssocKey(k)}]=${quoteArrayValue(value)}`;
  });
  return `${arrayName}=(${elements.join(" ")} )`;
}
__name(formatAssocArrayOutput, "formatAssocArrayOutput");
function getIndexedArrayNames(ctx) {
  const arrayNames = /* @__PURE__ */ new Set();
  const assocArrays = ctx.state.associativeArrays ?? /* @__PURE__ */ new Set();
  for (const key of Object.keys(ctx.state.env)) {
    const match = key.match(/^([a-zA-Z_][a-zA-Z0-9_]*)_(\d+)$/);
    if (match) {
      const name = match[1];
      if (!assocArrays.has(name)) {
        arrayNames.add(name);
      }
    }
  }
  return arrayNames;
}
__name(getIndexedArrayNames, "getIndexedArrayNames");
function getAssocArrayNames(ctx) {
  return ctx.state.associativeArrays ?? /* @__PURE__ */ new Set();
}
__name(getAssocArrayNames, "getAssocArrayNames");
function handleSet(ctx, args) {
  if (args.includes("--help")) {
    return success(SET_USAGE);
  }
  if (args.length === 0) {
    const indexedArrayNames = getIndexedArrayNames(ctx);
    const assocArrayNames = getAssocArrayNames(ctx);
    const isAssocArrayElement = /* @__PURE__ */ __name((key) => {
      for (const arrayName of assocArrayNames) {
        const prefix = `${arrayName}_`;
        const metadataSuffix = `${arrayName}__length`;
        if (key === metadataSuffix) {
          continue;
        }
        if (key.startsWith(prefix)) {
          const elemKey = key.slice(prefix.length);
          if (elemKey.startsWith("_length")) {
            continue;
          }
          return true;
        }
      }
      return false;
    }, "isAssocArrayElement");
    const scalarEntries = [];
    for (const [key, value] of Object.entries(ctx.state.env)) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
        continue;
      }
      if (indexedArrayNames.has(key)) {
        continue;
      }
      if (assocArrayNames.has(key)) {
        continue;
      }
      const arrayElementMatch = key.match(/^([a-zA-Z_][a-zA-Z0-9_]*)_(\d+)$/);
      if (arrayElementMatch && indexedArrayNames.has(arrayElementMatch[1])) {
        continue;
      }
      const arrayMetadataMatch = key.match(/^([a-zA-Z_][a-zA-Z0-9_]*)__length$/);
      if (arrayMetadataMatch && indexedArrayNames.has(arrayMetadataMatch[1])) {
        continue;
      }
      if (isAssocArrayElement(key)) {
        continue;
      }
      if (arrayMetadataMatch && assocArrayNames.has(arrayMetadataMatch[1])) {
        continue;
      }
      scalarEntries.push([key, value]);
    }
    const lines = [];
    for (const [key, value] of scalarEntries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      lines.push(`${key}=${quoteValue(value)}`);
    }
    for (const arrayName of [...indexedArrayNames].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)) {
      lines.push(formatArrayOutput(ctx, arrayName));
    }
    for (const arrayName of [...assocArrayNames].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)) {
      lines.push(formatAssocArrayOutput(ctx, arrayName));
    }
    lines.sort((a, b) => {
      const nameA = a.split("=")[0];
      const nameB = b.split("=")[0];
      return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
    });
    return success(lines.length > 0 ? `${lines.join("\n")}
` : "");
  }
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if ((arg === "-o" || arg === "+o") && hasNonOptionArg(args, i)) {
      const optName = args[i + 1];
      if (!(optName in LONG_OPTION_MAP)) {
        const errorMsg = `bash: set: ${optName}: invalid option name
${SET_USAGE}`;
        if (ctx.state.options.posix) {
          throw new PosixFatalError(1, "", errorMsg);
        }
        return failure(errorMsg);
      }
      setShellOption(ctx, LONG_OPTION_MAP[optName], arg === "-o");
      i += 2;
      continue;
    }
    if (arg === "-o") {
      const implementedOutput = DISPLAY_OPTIONS.map((opt) => `${opt.padEnd(16)}${ctx.state.options[opt] ? "on" : "off"}`);
      const noopOutput = NOOP_DISPLAY_OPTIONS.map((opt) => `${opt.padEnd(16)}off`);
      const allOptions = [...implementedOutput, ...noopOutput].sort();
      return success(`${allOptions.join("\n")}
`);
    }
    if (arg === "+o") {
      const implementedOutput = DISPLAY_OPTIONS.map((opt) => `set ${ctx.state.options[opt] ? "-o" : "+o"} ${opt}`);
      const noopOutput = NOOP_DISPLAY_OPTIONS.map((opt) => `set +o ${opt}`);
      const allOptions = [...implementedOutput, ...noopOutput].sort();
      return success(`${allOptions.join("\n")}
`);
    }
    if (arg.length > 1 && (arg[0] === "-" || arg[0] === "+") && arg[1] !== "-") {
      const enable = arg[0] === "-";
      for (let j = 1; j < arg.length; j++) {
        const flag = arg[j];
        if (!(flag in SHORT_OPTION_MAP)) {
          const errorMsg = `bash: set: ${arg[0]}${flag}: invalid option
${SET_USAGE}`;
          if (ctx.state.options.posix) {
            throw new PosixFatalError(1, "", errorMsg);
          }
          return failure(errorMsg);
        }
        setShellOption(ctx, SHORT_OPTION_MAP[flag], enable);
      }
      i++;
      continue;
    }
    if (arg === "--") {
      setPositionalParameters(ctx, args.slice(i + 1));
      return OK;
    }
    if (arg === "-") {
      ctx.state.options.xtrace = false;
      ctx.state.options.verbose = false;
      updateShellopts(ctx);
      if (i + 1 < args.length) {
        setPositionalParameters(ctx, args.slice(i + 1));
        return OK;
      }
      i++;
      continue;
    }
    if (arg === "+") {
      i++;
      continue;
    }
    if (arg.startsWith("-") || arg.startsWith("+")) {
      const errorMsg = `bash: set: ${arg}: invalid option
${SET_USAGE}`;
      if (ctx.state.options.posix) {
        throw new PosixFatalError(1, "", errorMsg);
      }
      return failure(errorMsg);
    }
    setPositionalParameters(ctx, args.slice(i));
    return OK;
  }
  return OK;
}
__name(handleSet, "handleSet");
function setPositionalParameters(ctx, params) {
  let i = 1;
  while (ctx.state.env[String(i)] !== void 0) {
    delete ctx.state.env[String(i)];
    i++;
  }
  for (let j = 0; j < params.length; j++) {
    ctx.state.env[String(j + 1)] = params[j];
  }
  ctx.state.env["#"] = String(params.length);
  ctx.state.env["@"] = params.join(" ");
  ctx.state.env["*"] = params.join(" ");
}
__name(setPositionalParameters, "setPositionalParameters");

// dist/interpreter/builtins/shift.js
function handleShift(ctx, args) {
  let n = 1;
  if (args.length > 0) {
    const parsed = Number.parseInt(args[0], 10);
    if (Number.isNaN(parsed) || parsed < 0) {
      const errorMsg = `bash: shift: ${args[0]}: numeric argument required
`;
      if (ctx.state.options.posix) {
        throw new PosixFatalError(1, "", errorMsg);
      }
      return failure(errorMsg);
    }
    n = parsed;
  }
  const currentCount = Number.parseInt(ctx.state.env["#"] || "0", 10);
  if (n > currentCount) {
    const errorMsg = "bash: shift: shift count out of range\n";
    if (ctx.state.options.posix) {
      throw new PosixFatalError(1, "", errorMsg);
    }
    return failure(errorMsg);
  }
  if (n === 0) {
    return OK;
  }
  const params = [];
  for (let i = 1; i <= currentCount; i++) {
    params.push(ctx.state.env[String(i)] || "");
  }
  const newParams = params.slice(n);
  for (let i = 1; i <= currentCount; i++) {
    delete ctx.state.env[String(i)];
  }
  for (let i = 0; i < newParams.length; i++) {
    ctx.state.env[String(i + 1)] = newParams[i];
  }
  ctx.state.env["#"] = String(newParams.length);
  ctx.state.env["@"] = newParams.join(" ");
  return OK;
}
__name(handleShift, "handleShift");

// dist/interpreter/builtins/source.js
async function handleSource(ctx, args) {
  let sourceArgs = args;
  if (sourceArgs.length > 0 && sourceArgs[0] === "--") {
    sourceArgs = sourceArgs.slice(1);
  }
  if (sourceArgs.length === 0) {
    return result("", "bash: source: filename argument required\n", 2);
  }
  const filename = sourceArgs[0];
  let _resolvedPath = null;
  let content = null;
  if (filename.includes("/")) {
    const directPath = ctx.fs.resolvePath(ctx.state.cwd, filename);
    try {
      content = await ctx.fs.readFile(directPath);
      _resolvedPath = directPath;
    } catch {
    }
  } else {
    const pathEnv = ctx.state.env.PATH || "";
    const pathDirs = pathEnv.split(":").filter((d) => d);
    for (const dir of pathDirs) {
      const candidate = ctx.fs.resolvePath(ctx.state.cwd, `${dir}/${filename}`);
      try {
        const stat = await ctx.fs.stat(candidate);
        if (stat.isDirectory) {
          continue;
        }
        content = await ctx.fs.readFile(candidate);
        _resolvedPath = candidate;
        break;
      } catch {
      }
    }
    if (content === null) {
      const directPath = ctx.fs.resolvePath(ctx.state.cwd, filename);
      try {
        content = await ctx.fs.readFile(directPath);
        _resolvedPath = directPath;
      } catch {
      }
    }
  }
  if (content === null) {
    return failure(`bash: ${filename}: No such file or directory
`);
  }
  const savedPositional = {};
  if (sourceArgs.length > 1) {
    for (let i = 1; i <= 9; i++) {
      savedPositional[String(i)] = ctx.state.env[String(i)];
    }
    savedPositional["#"] = ctx.state.env["#"];
    savedPositional["@"] = ctx.state.env["@"];
    const scriptArgs = sourceArgs.slice(1);
    ctx.state.env["#"] = String(scriptArgs.length);
    ctx.state.env["@"] = scriptArgs.join(" ");
    for (let i = 0; i < scriptArgs.length && i < 9; i++) {
      ctx.state.env[String(i + 1)] = scriptArgs[i];
    }
    for (let i = scriptArgs.length + 1; i <= 9; i++) {
      delete ctx.state.env[String(i)];
    }
  }
  const savedSource = ctx.state.currentSource;
  const cleanup = /* @__PURE__ */ __name(() => {
    ctx.state.sourceDepth--;
    ctx.state.currentSource = savedSource;
    if (sourceArgs.length > 1) {
      for (const [key, value] of Object.entries(savedPositional)) {
        if (value === void 0) {
          delete ctx.state.env[key];
        } else {
          ctx.state.env[key] = value;
        }
      }
    }
  }, "cleanup");
  ctx.state.sourceDepth++;
  ctx.state.currentSource = filename;
  try {
    const ast = parse(content);
    const result2 = await ctx.executeScript(ast);
    cleanup();
    return result2;
  } catch (error) {
    cleanup();
    if (error instanceof ExitError) {
      throw error;
    }
    if (error instanceof ReturnError) {
      return result(error.stdout, error.stderr, error.exitCode);
    }
    if (error.name === "ParseException") {
      return failure(`bash: ${filename}: ${error.message}
`);
    }
    throw error;
  }
}
__name(handleSource, "handleSource");

// dist/interpreter/builtins/unset.js
function isValidVariableName(name) {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}
__name(isValidVariableName, "isValidVariableName");
function isQuotedStringIndex(indexExpr) {
  return indexExpr.startsWith("'") && indexExpr.endsWith("'") || indexExpr.startsWith('"') && indexExpr.endsWith('"');
}
__name(isQuotedStringIndex, "isQuotedStringIndex");
async function evaluateArrayIndex2(ctx, indexExpr) {
  if (isQuotedStringIndex(indexExpr)) {
    return null;
  }
  try {
    const parser = new Parser();
    const arithAst = parseArithmeticExpression(parser, indexExpr);
    return await evaluateArithmetic(ctx, arithAst.expression);
  } catch {
    const num = parseInt(indexExpr, 10);
    return Number.isNaN(num) ? 0 : num;
  }
}
__name(evaluateArrayIndex2, "evaluateArrayIndex");
function performCellUnset(ctx, varName) {
  const hasStackEntry = ctx.state.localVarStack?.has(varName);
  if (hasStackEntry) {
    const stackEntry = popLocalVarStack(ctx, varName);
    if (stackEntry) {
      if (stackEntry.value === void 0) {
        delete ctx.state.env[varName];
      } else {
        ctx.state.env[varName] = stackEntry.value;
      }
      const remainingStack = ctx.state.localVarStack?.get(varName);
      if (!remainingStack || remainingStack.length === 0) {
        clearLocalVarDepth(ctx, varName);
        ctx.state.localVarStack?.delete(varName);
        ctx.state.fullyUnsetLocals = ctx.state.fullyUnsetLocals || /* @__PURE__ */ new Map();
        ctx.state.fullyUnsetLocals.set(varName, stackEntry.scopeIndex);
        if (handleTempEnvUnset(ctx, varName)) {
        }
      } else {
        const topEntry = remainingStack[remainingStack.length - 1];
        ctx.state.localVarDepth = ctx.state.localVarDepth || /* @__PURE__ */ new Map();
        ctx.state.localVarDepth.set(varName, topEntry.scopeIndex + 1);
      }
      return true;
    }
    delete ctx.state.env[varName];
    clearLocalVarDepth(ctx, varName);
    ctx.state.localVarStack?.delete(varName);
    ctx.state.fullyUnsetLocals = ctx.state.fullyUnsetLocals || /* @__PURE__ */ new Map();
    ctx.state.fullyUnsetLocals.set(varName, 0);
    return true;
  }
  for (let i = ctx.state.localScopes.length - 1; i >= 0; i--) {
    const scope = ctx.state.localScopes[i];
    if (scope.has(varName)) {
      const outerValue = scope.get(varName);
      if (outerValue === void 0) {
        delete ctx.state.env[varName];
      } else {
        ctx.state.env[varName] = outerValue;
      }
      scope.delete(varName);
      let foundOuterScope = false;
      for (let j = i - 1; j >= 0; j--) {
        if (ctx.state.localScopes[j].has(varName)) {
          if (ctx.state.localVarDepth) {
            ctx.state.localVarDepth.set(varName, j + 1);
          }
          foundOuterScope = true;
          break;
        }
      }
      if (!foundOuterScope) {
        clearLocalVarDepth(ctx, varName);
      }
      return true;
    }
  }
  return false;
}
__name(performCellUnset, "performCellUnset");
function handleTempEnvUnset(ctx, varName) {
  if (!ctx.state.tempEnvBindings || ctx.state.tempEnvBindings.length === 0) {
    return false;
  }
  for (let i = ctx.state.tempEnvBindings.length - 1; i >= 0; i--) {
    const bindings = ctx.state.tempEnvBindings[i];
    if (bindings.has(varName)) {
      const underlyingValue = bindings.get(varName);
      if (underlyingValue === void 0) {
        delete ctx.state.env[varName];
      } else {
        ctx.state.env[varName] = underlyingValue;
      }
      bindings.delete(varName);
      return true;
    }
  }
  return false;
}
__name(handleTempEnvUnset, "handleTempEnvUnset");
async function expandAssocSubscript(ctx, subscriptExpr) {
  if (subscriptExpr.startsWith("'") && subscriptExpr.endsWith("'")) {
    return subscriptExpr.slice(1, -1);
  }
  if (subscriptExpr.startsWith('"') && subscriptExpr.endsWith('"')) {
    const inner = subscriptExpr.slice(1, -1);
    const parser = new Parser();
    const wordNode = parser.parseWordFromString(inner, true, false);
    return expandWord(ctx, wordNode);
  }
  if (subscriptExpr.includes("$")) {
    const parser = new Parser();
    const wordNode = parser.parseWordFromString(subscriptExpr, false, false);
    return expandWord(ctx, wordNode);
  }
  return subscriptExpr;
}
__name(expandAssocSubscript, "expandAssocSubscript");
async function handleUnset(ctx, args) {
  let mode = "both";
  let stderr = "";
  let exitCode = 0;
  for (const arg of args) {
    if (arg === "-v") {
      mode = "variable";
      continue;
    }
    if (arg === "-f") {
      mode = "function";
      continue;
    }
    if (mode === "function") {
      ctx.state.functions.delete(arg);
      continue;
    }
    if (mode === "variable") {
      const arrayMatchVar = arg.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[(.+)\]$/);
      if (arrayMatchVar) {
        const arrayName = arrayMatchVar[1];
        const indexExpr = arrayMatchVar[2];
        if (indexExpr === "@" || indexExpr === "*") {
          const elements = getArrayElements(ctx, arrayName);
          for (const [idx] of elements) {
            delete ctx.state.env[`${arrayName}_${idx}`];
          }
          delete ctx.state.env[arrayName];
          continue;
        }
        const isAssoc = ctx.state.associativeArrays?.has(arrayName);
        if (isAssoc) {
          const key = await expandAssocSubscript(ctx, indexExpr);
          delete ctx.state.env[`${arrayName}_${key}`];
          continue;
        }
        const isIndexedArray = isArray(ctx, arrayName);
        const isDeclaredButUnset = ctx.state.declaredVars?.has(arrayName);
        const isScalar = (arrayName in ctx.state.env || isDeclaredButUnset) && !isIndexedArray && !isAssoc;
        if (isScalar) {
          stderr += `bash: unset: ${arrayName}: not an array variable
`;
          exitCode = 1;
          continue;
        }
        const index = await evaluateArrayIndex2(ctx, indexExpr);
        if (index === null && isIndexedArray) {
          stderr += `bash: unset: ${indexExpr}: not a valid identifier
`;
          exitCode = 1;
          continue;
        }
        if (index === null) {
          continue;
        }
        if (index < 0) {
          const elements = getArrayElements(ctx, arrayName);
          const len = elements.length;
          const lineNum = ctx.state.currentLine;
          if (len === 0) {
            stderr += `bash: line ${lineNum}: unset: [${index}]: bad array subscript
`;
            exitCode = 1;
            continue;
          }
          const actualPos = len + index;
          if (actualPos < 0) {
            stderr += `bash: line ${lineNum}: unset: [${index}]: bad array subscript
`;
            exitCode = 1;
            continue;
          }
          const actualIndex = elements[actualPos][0];
          delete ctx.state.env[`${arrayName}_${actualIndex}`];
          continue;
        }
        delete ctx.state.env[`${arrayName}_${index}`];
        continue;
      }
      if (!isValidVariableName(arg)) {
        stderr += `bash: unset: \`${arg}': not a valid identifier
`;
        exitCode = 1;
        continue;
      }
      let targetName2 = arg;
      if (isNameref(ctx, arg)) {
        const resolved = resolveNameref(ctx, arg);
        if (resolved && resolved !== arg) {
          targetName2 = resolved;
        }
      }
      if (isReadonly(ctx, targetName2)) {
        stderr += `bash: unset: ${targetName2}: cannot unset: readonly variable
`;
        exitCode = 1;
        continue;
      }
      const localDepth2 = getLocalVarDepth(ctx, targetName2);
      if (localDepth2 !== void 0 && localDepth2 !== ctx.state.callDepth) {
        performCellUnset(ctx, targetName2);
      } else if (ctx.state.fullyUnsetLocals?.has(targetName2)) {
        delete ctx.state.env[targetName2];
      } else if (localDepth2 !== void 0) {
        const tempEnvAccessed = ctx.state.accessedTempEnvVars?.has(targetName2);
        const tempEnvMutated = ctx.state.mutatedTempEnvVars?.has(targetName2);
        if ((tempEnvAccessed || tempEnvMutated) && ctx.state.localVarStack?.has(targetName2)) {
          const stackEntry = popLocalVarStack(ctx, targetName2);
          if (stackEntry) {
            if (stackEntry.value === void 0) {
              delete ctx.state.env[targetName2];
            } else {
              ctx.state.env[targetName2] = stackEntry.value;
            }
          } else {
            delete ctx.state.env[targetName2];
          }
        } else {
          delete ctx.state.env[targetName2];
        }
      } else if (!handleTempEnvUnset(ctx, targetName2)) {
        delete ctx.state.env[targetName2];
      }
      ctx.state.exportedVars?.delete(targetName2);
      continue;
    }
    const arrayMatch = arg.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[(.+)\]$/);
    if (arrayMatch) {
      const arrayName = arrayMatch[1];
      const indexExpr = arrayMatch[2];
      if (indexExpr === "@" || indexExpr === "*") {
        const elements = getArrayElements(ctx, arrayName);
        for (const [idx] of elements) {
          delete ctx.state.env[`${arrayName}_${idx}`];
        }
        delete ctx.state.env[arrayName];
        continue;
      }
      const isAssoc = ctx.state.associativeArrays?.has(arrayName);
      if (isAssoc) {
        const key = await expandAssocSubscript(ctx, indexExpr);
        delete ctx.state.env[`${arrayName}_${key}`];
        continue;
      }
      const isIndexedArray = isArray(ctx, arrayName);
      const isScalar = arrayName in ctx.state.env && !isIndexedArray && !isAssoc;
      if (isScalar) {
        stderr += `bash: unset: ${arrayName}: not an array variable
`;
        exitCode = 1;
        continue;
      }
      const index = await evaluateArrayIndex2(ctx, indexExpr);
      if (index === null && isIndexedArray) {
        stderr += `bash: unset: ${indexExpr}: not a valid identifier
`;
        exitCode = 1;
        continue;
      }
      if (index === null) {
        continue;
      }
      if (index < 0) {
        const elements = getArrayElements(ctx, arrayName);
        const len = elements.length;
        const lineNum = ctx.state.currentLine;
        if (len === 0) {
          stderr += `bash: line ${lineNum}: unset: [${index}]: bad array subscript
`;
          exitCode = 1;
          continue;
        }
        const actualPos = len + index;
        if (actualPos < 0) {
          stderr += `bash: line ${lineNum}: unset: [${index}]: bad array subscript
`;
          exitCode = 1;
          continue;
        }
        const actualIndex = elements[actualPos][0];
        delete ctx.state.env[`${arrayName}_${actualIndex}`];
        continue;
      }
      delete ctx.state.env[`${arrayName}_${index}`];
      continue;
    }
    if (!isValidVariableName(arg)) {
      stderr += `bash: unset: \`${arg}': not a valid identifier
`;
      exitCode = 1;
      continue;
    }
    let targetName = arg;
    if (isNameref(ctx, arg)) {
      const resolved = resolveNameref(ctx, arg);
      if (resolved && resolved !== arg) {
        targetName = resolved;
      }
    }
    if (isReadonly(ctx, targetName)) {
      stderr += `bash: unset: ${targetName}: cannot unset: readonly variable
`;
      exitCode = 1;
      continue;
    }
    const localDepth = getLocalVarDepth(ctx, targetName);
    if (localDepth !== void 0 && localDepth !== ctx.state.callDepth) {
      performCellUnset(ctx, targetName);
    } else if (ctx.state.fullyUnsetLocals?.has(targetName)) {
      delete ctx.state.env[targetName];
    } else if (localDepth !== void 0) {
      const tempEnvAccessed = ctx.state.accessedTempEnvVars?.has(targetName);
      const tempEnvMutated = ctx.state.mutatedTempEnvVars?.has(targetName);
      if ((tempEnvAccessed || tempEnvMutated) && ctx.state.localVarStack?.has(targetName)) {
        const stackEntry = popLocalVarStack(ctx, targetName);
        if (stackEntry) {
          if (stackEntry.value === void 0) {
            delete ctx.state.env[targetName];
          } else {
            ctx.state.env[targetName] = stackEntry.value;
          }
        } else {
          delete ctx.state.env[targetName];
        }
      } else {
        delete ctx.state.env[targetName];
      }
    } else if (!handleTempEnvUnset(ctx, targetName)) {
      delete ctx.state.env[targetName];
    }
    ctx.state.exportedVars?.delete(targetName);
    ctx.state.functions.delete(arg);
  }
  return result("", stderr, exitCode);
}
__name(handleUnset, "handleUnset");

// dist/interpreter/builtins/shopt.js
var SHOPT_OPTIONS2 = [
  "extglob",
  "dotglob",
  "nullglob",
  "failglob",
  "globstar",
  "globskipdots",
  "nocaseglob",
  "nocasematch",
  "expand_aliases",
  "lastpipe",
  "xpg_echo"
];
var STUB_OPTIONS = [
  "autocd",
  "cdable_vars",
  "cdspell",
  "checkhash",
  "checkjobs",
  "checkwinsize",
  "cmdhist",
  "compat31",
  "compat32",
  "compat40",
  "compat41",
  "compat42",
  "compat43",
  "compat44",
  "complete_fullquote",
  "direxpand",
  "dirspell",
  "execfail",
  "extdebug",
  "extquote",
  "force_fignore",
  "globasciiranges",
  "gnu_errfmt",
  "histappend",
  "histreedit",
  "histverify",
  "hostcomplete",
  "huponexit",
  "inherit_errexit",
  "interactive_comments",
  "lithist",
  "localvar_inherit",
  "localvar_unset",
  "login_shell",
  "mailwarn",
  "no_empty_cmd_completion",
  "progcomp",
  "progcomp_alias",
  "promptvars",
  "restricted_shell",
  "shift_verbose",
  "sourcepath"
];
function isShoptOption(opt) {
  return SHOPT_OPTIONS2.includes(opt);
}
__name(isShoptOption, "isShoptOption");
function isStubOption(opt) {
  return STUB_OPTIONS.includes(opt);
}
__name(isStubOption, "isStubOption");
function handleShopt(ctx, args) {
  let setFlag = false;
  let unsetFlag = false;
  let printFlag = false;
  let quietFlag = false;
  let oFlag = false;
  const optionNames = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--") {
      i++;
      break;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        const flag = arg[j];
        switch (flag) {
          case "s":
            setFlag = true;
            break;
          case "u":
            unsetFlag = true;
            break;
          case "p":
            printFlag = true;
            break;
          case "q":
            quietFlag = true;
            break;
          case "o":
            oFlag = true;
            break;
          default:
            return {
              exitCode: 2,
              stdout: "",
              stderr: `shopt: -${flag}: invalid option
`
            };
        }
      }
      i++;
    } else {
      break;
    }
  }
  while (i < args.length) {
    optionNames.push(args[i]);
    i++;
  }
  if (oFlag) {
    return handleSetOptions(ctx, optionNames, setFlag, unsetFlag, printFlag, quietFlag);
  }
  if (setFlag && unsetFlag) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "shopt: cannot set and unset shell options simultaneously\n"
    };
  }
  if (optionNames.length === 0) {
    if (setFlag || unsetFlag) {
      const output3 = [];
      for (const opt of SHOPT_OPTIONS2) {
        const value = ctx.state.shoptOptions[opt];
        if (setFlag && value) {
          output3.push(printFlag ? `shopt -s ${opt}` : `${opt}		on`);
        } else if (unsetFlag && !value) {
          output3.push(printFlag ? `shopt -u ${opt}` : `${opt}		off`);
        }
      }
      return {
        exitCode: 0,
        stdout: output3.length > 0 ? `${output3.join("\n")}
` : "",
        stderr: ""
      };
    }
    const output2 = [];
    for (const opt of SHOPT_OPTIONS2) {
      const value = ctx.state.shoptOptions[opt];
      output2.push(printFlag ? `shopt ${value ? "-s" : "-u"} ${opt}` : `${opt}		${value ? "on" : "off"}`);
    }
    return {
      exitCode: 0,
      stdout: `${output2.join("\n")}
`,
      stderr: ""
    };
  }
  let hasError = false;
  let stderr = "";
  const output = [];
  for (const name of optionNames) {
    if (!isShoptOption(name) && !isStubOption(name)) {
      stderr += `shopt: ${name}: invalid shell option name
`;
      hasError = true;
      continue;
    }
    if (setFlag) {
      if (isShoptOption(name)) {
        ctx.state.shoptOptions[name] = true;
        updateBashopts(ctx);
      }
    } else if (unsetFlag) {
      if (isShoptOption(name)) {
        ctx.state.shoptOptions[name] = false;
        updateBashopts(ctx);
      }
    } else {
      if (isShoptOption(name)) {
        const value = ctx.state.shoptOptions[name];
        if (quietFlag) {
          if (!value) {
            hasError = true;
          }
        } else if (printFlag) {
          output.push(`shopt ${value ? "-s" : "-u"} ${name}`);
          if (!value) {
            hasError = true;
          }
        } else {
          output.push(`${name}		${value ? "on" : "off"}`);
          if (!value) {
            hasError = true;
          }
        }
      } else {
        if (quietFlag) {
          hasError = true;
        } else if (printFlag) {
          output.push(`shopt -u ${name}`);
          hasError = true;
        } else {
          output.push(`${name}		off`);
          hasError = true;
        }
      }
    }
  }
  return {
    exitCode: hasError ? 1 : 0,
    stdout: output.length > 0 ? `${output.join("\n")}
` : "",
    stderr
  };
}
__name(handleShopt, "handleShopt");
function handleSetOptions(ctx, optionNames, setFlag, unsetFlag, printFlag, quietFlag) {
  const SET_OPTIONS = {
    errexit: "errexit",
    pipefail: "pipefail",
    nounset: "nounset",
    xtrace: "xtrace",
    verbose: "verbose",
    posix: "posix",
    allexport: "allexport",
    noclobber: "noclobber",
    noglob: "noglob",
    noexec: "noexec",
    vi: "vi",
    emacs: "emacs"
  };
  const NOOP_OPTIONS = [
    "braceexpand",
    "errtrace",
    "functrace",
    "hashall",
    "histexpand",
    "history",
    "ignoreeof",
    "interactive-comments",
    "keyword",
    "monitor",
    "nolog",
    "notify",
    "onecmd",
    "physical",
    "privileged"
  ];
  const ALL_SET_OPTIONS = [...Object.keys(SET_OPTIONS), ...NOOP_OPTIONS].sort();
  if (optionNames.length === 0) {
    const output2 = [];
    for (const opt of ALL_SET_OPTIONS) {
      const isNoOp = NOOP_OPTIONS.includes(opt);
      const value = isNoOp ? false : ctx.state.options[SET_OPTIONS[opt]];
      if (setFlag && !value)
        continue;
      if (unsetFlag && value)
        continue;
      output2.push(printFlag ? `set ${value ? "-o" : "+o"} ${opt}` : `${opt}		${value ? "on" : "off"}`);
    }
    return {
      exitCode: 0,
      stdout: output2.length > 0 ? `${output2.join("\n")}
` : "",
      stderr: ""
    };
  }
  let hasError = false;
  let stderr = "";
  const output = [];
  for (const name of optionNames) {
    const isImplemented = name in SET_OPTIONS;
    const isNoOp = NOOP_OPTIONS.includes(name);
    if (!isImplemented && !isNoOp) {
      stderr += `shopt: ${name}: invalid option name
`;
      hasError = true;
      continue;
    }
    if (isNoOp) {
      if (setFlag || unsetFlag) {
      } else {
        if (quietFlag) {
          hasError = true;
        } else if (printFlag) {
          output.push(`set +o ${name}`);
          hasError = true;
        } else {
          output.push(`${name}		off`);
          hasError = true;
        }
      }
      continue;
    }
    const key = SET_OPTIONS[name];
    if (setFlag) {
      if (key === "vi") {
        ctx.state.options.emacs = false;
      } else if (key === "emacs") {
        ctx.state.options.vi = false;
      }
      ctx.state.options[key] = true;
      updateShellopts(ctx);
    } else if (unsetFlag) {
      ctx.state.options[key] = false;
      updateShellopts(ctx);
    } else {
      const value = ctx.state.options[key];
      if (quietFlag) {
        if (!value) {
          hasError = true;
        }
      } else if (printFlag) {
        output.push(`set ${value ? "-o" : "+o"} ${name}`);
        if (!value) {
          hasError = true;
        }
      } else {
        output.push(`${name}		${value ? "on" : "off"}`);
        if (!value) {
          hasError = true;
        }
      }
    }
  }
  return {
    exitCode: hasError ? 1 : 0,
    stdout: output.length > 0 ? `${output.join("\n")}
` : "",
    stderr
  };
}
__name(handleSetOptions, "handleSetOptions");

// dist/interpreter/command-resolution.js
async function resolveCommand(ctx, commandName, pathOverride) {
  if (commandName.includes("/")) {
    const resolvedPath = ctx.fs.resolvePath(ctx.state.cwd, commandName);
    if (!await ctx.fs.exists(resolvedPath)) {
      return { error: "not_found", path: resolvedPath };
    }
    const cmdName = resolvedPath.split("/").pop() || commandName;
    const cmd = ctx.commands.get(cmdName);
    try {
      const stat = await ctx.fs.stat(resolvedPath);
      if (stat.isDirectory) {
        return { error: "permission_denied", path: resolvedPath };
      }
      if (cmd) {
        return { cmd, path: resolvedPath };
      }
      const isExecutable = (stat.mode & 73) !== 0;
      if (!isExecutable) {
        return { error: "permission_denied", path: resolvedPath };
      }
      return { script: true, path: resolvedPath };
    } catch {
      return { error: "not_found", path: resolvedPath };
    }
  }
  if (!pathOverride && ctx.state.hashTable) {
    const cachedPath = ctx.state.hashTable.get(commandName);
    if (cachedPath) {
      if (await ctx.fs.exists(cachedPath)) {
        const cmd = ctx.commands.get(commandName);
        if (cmd) {
          return { cmd, path: cachedPath };
        }
        try {
          const stat = await ctx.fs.stat(cachedPath);
          if (!stat.isDirectory && (stat.mode & 73) !== 0) {
            return { script: true, path: cachedPath };
          }
        } catch {
        }
      } else {
        ctx.state.hashTable.delete(commandName);
      }
    }
  }
  const pathEnv = pathOverride ?? ctx.state.env.PATH ?? "/usr/bin:/bin";
  const pathDirs = pathEnv.split(":");
  for (const dir of pathDirs) {
    if (!dir)
      continue;
    const resolvedDir = dir.startsWith("/") ? dir : ctx.fs.resolvePath(ctx.state.cwd, dir);
    const fullPath = `${resolvedDir}/${commandName}`;
    if (await ctx.fs.exists(fullPath)) {
      try {
        const stat = await ctx.fs.stat(fullPath);
        if (stat.isDirectory) {
          continue;
        }
        const isExecutable = (stat.mode & 73) !== 0;
        const cmd = ctx.commands.get(commandName);
        const isSystemDir = dir === "/bin" || dir === "/usr/bin";
        if (cmd && isSystemDir) {
          return { cmd, path: fullPath };
        }
        if (isExecutable) {
          if (cmd && !isSystemDir) {
            return { script: true, path: fullPath };
          }
          if (!cmd) {
            return { script: true, path: fullPath };
          }
        }
      } catch {
      }
    }
  }
  const usrBinExists = await ctx.fs.exists("/usr/bin");
  if (!usrBinExists) {
    const cmd = ctx.commands.get(commandName);
    if (cmd) {
      return { cmd, path: `/usr/bin/${commandName}` };
    }
  }
  return null;
}
__name(resolveCommand, "resolveCommand");
async function findCommandInPath(ctx, commandName) {
  const paths = [];
  if (commandName.includes("/")) {
    const resolvedPath = ctx.fs.resolvePath(ctx.state.cwd, commandName);
    if (await ctx.fs.exists(resolvedPath)) {
      try {
        const stat = await ctx.fs.stat(resolvedPath);
        if (!stat.isDirectory) {
          const isExecutable = (stat.mode & 73) !== 0;
          if (isExecutable) {
            paths.push(commandName);
          }
        }
      } catch {
      }
    }
    return paths;
  }
  const pathEnv = ctx.state.env.PATH || "/usr/bin:/bin";
  const pathDirs = pathEnv.split(":");
  for (const dir of pathDirs) {
    if (!dir)
      continue;
    const resolvedDir = dir.startsWith("/") ? dir : ctx.fs.resolvePath(ctx.state.cwd, dir);
    const fullPath = `${resolvedDir}/${commandName}`;
    if (await ctx.fs.exists(fullPath)) {
      try {
        const stat = await ctx.fs.stat(fullPath);
        if (stat.isDirectory) {
          continue;
        }
      } catch {
        continue;
      }
      paths.push(dir.startsWith("/") ? fullPath : `${dir}/${commandName}`);
    }
  }
  return paths;
}
__name(findCommandInPath, "findCommandInPath");

// dist/interpreter/type-command.js
async function handleType(ctx, args, findFirstInPath2, findCommandInPath2) {
  let typeOnly = false;
  let pathOnly = false;
  let forcePathSearch = false;
  let showAll = false;
  let suppressFunctions = false;
  const names = [];
  for (const arg of args) {
    if (arg.startsWith("-") && arg.length > 1) {
      for (const char of arg.slice(1)) {
        if (char === "t") {
          typeOnly = true;
        } else if (char === "p") {
          pathOnly = true;
        } else if (char === "P") {
          forcePathSearch = true;
        } else if (char === "a") {
          showAll = true;
        } else if (char === "f") {
          suppressFunctions = true;
        }
      }
    } else {
      names.push(arg);
    }
  }
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  let anyFileFound = false;
  let anyNotFound = false;
  for (const name of names) {
    let foundAny = false;
    if (forcePathSearch) {
      if (showAll) {
        const allPaths = await findCommandInPath2(name);
        if (allPaths.length > 0) {
          for (const p of allPaths) {
            stdout += `${p}
`;
          }
          anyFileFound = true;
          foundAny = true;
        }
      } else {
        const pathResult = await findFirstInPath2(name);
        if (pathResult) {
          stdout += `${pathResult}
`;
          anyFileFound = true;
          foundAny = true;
        }
      }
      if (!foundAny) {
        anyNotFound = true;
      }
      continue;
    }
    const hasFunction = !suppressFunctions && ctx.state.functions.has(name);
    if (showAll && hasFunction) {
      if (pathOnly) {
      } else if (typeOnly) {
        stdout += "function\n";
      } else {
        const funcDef = ctx.state.functions.get(name);
        const funcSource = funcDef ? formatFunctionSource(name, funcDef) : `${name} is a function
`;
        stdout += funcSource;
      }
      foundAny = true;
    }
    const alias = ctx.state.env[`BASH_ALIAS_${name}`];
    const hasAlias = alias !== void 0;
    if (hasAlias && (showAll || !foundAny)) {
      if (pathOnly) {
      } else if (typeOnly) {
        stdout += "alias\n";
      } else {
        stdout += `${name} is aliased to \`${alias}'
`;
      }
      foundAny = true;
      if (!showAll) {
        continue;
      }
    }
    const hasKeyword = SHELL_KEYWORDS.has(name);
    if (hasKeyword && (showAll || !foundAny)) {
      if (pathOnly) {
      } else if (typeOnly) {
        stdout += "keyword\n";
      } else {
        stdout += `${name} is a shell keyword
`;
      }
      foundAny = true;
      if (!showAll) {
        continue;
      }
    }
    if (!showAll && hasFunction && !foundAny) {
      if (pathOnly) {
      } else if (typeOnly) {
        stdout += "function\n";
      } else {
        const funcDef = ctx.state.functions.get(name);
        const funcSource = funcDef ? formatFunctionSource(name, funcDef) : `${name} is a function
`;
        stdout += funcSource;
      }
      foundAny = true;
      continue;
    }
    const hasBuiltin = SHELL_BUILTINS.has(name);
    if (hasBuiltin && (showAll || !foundAny)) {
      if (pathOnly) {
      } else if (typeOnly) {
        stdout += "builtin\n";
      } else {
        stdout += `${name} is a shell builtin
`;
      }
      foundAny = true;
      if (!showAll) {
        continue;
      }
    }
    if (showAll) {
      const allPaths = await findCommandInPath2(name);
      for (const pathResult of allPaths) {
        if (pathOnly) {
          stdout += `${pathResult}
`;
        } else if (typeOnly) {
          stdout += "file\n";
        } else {
          stdout += `${name} is ${pathResult}
`;
        }
        anyFileFound = true;
        foundAny = true;
      }
    } else if (!foundAny) {
      const pathResult = await findFirstInPath2(name);
      if (pathResult) {
        if (pathOnly) {
          stdout += `${pathResult}
`;
        } else if (typeOnly) {
          stdout += "file\n";
        } else {
          stdout += `${name} is ${pathResult}
`;
        }
        anyFileFound = true;
        foundAny = true;
      }
    }
    if (!foundAny) {
      anyNotFound = true;
      if (!typeOnly && !pathOnly) {
        let shouldPrintError = true;
        if (name.includes("/")) {
          const resolvedPath = ctx.fs.resolvePath(ctx.state.cwd, name);
          if (await ctx.fs.exists(resolvedPath)) {
            shouldPrintError = false;
          }
        }
        if (shouldPrintError) {
          stderr += `bash: type: ${name}: not found
`;
        }
      }
    }
  }
  if (pathOnly) {
    exitCode = anyNotFound && !anyFileFound ? 1 : 0;
  } else if (forcePathSearch) {
    exitCode = anyNotFound ? 1 : 0;
  } else {
    exitCode = anyNotFound ? 1 : 0;
  }
  return result(stdout, stderr, exitCode);
}
__name(handleType, "handleType");
function formatFunctionSource(name, funcDef) {
  let bodyStr;
  if (funcDef.body.type === "Group") {
    const group = funcDef.body;
    bodyStr = group.body.map((s) => serializeCompoundCommand(s)).join("; ");
  } else {
    bodyStr = serializeCompoundCommand(funcDef.body);
  }
  return `${name} is a function
${name} () 
{ 
    ${bodyStr}
}
`;
}
__name(formatFunctionSource, "formatFunctionSource");
function serializeCompoundCommand(node) {
  if (Array.isArray(node)) {
    return node.map((s) => serializeCompoundCommand(s)).join("; ");
  }
  if (node.type === "Statement") {
    const parts = [];
    for (let i = 0; i < node.pipelines.length; i++) {
      const pipeline = node.pipelines[i];
      parts.push(serializePipeline(pipeline));
      if (node.operators[i]) {
        parts.push(node.operators[i]);
      }
    }
    return parts.join(" ");
  }
  if (node.type === "SimpleCommand") {
    const cmd = node;
    const parts = [];
    if (cmd.name) {
      parts.push(serializeWord(cmd.name));
    }
    for (const arg of cmd.args) {
      parts.push(serializeWord(arg));
    }
    return parts.join(" ");
  }
  if (node.type === "Group") {
    const group = node;
    const body = group.body.map((s) => serializeCompoundCommand(s)).join("; ");
    return `{ ${body}; }`;
  }
  return "...";
}
__name(serializeCompoundCommand, "serializeCompoundCommand");
function serializePipeline(pipeline) {
  const parts = pipeline.commands.map((cmd) => serializeCompoundCommand(cmd));
  return (pipeline.negated ? "! " : "") + parts.join(" | ");
}
__name(serializePipeline, "serializePipeline");
function serializeWord(word) {
  let result2 = "";
  for (const part of word.parts) {
    if (part.type === "Literal") {
      result2 += part.value;
    } else if (part.type === "DoubleQuoted") {
      result2 += `"${part.parts.map((p) => serializeWordPart(p)).join("")}"`;
    } else if (part.type === "SingleQuoted") {
      result2 += `'${part.value}'`;
    } else {
      result2 += serializeWordPart(part);
    }
  }
  return result2;
}
__name(serializeWord, "serializeWord");
function serializeWordPart(part) {
  const p = part;
  if (p.type === "Literal") {
    return p.value ?? "";
  }
  if (p.type === "Variable") {
    return `$${p.name}`;
  }
  return "";
}
__name(serializeWordPart, "serializeWordPart");
async function handleCommandV(ctx, names, _showPath, verboseDescribe) {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  for (const name of names) {
    if (!name) {
      exitCode = 1;
      continue;
    }
    const alias = ctx.state.env[`BASH_ALIAS_${name}`];
    if (alias !== void 0) {
      if (verboseDescribe) {
        stdout += `${name} is an alias for "${alias}"
`;
      } else {
        stdout += `alias ${name}='${alias}'
`;
      }
    } else if (SHELL_KEYWORDS.has(name)) {
      if (verboseDescribe) {
        stdout += `${name} is a shell keyword
`;
      } else {
        stdout += `${name}
`;
      }
    } else if (SHELL_BUILTINS.has(name)) {
      if (verboseDescribe) {
        stdout += `${name} is a shell builtin
`;
      } else {
        stdout += `${name}
`;
      }
    } else if (ctx.state.functions.has(name)) {
      if (verboseDescribe) {
        stdout += `${name} is a function
`;
      } else {
        stdout += `${name}
`;
      }
    } else if (name.includes("/")) {
      const resolvedPath = ctx.fs.resolvePath(ctx.state.cwd, name);
      let found = false;
      if (await ctx.fs.exists(resolvedPath)) {
        try {
          const stat = await ctx.fs.stat(resolvedPath);
          if (!stat.isDirectory) {
            const isExecutable = (stat.mode & 73) !== 0;
            if (isExecutable) {
              if (verboseDescribe) {
                stdout += `${name} is ${name}
`;
              } else {
                stdout += `${name}
`;
              }
              found = true;
            }
          }
        } catch {
        }
      }
      if (!found) {
        if (verboseDescribe) {
          stderr += `${name}: not found
`;
        }
        exitCode = 1;
      }
    } else if (ctx.commands.has(name)) {
      const pathEnv = ctx.state.env.PATH ?? "/usr/bin:/bin";
      const pathDirs = pathEnv.split(":");
      let foundPath = null;
      for (const dir of pathDirs) {
        if (!dir)
          continue;
        const cmdPath = `${dir}/${name}`;
        try {
          const stat = await ctx.fs.stat(cmdPath);
          if (!stat.isDirectory && (stat.mode & 73) !== 0) {
            foundPath = cmdPath;
            break;
          }
        } catch {
        }
      }
      if (!foundPath) {
        foundPath = `/usr/bin/${name}`;
      }
      if (verboseDescribe) {
        stdout += `${name} is ${foundPath}
`;
      } else {
        stdout += `${foundPath}
`;
      }
    } else {
      if (verboseDescribe) {
        stderr += `${name}: not found
`;
      }
      exitCode = 1;
    }
  }
  return result(stdout, stderr, exitCode);
}
__name(handleCommandV, "handleCommandV");
async function findFirstInPath(ctx, name) {
  if (name.includes("/")) {
    const resolvedPath = ctx.fs.resolvePath(ctx.state.cwd, name);
    if (await ctx.fs.exists(resolvedPath)) {
      try {
        const stat = await ctx.fs.stat(resolvedPath);
        if (stat.isDirectory) {
          return null;
        }
        const isExecutable = (stat.mode & 73) !== 0;
        if (!isExecutable) {
          return null;
        }
      } catch {
        return null;
      }
      return name;
    }
    return null;
  }
  const pathEnv = ctx.state.env.PATH ?? "/usr/bin:/bin";
  const pathDirs = pathEnv.split(":");
  for (const dir of pathDirs) {
    if (!dir)
      continue;
    const resolvedDir = dir.startsWith("/") ? dir : ctx.fs.resolvePath(ctx.state.cwd, dir);
    const fullPath = `${resolvedDir}/${name}`;
    if (await ctx.fs.exists(fullPath)) {
      try {
        const stat = await ctx.fs.stat(fullPath);
        if (stat.isDirectory) {
          continue;
        }
      } catch {
        continue;
      }
      return `${dir}/${name}`;
    }
  }
  if (ctx.commands.has(name)) {
    for (const dir of pathDirs) {
      if (dir === "/usr/bin" || dir === "/bin") {
        return `${dir}/${name}`;
      }
    }
    return `/usr/bin/${name}`;
  }
  return null;
}
__name(findFirstInPath, "findFirstInPath");

// dist/interpreter/builtin-dispatch.js
async function dispatchBuiltin(dispatchCtx, commandName, args, _quotedArgs, stdin, skipFunctions, _useDefaultPath, stdinSourceFd) {
  const { ctx, runCommand } = dispatchCtx;
  if (commandName === "export") {
    return handleExport(ctx, args);
  }
  if (commandName === "unset") {
    return handleUnset(ctx, args);
  }
  if (commandName === "exit") {
    return handleExit(ctx, args);
  }
  if (commandName === "local") {
    return handleLocal(ctx, args);
  }
  if (commandName === "set") {
    return handleSet(ctx, args);
  }
  if (commandName === "break") {
    return handleBreak(ctx, args);
  }
  if (commandName === "continue") {
    return handleContinue(ctx, args);
  }
  if (commandName === "return") {
    return handleReturn(ctx, args);
  }
  if (commandName === "eval" && ctx.state.options.posix) {
    return handleEval(ctx, args, stdin);
  }
  if (commandName === "shift") {
    return handleShift(ctx, args);
  }
  if (commandName === "getopts") {
    return handleGetopts(ctx, args);
  }
  if (commandName === "compgen") {
    return handleCompgen(ctx, args);
  }
  if (commandName === "complete") {
    return handleComplete(ctx, args);
  }
  if (commandName === "compopt") {
    return handleCompopt(ctx, args);
  }
  if (commandName === "pushd") {
    return await handlePushd(ctx, args);
  }
  if (commandName === "popd") {
    return handlePopd(ctx, args);
  }
  if (commandName === "dirs") {
    return handleDirs(ctx, args);
  }
  if (commandName === "source" || commandName === ".") {
    return handleSource(ctx, args);
  }
  if (commandName === "read") {
    return handleRead(ctx, args, stdin, stdinSourceFd);
  }
  if (commandName === "mapfile" || commandName === "readarray") {
    return handleMapfile(ctx, args, stdin);
  }
  if (commandName === "declare" || commandName === "typeset") {
    return handleDeclare(ctx, args);
  }
  if (commandName === "readonly") {
    return handleReadonly(ctx, args);
  }
  if (!skipFunctions) {
    const func = ctx.state.functions.get(commandName);
    if (func) {
      return callFunction(ctx, func, args, stdin);
    }
  }
  if (commandName === "eval") {
    return handleEval(ctx, args, stdin);
  }
  if (commandName === "cd") {
    return await handleCd(ctx, args);
  }
  if (commandName === ":" || commandName === "true") {
    return OK;
  }
  if (commandName === "false") {
    return testResult(false);
  }
  if (commandName === "let") {
    return handleLet(ctx, args);
  }
  if (commandName === "command") {
    return handleCommandBuiltin(dispatchCtx, args, stdin);
  }
  if (commandName === "builtin") {
    return handleBuiltinBuiltin(dispatchCtx, args, stdin);
  }
  if (commandName === "shopt") {
    return handleShopt(ctx, args);
  }
  if (commandName === "exec") {
    if (args.length === 0) {
      return OK;
    }
    const [cmd, ...rest] = args;
    return runCommand(cmd, rest, [], stdin, false, false, -1);
  }
  if (commandName === "wait") {
    return OK;
  }
  if (commandName === "type") {
    return await handleType(ctx, args, (name) => findFirstInPath(ctx, name), (name) => findCommandInPath(ctx, name));
  }
  if (commandName === "hash") {
    return handleHash(ctx, args);
  }
  if (commandName === "help") {
    return handleHelp(ctx, args);
  }
  if (commandName === "[" || commandName === "test") {
    let testArgs = args;
    if (commandName === "[") {
      if (args[args.length - 1] !== "]") {
        return failure("[: missing `]'\n", 2);
      }
      testArgs = args.slice(0, -1);
    }
    return evaluateTestArgs(ctx, testArgs);
  }
  return null;
}
__name(dispatchBuiltin, "dispatchBuiltin");
async function handleCommandBuiltin(dispatchCtx, args, stdin) {
  const { ctx, runCommand } = dispatchCtx;
  if (args.length === 0) {
    return OK;
  }
  let useDefaultPath = false;
  let verboseDescribe = false;
  let showPath = false;
  let cmdArgs = args;
  while (cmdArgs.length > 0 && cmdArgs[0].startsWith("-")) {
    const opt = cmdArgs[0];
    if (opt === "--") {
      cmdArgs = cmdArgs.slice(1);
      break;
    }
    for (const char of opt.slice(1)) {
      if (char === "p") {
        useDefaultPath = true;
      } else if (char === "V") {
        verboseDescribe = true;
      } else if (char === "v") {
        showPath = true;
      }
    }
    cmdArgs = cmdArgs.slice(1);
  }
  if (cmdArgs.length === 0) {
    return OK;
  }
  if (showPath || verboseDescribe) {
    return await handleCommandV(ctx, cmdArgs, showPath, verboseDescribe);
  }
  const [cmd, ...rest] = cmdArgs;
  return runCommand(cmd, rest, [], stdin, true, useDefaultPath, -1);
}
__name(handleCommandBuiltin, "handleCommandBuiltin");
async function handleBuiltinBuiltin(dispatchCtx, args, stdin) {
  const { runCommand } = dispatchCtx;
  if (args.length === 0) {
    return OK;
  }
  let cmdArgs = args;
  if (cmdArgs[0] === "--") {
    cmdArgs = cmdArgs.slice(1);
    if (cmdArgs.length === 0) {
      return OK;
    }
  }
  const cmd = cmdArgs[0];
  if (!SHELL_BUILTINS.has(cmd)) {
    return failure(`bash: builtin: ${cmd}: not a shell builtin
`);
  }
  const [, ...rest] = cmdArgs;
  return runCommand(cmd, rest, [], stdin, true, false, -1);
}
__name(handleBuiltinBuiltin, "handleBuiltinBuiltin");
async function executeExternalCommand(dispatchCtx, commandName, args, stdin, useDefaultPath) {
  const { ctx, buildExportedEnv, executeUserScript: executeUserScript2 } = dispatchCtx;
  const defaultPath = "/usr/bin:/bin";
  const resolved = await resolveCommand(ctx, commandName, useDefaultPath ? defaultPath : void 0);
  if (!resolved) {
    if (isBrowserExcludedCommand(commandName)) {
      return failure(`bash: ${commandName}: command not available in browser environments. Exclude '${commandName}' from your commands or use the Node.js bundle.
`, 127);
    }
    return failure(`bash: ${commandName}: command not found
`, 127);
  }
  if ("error" in resolved) {
    if (resolved.error === "permission_denied") {
      return failure(`bash: ${commandName}: Permission denied
`, 126);
    }
    return failure(`bash: ${commandName}: No such file or directory
`, 127);
  }
  if ("script" in resolved) {
    if (!commandName.includes("/")) {
      if (!ctx.state.hashTable) {
        ctx.state.hashTable = /* @__PURE__ */ new Map();
      }
      ctx.state.hashTable.set(commandName, resolved.path);
    }
    return await executeUserScript2(resolved.path, args, stdin);
  }
  const { cmd, path: cmdPath } = resolved;
  if (!commandName.includes("/")) {
    if (!ctx.state.hashTable) {
      ctx.state.hashTable = /* @__PURE__ */ new Map();
    }
    ctx.state.hashTable.set(commandName, cmdPath);
  }
  const effectiveStdin = stdin || ctx.state.groupStdin || "";
  const exportedEnv = buildExportedEnv();
  const cmdCtx = {
    fs: ctx.fs,
    cwd: ctx.state.cwd,
    env: ctx.state.env,
    exportedEnv,
    stdin: effectiveStdin,
    limits: ctx.limits,
    exec: ctx.execFn,
    fetch: ctx.fetch,
    getRegisteredCommands: /* @__PURE__ */ __name(() => Array.from(ctx.commands.keys()), "getRegisteredCommands"),
    sleep: ctx.sleep,
    trace: ctx.trace,
    fileDescriptors: ctx.state.fileDescriptors,
    xpgEcho: ctx.state.shoptOptions.xpg_echo
  };
  try {
    return await cmd.execute(args, cmdCtx);
  } catch (error) {
    return failure(`${commandName}: ${getErrorMessage(error)}
`);
  }
}
__name(executeExternalCommand, "executeExternalCommand");

// dist/interpreter/helpers/condition.js
async function executeCondition(ctx, statements) {
  const savedInCondition = ctx.state.inCondition;
  ctx.state.inCondition = true;
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  try {
    for (const stmt of statements) {
      const result2 = await ctx.executeStatement(stmt);
      stdout += result2.stdout;
      stderr += result2.stderr;
      exitCode = result2.exitCode;
    }
  } finally {
    ctx.state.inCondition = savedInCondition;
  }
  return { stdout, stderr, exitCode };
}
__name(executeCondition, "executeCondition");

// dist/interpreter/helpers/loop.js
function handleLoopError(error, stdout, stderr, loopDepth) {
  if (error instanceof BreakError) {
    stdout += error.stdout;
    stderr += error.stderr;
    if (error.levels > 1 && loopDepth > 1) {
      error.levels--;
      error.stdout = stdout;
      error.stderr = stderr;
      return { action: "rethrow", stdout, stderr, error };
    }
    return { action: "break", stdout, stderr };
  }
  if (error instanceof ContinueError) {
    stdout += error.stdout;
    stderr += error.stderr;
    if (error.levels > 1 && loopDepth > 1) {
      error.levels--;
      error.stdout = stdout;
      error.stderr = stderr;
      return { action: "rethrow", stdout, stderr, error };
    }
    return { action: "continue", stdout, stderr };
  }
  if (error instanceof ReturnError || error instanceof ErrexitError || error instanceof ExitError || error instanceof ExecutionLimitError) {
    error.prependOutput(stdout, stderr);
    return { action: "rethrow", stdout, stderr, error };
  }
  const message = getErrorMessage(error);
  return {
    action: "error",
    stdout,
    stderr: `${stderr}${message}
`,
    exitCode: 1
  };
}
__name(handleLoopError, "handleLoopError");

// dist/interpreter/helpers/statements.js
async function executeStatements(ctx, statements, initialStdout = "", initialStderr = "") {
  let stdout = initialStdout;
  let stderr = initialStderr;
  let exitCode = 0;
  try {
    for (const stmt of statements) {
      const result2 = await ctx.executeStatement(stmt);
      stdout += result2.stdout;
      stderr += result2.stderr;
      exitCode = result2.exitCode;
    }
  } catch (error) {
    if (isScopeExitError(error) || error instanceof ErrexitError || error instanceof ExitError || error instanceof ExecutionLimitError || error instanceof SubshellExitError) {
      error.prependOutput(stdout, stderr);
      throw error;
    }
    return {
      stdout,
      stderr: `${stderr}${getErrorMessage(error)}
`,
      exitCode: 1
    };
  }
  return { stdout, stderr, exitCode };
}
__name(executeStatements, "executeStatements");

// dist/interpreter/control-flow.js
async function executeIf(ctx, node) {
  let stdout = "";
  let stderr = "";
  for (const clause of node.clauses) {
    const condResult = await executeCondition(ctx, clause.condition);
    stdout += condResult.stdout;
    stderr += condResult.stderr;
    if (condResult.exitCode === 0) {
      return executeStatements(ctx, clause.body, stdout, stderr);
    }
  }
  if (node.elseBody) {
    return executeStatements(ctx, node.elseBody, stdout, stderr);
  }
  return result(stdout, stderr, 0);
}
__name(executeIf, "executeIf");
async function executeFor(ctx, node) {
  const preOpenError = await preOpenOutputRedirects(ctx, node.redirections);
  if (preOpenError) {
    return preOpenError;
  }
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  let iterations = 0;
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(node.variable)) {
    return failure(`bash: \`${node.variable}': not a valid identifier
`);
  }
  let words = [];
  if (node.words === null) {
    words = (ctx.state.env["@"] || "").split(" ").filter(Boolean);
  } else if (node.words.length === 0) {
    words = [];
  } else {
    try {
      for (const word of node.words) {
        const expanded = await expandWordWithGlob(ctx, word);
        words.push(...expanded.values);
      }
    } catch (e) {
      if (e instanceof GlobError) {
        return { stdout: "", stderr: e.stderr, exitCode: 1 };
      }
      throw e;
    }
  }
  ctx.state.loopDepth++;
  try {
    for (const value of words) {
      iterations++;
      if (iterations > ctx.limits.maxLoopIterations) {
        throwExecutionLimit(`for loop: too many iterations (${ctx.limits.maxLoopIterations}), increase executionLimits.maxLoopIterations`, "iterations", stdout, stderr);
      }
      ctx.state.env[node.variable] = value;
      try {
        for (const stmt of node.body) {
          const stmtResult = await ctx.executeStatement(stmt);
          stdout += stmtResult.stdout;
          stderr += stmtResult.stderr;
          exitCode = stmtResult.exitCode;
        }
      } catch (error) {
        const loopResult = handleLoopError(error, stdout, stderr, ctx.state.loopDepth);
        stdout = loopResult.stdout;
        stderr = loopResult.stderr;
        if (loopResult.action === "break")
          break;
        if (loopResult.action === "continue")
          continue;
        if (loopResult.action === "error") {
          const bodyResult2 = result(stdout, stderr, loopResult.exitCode ?? 1);
          return applyRedirections(ctx, bodyResult2, node.redirections);
        }
        throw loopResult.error;
      }
    }
  } finally {
    ctx.state.loopDepth--;
  }
  const bodyResult = result(stdout, stderr, exitCode);
  return applyRedirections(ctx, bodyResult, node.redirections);
}
__name(executeFor, "executeFor");
async function executeCStyleFor(ctx, node) {
  const preOpenError = await preOpenOutputRedirects(ctx, node.redirections);
  if (preOpenError) {
    return preOpenError;
  }
  const loopLine = node.line;
  if (loopLine !== void 0) {
    ctx.state.currentLine = loopLine;
  }
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  let iterations = 0;
  if (node.init) {
    await evaluateArithmetic(ctx, node.init.expression);
  }
  ctx.state.loopDepth++;
  try {
    while (true) {
      iterations++;
      if (iterations > ctx.limits.maxLoopIterations) {
        throwExecutionLimit(`for loop: too many iterations (${ctx.limits.maxLoopIterations}), increase executionLimits.maxLoopIterations`, "iterations", stdout, stderr);
      }
      if (node.condition) {
        if (loopLine !== void 0) {
          ctx.state.currentLine = loopLine;
        }
        const condResult = await evaluateArithmetic(ctx, node.condition.expression);
        if (condResult === 0)
          break;
      }
      try {
        for (const stmt of node.body) {
          const stmtResult = await ctx.executeStatement(stmt);
          stdout += stmtResult.stdout;
          stderr += stmtResult.stderr;
          exitCode = stmtResult.exitCode;
        }
      } catch (error) {
        const loopResult = handleLoopError(error, stdout, stderr, ctx.state.loopDepth);
        stdout = loopResult.stdout;
        stderr = loopResult.stderr;
        if (loopResult.action === "break")
          break;
        if (loopResult.action === "continue") {
          if (node.update) {
            await evaluateArithmetic(ctx, node.update.expression);
          }
          continue;
        }
        if (loopResult.action === "error") {
          const bodyResult2 = result(stdout, stderr, loopResult.exitCode ?? 1);
          return applyRedirections(ctx, bodyResult2, node.redirections);
        }
        throw loopResult.error;
      }
      if (node.update) {
        await evaluateArithmetic(ctx, node.update.expression);
      }
    }
  } finally {
    ctx.state.loopDepth--;
  }
  const bodyResult = result(stdout, stderr, exitCode);
  return applyRedirections(ctx, bodyResult, node.redirections);
}
__name(executeCStyleFor, "executeCStyleFor");
async function executeWhile(ctx, node, stdin = "") {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  let iterations = 0;
  let effectiveStdin = stdin;
  for (const redir of node.redirections) {
    if ((redir.operator === "<<" || redir.operator === "<<-") && redir.target.type === "HereDoc") {
      const hereDoc = redir.target;
      let content = await expandWord(ctx, hereDoc.content);
      if (hereDoc.stripTabs) {
        content = content.split("\n").map((line) => line.replace(/^\t+/, "")).join("\n");
      }
      effectiveStdin = content;
    } else if (redir.operator === "<<<" && redir.target.type === "Word") {
      effectiveStdin = `${await expandWord(ctx, redir.target)}
`;
    } else if (redir.operator === "<" && redir.target.type === "Word") {
      try {
        const target = await expandWord(ctx, redir.target);
        const filePath = ctx.fs.resolvePath(ctx.state.cwd, target);
        effectiveStdin = await ctx.fs.readFile(filePath);
      } catch {
        const target = await expandWord(ctx, redir.target);
        return failure(`bash: ${target}: No such file or directory
`);
      }
    }
  }
  const savedGroupStdin = ctx.state.groupStdin;
  if (effectiveStdin) {
    ctx.state.groupStdin = effectiveStdin;
  }
  ctx.state.loopDepth++;
  try {
    while (true) {
      iterations++;
      if (iterations > ctx.limits.maxLoopIterations) {
        throwExecutionLimit(`while loop: too many iterations (${ctx.limits.maxLoopIterations}), increase executionLimits.maxLoopIterations`, "iterations", stdout, stderr);
      }
      let conditionExitCode = 0;
      let shouldBreak = false;
      let shouldContinue = false;
      const savedInCondition = ctx.state.inCondition;
      ctx.state.inCondition = true;
      try {
        for (const stmt of node.condition) {
          const result2 = await ctx.executeStatement(stmt);
          stdout += result2.stdout;
          stderr += result2.stderr;
          conditionExitCode = result2.exitCode;
        }
      } catch (error) {
        if (error instanceof BreakError) {
          stdout += error.stdout;
          stderr += error.stderr;
          if (error.levels > 1 && ctx.state.loopDepth > 1) {
            error.levels--;
            error.stdout = stdout;
            error.stderr = stderr;
            ctx.state.inCondition = savedInCondition;
            throw error;
          }
          shouldBreak = true;
        } else if (error instanceof ContinueError) {
          stdout += error.stdout;
          stderr += error.stderr;
          if (error.levels > 1 && ctx.state.loopDepth > 1) {
            error.levels--;
            error.stdout = stdout;
            error.stderr = stderr;
            ctx.state.inCondition = savedInCondition;
            throw error;
          }
          shouldContinue = true;
        } else {
          ctx.state.inCondition = savedInCondition;
          throw error;
        }
      } finally {
        ctx.state.inCondition = savedInCondition;
      }
      if (shouldBreak)
        break;
      if (shouldContinue)
        continue;
      if (conditionExitCode !== 0)
        break;
      try {
        for (const stmt of node.body) {
          const stmtResult = await ctx.executeStatement(stmt);
          stdout += stmtResult.stdout;
          stderr += stmtResult.stderr;
          exitCode = stmtResult.exitCode;
        }
      } catch (error) {
        const loopResult = handleLoopError(error, stdout, stderr, ctx.state.loopDepth);
        stdout = loopResult.stdout;
        stderr = loopResult.stderr;
        if (loopResult.action === "break")
          break;
        if (loopResult.action === "continue")
          continue;
        if (loopResult.action === "error") {
          return result(stdout, stderr, loopResult.exitCode ?? 1);
        }
        throw loopResult.error;
      }
    }
  } finally {
    ctx.state.loopDepth--;
    ctx.state.groupStdin = savedGroupStdin;
  }
  return result(stdout, stderr, exitCode);
}
__name(executeWhile, "executeWhile");
async function executeUntil(ctx, node) {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  let iterations = 0;
  ctx.state.loopDepth++;
  try {
    while (true) {
      iterations++;
      if (iterations > ctx.limits.maxLoopIterations) {
        throwExecutionLimit(`until loop: too many iterations (${ctx.limits.maxLoopIterations}), increase executionLimits.maxLoopIterations`, "iterations", stdout, stderr);
      }
      const condResult = await executeCondition(ctx, node.condition);
      stdout += condResult.stdout;
      stderr += condResult.stderr;
      if (condResult.exitCode === 0)
        break;
      try {
        for (const stmt of node.body) {
          const stmtResult = await ctx.executeStatement(stmt);
          stdout += stmtResult.stdout;
          stderr += stmtResult.stderr;
          exitCode = stmtResult.exitCode;
        }
      } catch (error) {
        const loopResult = handleLoopError(error, stdout, stderr, ctx.state.loopDepth);
        stdout = loopResult.stdout;
        stderr = loopResult.stderr;
        if (loopResult.action === "break")
          break;
        if (loopResult.action === "continue")
          continue;
        if (loopResult.action === "error") {
          return result(stdout, stderr, loopResult.exitCode ?? 1);
        }
        throw loopResult.error;
      }
    }
  } finally {
    ctx.state.loopDepth--;
  }
  return result(stdout, stderr, exitCode);
}
__name(executeUntil, "executeUntil");
async function executeCase(ctx, node) {
  const preOpenError = await preOpenOutputRedirects(ctx, node.redirections);
  if (preOpenError) {
    return preOpenError;
  }
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  const value = await expandWord(ctx, node.word);
  let fallThrough = false;
  for (let i = 0; i < node.items.length; i++) {
    const item = node.items[i];
    let matched = fallThrough;
    if (!fallThrough) {
      for (const pattern of item.patterns) {
        let patternStr = await expandWord(ctx, pattern);
        if (isWordFullyQuoted(pattern)) {
          patternStr = escapeGlobChars(patternStr);
        }
        const nocasematch = ctx.state.shoptOptions.nocasematch;
        const extglob = ctx.state.shoptOptions.extglob;
        if (matchPattern(value, patternStr, nocasematch, extglob)) {
          matched = true;
          break;
        }
      }
    }
    if (matched) {
      const bodyResult2 = await executeStatements(ctx, item.body, stdout, stderr);
      stdout = bodyResult2.stdout;
      stderr = bodyResult2.stderr;
      exitCode = bodyResult2.exitCode;
      if (item.terminator === ";;") {
        break;
      } else if (item.terminator === ";&") {
        fallThrough = true;
      } else {
        fallThrough = false;
      }
    } else {
      fallThrough = false;
    }
  }
  const bodyResult = result(stdout, stderr, exitCode);
  return applyRedirections(ctx, bodyResult, node.redirections);
}
__name(executeCase, "executeCase");

// dist/interpreter/helpers/word-matching.js
function isWordLiteralMatch(word, targets) {
  if (word.parts.length !== 1) {
    return false;
  }
  const part = word.parts[0];
  if (part.type !== "Literal") {
    return false;
  }
  return targets.includes(part.value);
}
__name(isWordLiteralMatch, "isWordLiteralMatch");
function parseRwFdContent3(fdContent) {
  if (!fdContent.startsWith("__rw__:")) {
    return null;
  }
  const afterPrefix = fdContent.slice(7);
  const firstColonIdx = afterPrefix.indexOf(":");
  if (firstColonIdx === -1) {
    return null;
  }
  const pathLength = Number.parseInt(afterPrefix.slice(0, firstColonIdx), 10);
  if (Number.isNaN(pathLength) || pathLength < 0) {
    return null;
  }
  const pathStart = firstColonIdx + 1;
  const path = afterPrefix.slice(pathStart, pathStart + pathLength);
  const positionStart = pathStart + pathLength + 1;
  const remaining = afterPrefix.slice(positionStart);
  const posColonIdx = remaining.indexOf(":");
  if (posColonIdx === -1) {
    return null;
  }
  const position = Number.parseInt(remaining.slice(0, posColonIdx), 10);
  if (Number.isNaN(position) || position < 0) {
    return null;
  }
  const content = remaining.slice(posColonIdx + 1);
  return { path, position, content };
}
__name(parseRwFdContent3, "parseRwFdContent");

// dist/interpreter/helpers/xtrace.js
var DEFAULT_PS4 = "+ ";
async function getXtracePrefix(ctx) {
  const ps4 = ctx.state.env.PS4;
  if (ps4 === void 0) {
    return DEFAULT_PS4;
  }
  if (ps4 === "") {
    return "";
  }
  try {
    const parser = new Parser();
    const wordNode = parser.parseWordFromString(ps4, false, false);
    const expanded = await expandWord(ctx, wordNode);
    return expanded;
  } catch {
    ctx.state.expansionStderr = `${ctx.state.expansionStderr || ""}bash: ${ps4}: bad substitution
`;
    return ps4 || DEFAULT_PS4;
  }
}
__name(getXtracePrefix, "getXtracePrefix");
function formatTraceLine(parts) {
  return parts.map((part) => quoteForTrace(part)).join(" ");
}
__name(formatTraceLine, "formatTraceLine");
function quoteForTrace(value) {
  if (value === "") {
    return "''";
  }
  const needsQuoting = /[\s'"\\$`!*?[\]{}|&;<>()~#\n\t]/.test(value);
  if (!needsQuoting) {
    return value;
  }
  const hasControlChars = /[\x00-\x1f\x7f]/.test(value);
  const hasNewline = value.includes("\n");
  const hasTab = value.includes("	");
  const hasBackslash = value.includes("\\");
  const hasSingleQuote = value.includes("'");
  if (hasControlChars || hasNewline || hasTab || hasBackslash) {
    let escaped2 = "";
    for (const char of value) {
      const code = char.charCodeAt(0);
      if (char === "\n") {
        escaped2 += "\\n";
      } else if (char === "	") {
        escaped2 += "\\t";
      } else if (char === "\\") {
        escaped2 += "\\\\";
      } else if (char === "'") {
        escaped2 += "'";
      } else if (char === '"') {
        escaped2 += '"';
      } else if (code < 32 || code === 127) {
        if (code < 256) {
          escaped2 += `\\x${code.toString(16).padStart(2, "0")}`;
        } else {
          escaped2 += `\\u${code.toString(16).padStart(4, "0")}`;
        }
      } else {
        escaped2 += char;
      }
    }
    return `$'${escaped2}'`;
  }
  if (!hasSingleQuote) {
    return `'${value}'`;
  }
  const escaped = value.replace(/([\\$`"])/g, "\\$1");
  return `"${escaped}"`;
}
__name(quoteForTrace, "quoteForTrace");
async function traceSimpleCommand(ctx, commandName, args) {
  if (!ctx.state.options.xtrace) {
    return "";
  }
  const prefix = await getXtracePrefix(ctx);
  const parts = [commandName, ...args];
  const traceLine = formatTraceLine(parts);
  return `${prefix}${traceLine}
`;
}
__name(traceSimpleCommand, "traceSimpleCommand");
async function traceAssignment(ctx, name, value) {
  if (!ctx.state.options.xtrace) {
    return "";
  }
  const prefix = await getXtracePrefix(ctx);
  return `${prefix}${name}=${value}
`;
}
__name(traceAssignment, "traceAssignment");

// dist/interpreter/pipeline-execution.js
async function executePipeline(ctx, node, executeCommand) {
  const startTime = node.timed ? performance.now() : 0;
  let stdin = "";
  let lastResult = OK;
  let pipefailExitCode = 0;
  const pipestatusExitCodes = [];
  const isMultiCommandPipeline = node.commands.length > 1;
  const savedLastArg = ctx.state.lastArg;
  for (let i = 0; i < node.commands.length; i++) {
    const command = node.commands[i];
    const isLast = i === node.commands.length - 1;
    if (isMultiCommandPipeline) {
      ctx.state.lastArg = "";
    }
    const runsInSubshell = isMultiCommandPipeline && (!isLast || !ctx.state.shoptOptions.lastpipe);
    const savedEnv = runsInSubshell ? { ...ctx.state.env } : null;
    let result2;
    try {
      result2 = await executeCommand(command, stdin);
    } catch (error) {
      if (error instanceof BadSubstitutionError) {
        result2 = {
          stdout: error.stdout,
          stderr: error.stderr,
          exitCode: 1
        };
      } else if (error instanceof ExitError && node.commands.length > 1) {
        result2 = {
          stdout: error.stdout,
          stderr: error.stderr,
          exitCode: error.exitCode
        };
      } else if (error instanceof ErrexitError && node.commands.length > 1) {
        result2 = {
          stdout: error.stdout,
          stderr: error.stderr,
          exitCode: error.exitCode
        };
      } else {
        if (savedEnv) {
          ctx.state.env = savedEnv;
        }
        throw error;
      }
    }
    if (savedEnv) {
      ctx.state.env = savedEnv;
    }
    pipestatusExitCodes.push(result2.exitCode);
    if (result2.exitCode !== 0) {
      pipefailExitCode = result2.exitCode;
    }
    if (!isLast) {
      const pipeStderrToNext = node.pipeStderr?.[i] ?? false;
      if (pipeStderrToNext) {
        stdin = result2.stderr + result2.stdout;
        lastResult = {
          stdout: "",
          stderr: "",
          exitCode: result2.exitCode
        };
      } else {
        stdin = result2.stdout;
        lastResult = {
          stdout: "",
          stderr: result2.stderr,
          exitCode: result2.exitCode
        };
      }
    } else {
      lastResult = result2;
    }
  }
  const shouldSetPipestatus = node.commands.length > 1 || node.commands.length === 1 && node.commands[0].type === "SimpleCommand";
  if (shouldSetPipestatus) {
    for (const key of Object.keys(ctx.state.env)) {
      if (key.startsWith("PIPESTATUS_")) {
        delete ctx.state.env[key];
      }
    }
    for (let i = 0; i < pipestatusExitCodes.length; i++) {
      ctx.state.env[`PIPESTATUS_${i}`] = String(pipestatusExitCodes[i]);
    }
    ctx.state.env.PIPESTATUS__length = String(pipestatusExitCodes.length);
  }
  if (ctx.state.options.pipefail && pipefailExitCode !== 0) {
    lastResult = {
      ...lastResult,
      exitCode: pipefailExitCode
    };
  }
  if (node.negated) {
    lastResult = {
      ...lastResult,
      exitCode: lastResult.exitCode === 0 ? 1 : 0
    };
  }
  if (node.timed) {
    const endTime = performance.now();
    const elapsedSeconds = (endTime - startTime) / 1e3;
    const minutes = Math.floor(elapsedSeconds / 60);
    const seconds = elapsedSeconds % 60;
    let timingOutput;
    if (node.timePosix) {
      timingOutput = `real ${elapsedSeconds.toFixed(2)}
user 0.00
sys 0.00
`;
    } else {
      const realStr = `${minutes}m${seconds.toFixed(3)}s`;
      timingOutput = `
real	${realStr}
user	0m0.000s
sys	0m0.000s
`;
    }
    lastResult = {
      ...lastResult,
      stderr: lastResult.stderr + timingOutput
    };
  }
  if (isMultiCommandPipeline && !ctx.state.shoptOptions.lastpipe) {
    ctx.state.lastArg = savedLastArg;
  }
  return lastResult;
}
__name(executePipeline, "executePipeline");

// dist/interpreter/simple-command-assignments.js
async function processAssignments(ctx, node) {
  const tempAssignments = {};
  let xtraceOutput = "";
  for (const assignment of node.assignments) {
    const name = assignment.name;
    if (assignment.array) {
      const arrayResult = await processArrayAssignment(ctx, node, name, assignment.array, assignment.append, tempAssignments);
      if (arrayResult.error) {
        return {
          continueToNext: false,
          xtraceOutput,
          tempAssignments,
          error: arrayResult.error
        };
      }
      xtraceOutput += arrayResult.xtraceOutput;
      if (arrayResult.continueToNext) {
        continue;
      }
    }
    const value = assignment.value ? await expandWord(ctx, assignment.value) : "";
    const emptySubscriptMatch = name.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[\]$/);
    if (emptySubscriptMatch) {
      return {
        continueToNext: false,
        xtraceOutput,
        tempAssignments,
        error: result("", `bash: ${name}: bad array subscript
`, 1)
      };
    }
    const subscriptMatch = name.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[(.+)\]$/);
    if (subscriptMatch) {
      const subscriptResult = await processSubscriptAssignment(ctx, node, subscriptMatch[1], subscriptMatch[2], value, assignment.append, tempAssignments);
      if (subscriptResult.error) {
        return {
          continueToNext: false,
          xtraceOutput,
          tempAssignments,
          error: subscriptResult.error
        };
      }
      if (subscriptResult.continueToNext) {
        continue;
      }
    }
    const scalarResult = await processScalarAssignment(ctx, node, name, value, assignment.append, tempAssignments);
    if (scalarResult.error) {
      return {
        continueToNext: false,
        xtraceOutput,
        tempAssignments,
        error: scalarResult.error
      };
    }
    xtraceOutput += scalarResult.xtraceOutput;
    if (scalarResult.continueToNext) {
    }
  }
  return {
    continueToNext: false,
    xtraceOutput,
    tempAssignments
  };
}
__name(processAssignments, "processAssignments");
async function processArrayAssignment(ctx, node, name, array, append, tempAssignments) {
  let xtraceOutput = "";
  if (/\[.+\]$/.test(name)) {
    return {
      continueToNext: false,
      xtraceOutput: "",
      error: result("", `bash: ${name}: cannot assign list to array member
`, 1)
    };
  }
  if (isNameref(ctx, name)) {
    const target = getNamerefTarget(ctx, name);
    if (target === void 0 || target === "") {
      throw new ExitError(1, "", "");
    }
    const resolved = resolveNameref(ctx, name);
    if (resolved && /^[a-zA-Z_][a-zA-Z0-9_]*\[@\]$/.test(resolved)) {
      return {
        continueToNext: false,
        xtraceOutput: "",
        error: result("", `bash: ${name}: cannot assign list to array member
`, 1)
      };
    }
  }
  if (isReadonly(ctx, name)) {
    if (node.name) {
      xtraceOutput += `bash: ${name}: readonly variable
`;
      return { continueToNext: true, xtraceOutput };
    }
    const readonlyError = checkReadonlyError(ctx, name);
    if (readonlyError) {
      return { continueToNext: false, xtraceOutput: "", error: readonlyError };
    }
  }
  const isAssoc = ctx.state.associativeArrays?.has(name);
  const hasKeyedElements = checkHasKeyedElements(array);
  const clearExistingElements = /* @__PURE__ */ __name(() => {
    const prefix = `${name}_`;
    for (const key of Object.keys(ctx.state.env)) {
      if (key.startsWith(prefix) && !key.includes("__")) {
        delete ctx.state.env[key];
      }
    }
    delete ctx.state.env[name];
  }, "clearExistingElements");
  if (isAssoc && hasKeyedElements) {
    await processAssociativeArrayAssignment(ctx, node, name, array, append, clearExistingElements, (msg) => {
      xtraceOutput += msg;
    });
  } else if (hasKeyedElements) {
    await processIndexedArrayWithKeysAssignment(ctx, name, array, append, clearExistingElements);
  } else {
    await processSimpleArrayAssignment(ctx, name, array, append, clearExistingElements);
  }
  if (node.name) {
    tempAssignments[name] = ctx.state.env[name];
    const elements = array.map((el) => wordToLiteralString(el));
    const stringified = `(${elements.join(" ")})`;
    ctx.state.env[name] = stringified;
  }
  return { continueToNext: true, xtraceOutput };
}
__name(processArrayAssignment, "processArrayAssignment");
function checkHasKeyedElements(array) {
  return array.some((element) => {
    if (element.parts.length >= 2) {
      const first = element.parts[0];
      const second = element.parts[1];
      if (first.type !== "Glob" || !first.pattern.startsWith("[")) {
        return false;
      }
      if (first.pattern === "[" && (second.type === "DoubleQuoted" || second.type === "SingleQuoted")) {
        if (element.parts.length < 3)
          return false;
        const third = element.parts[2];
        if (third.type !== "Literal")
          return false;
        return third.value.startsWith("]=") || third.value.startsWith("]+=");
      }
      if (second.type !== "Literal") {
        return false;
      }
      if (second.value.startsWith("]")) {
        return second.value.startsWith("]=") || second.value.startsWith("]+=");
      }
      if (first.pattern.endsWith("]")) {
        return second.value.startsWith("=") || second.value.startsWith("+=");
      }
      return false;
    }
    return false;
  });
}
__name(checkHasKeyedElements, "checkHasKeyedElements");
async function processAssociativeArrayAssignment(ctx, node, name, array, append, clearExistingElements, addXtraceOutput) {
  const pendingElements = [];
  for (const element of array) {
    const parsed = parseKeyedElementFromWord(element);
    if (parsed) {
      const { key, valueParts, append: elementAppend } = parsed;
      let value;
      if (valueParts.length > 0) {
        const valueWord = { type: "Word", parts: valueParts };
        value = await expandWord(ctx, valueWord);
      } else {
        value = "";
      }
      value = expandTildesInValue(ctx, value);
      pendingElements.push({
        type: "keyed",
        key,
        value,
        append: elementAppend
      });
    } else {
      const expandedValue = await expandWord(ctx, element);
      pendingElements.push({ type: "invalid", expandedValue });
    }
  }
  if (!append) {
    clearExistingElements();
  }
  for (const pending of pendingElements) {
    if (pending.type === "keyed") {
      if (pending.append) {
        const existing = ctx.state.env[`${name}_${pending.key}`] ?? "";
        ctx.state.env[`${name}_${pending.key}`] = existing + pending.value;
      } else {
        ctx.state.env[`${name}_${pending.key}`] = pending.value;
      }
    } else {
      const lineNum = node.line ?? ctx.state.currentLine ?? 1;
      addXtraceOutput(`bash: line ${lineNum}: ${name}: ${pending.expandedValue}: must use subscript when assigning associative array
`);
    }
  }
}
__name(processAssociativeArrayAssignment, "processAssociativeArrayAssignment");
async function processIndexedArrayWithKeysAssignment(ctx, name, array, append, clearExistingElements) {
  const pendingElements = [];
  for (const element of array) {
    const parsed = parseKeyedElementFromWord(element);
    if (parsed) {
      const { key: indexExpr, valueParts, append: elementAppend } = parsed;
      let value;
      if (valueParts.length > 0) {
        const valueWord = { type: "Word", parts: valueParts };
        value = await expandWord(ctx, valueWord);
      } else {
        value = "";
      }
      value = expandTildesInValue(ctx, value);
      pendingElements.push({
        type: "keyed",
        indexExpr,
        value,
        append: elementAppend
      });
    } else {
      const expanded = await expandWordWithGlob(ctx, element);
      pendingElements.push({ type: "non-keyed", values: expanded.values });
    }
  }
  if (!append) {
    clearExistingElements();
  }
  let currentIndex = 0;
  for (const pending of pendingElements) {
    if (pending.type === "keyed") {
      let index;
      try {
        const parser = new Parser();
        const arithAst = parseArithmeticExpression(parser, pending.indexExpr);
        index = await evaluateArithmetic(ctx, arithAst.expression, false);
      } catch {
        if (/^-?\d+$/.test(pending.indexExpr)) {
          index = Number.parseInt(pending.indexExpr, 10);
        } else {
          const varValue = ctx.state.env[pending.indexExpr];
          index = varValue ? Number.parseInt(varValue, 10) : 0;
          if (Number.isNaN(index))
            index = 0;
        }
      }
      if (pending.append) {
        const existing = ctx.state.env[`${name}_${index}`] ?? "";
        ctx.state.env[`${name}_${index}`] = existing + pending.value;
      } else {
        ctx.state.env[`${name}_${index}`] = pending.value;
      }
      currentIndex = index + 1;
    } else {
      for (const val of pending.values) {
        ctx.state.env[`${name}_${currentIndex++}`] = val;
      }
    }
  }
}
__name(processIndexedArrayWithKeysAssignment, "processIndexedArrayWithKeysAssignment");
async function processSimpleArrayAssignment(ctx, name, array, append, clearExistingElements) {
  const allElements = [];
  for (const element of array) {
    const expanded = await expandWordWithGlob(ctx, element);
    allElements.push(...expanded.values);
  }
  let startIndex = 0;
  if (append) {
    const elements = getArrayElements(ctx, name);
    if (elements.length > 0) {
      const maxIndex = Math.max(...elements.map(([idx]) => typeof idx === "number" ? idx : 0));
      startIndex = maxIndex + 1;
    } else if (ctx.state.env[name] !== void 0) {
      const scalarValue = ctx.state.env[name];
      ctx.state.env[`${name}_0`] = scalarValue;
      delete ctx.state.env[name];
      startIndex = 1;
    }
  } else {
    clearExistingElements();
  }
  for (let i = 0; i < allElements.length; i++) {
    ctx.state.env[`${name}_${startIndex + i}`] = allElements[i];
  }
  if (!append) {
    ctx.state.env[`${name}__length`] = String(allElements.length);
  }
}
__name(processSimpleArrayAssignment, "processSimpleArrayAssignment");
async function processSubscriptAssignment(ctx, node, arrayName, subscriptExpr, value, append, tempAssignments) {
  let resolvedArrayName = arrayName;
  if (isNameref(ctx, arrayName)) {
    const resolved = resolveNameref(ctx, arrayName);
    if (resolved && resolved !== arrayName) {
      if (resolved.includes("[")) {
        return {
          continueToNext: false,
          xtraceOutput: "",
          error: result("", `bash: \`${resolved}': not a valid identifier
`, 1)
        };
      }
      resolvedArrayName = resolved;
    }
  }
  if (isReadonly(ctx, resolvedArrayName)) {
    if (node.name) {
      return { continueToNext: true, xtraceOutput: "" };
    }
    const readonlyError = checkReadonlyError(ctx, resolvedArrayName);
    if (readonlyError) {
      return { continueToNext: false, xtraceOutput: "", error: readonlyError };
    }
  }
  const isAssoc = ctx.state.associativeArrays?.has(resolvedArrayName);
  let envKey;
  if (isAssoc) {
    envKey = await computeAssocArrayEnvKey(ctx, resolvedArrayName, subscriptExpr);
  } else {
    const indexResult = await computeIndexedArrayIndex(ctx, resolvedArrayName, subscriptExpr);
    if (indexResult.error) {
      return {
        continueToNext: false,
        xtraceOutput: "",
        error: indexResult.error
      };
    }
    envKey = `${resolvedArrayName}_${indexResult.index}`;
  }
  const finalValue = append ? (ctx.state.env[envKey] || "") + value : value;
  if (node.name) {
    tempAssignments[envKey] = ctx.state.env[envKey];
    ctx.state.env[envKey] = finalValue;
  } else {
    const localDepth = getLocalVarDepth(ctx, resolvedArrayName);
    if (localDepth !== void 0 && localDepth === ctx.state.callDepth && ctx.state.localScopes.length > 0) {
      const currentScope = ctx.state.localScopes[ctx.state.localScopes.length - 1];
      if (!currentScope.has(envKey)) {
        currentScope.set(envKey, ctx.state.env[envKey]);
      }
    }
    ctx.state.env[envKey] = finalValue;
  }
  return { continueToNext: true, xtraceOutput: "" };
}
__name(processSubscriptAssignment, "processSubscriptAssignment");
async function computeAssocArrayEnvKey(ctx, arrayName, subscriptExpr) {
  let key;
  if (subscriptExpr.startsWith("'") && subscriptExpr.endsWith("'")) {
    key = subscriptExpr.slice(1, -1);
  } else if (subscriptExpr.startsWith('"') && subscriptExpr.endsWith('"')) {
    const inner = subscriptExpr.slice(1, -1);
    const parser = new Parser();
    const wordNode = parser.parseWordFromString(inner, true, false);
    key = await expandWord(ctx, wordNode);
  } else if (subscriptExpr.includes("$")) {
    const parser = new Parser();
    const wordNode = parser.parseWordFromString(subscriptExpr, false, false);
    key = await expandWord(ctx, wordNode);
  } else {
    key = subscriptExpr;
  }
  return `${arrayName}_${key}`;
}
__name(computeAssocArrayEnvKey, "computeAssocArrayEnvKey");
async function computeIndexedArrayIndex(ctx, arrayName, subscriptExpr) {
  let evalExpr = subscriptExpr;
  if (subscriptExpr.startsWith('"') && subscriptExpr.endsWith('"') && subscriptExpr.length >= 2) {
    evalExpr = subscriptExpr.slice(1, -1);
  }
  let index;
  if (/^-?\d+$/.test(evalExpr)) {
    index = Number.parseInt(evalExpr, 10);
  } else {
    try {
      const parser = new Parser();
      const arithAst = parseArithmeticExpression(parser, evalExpr);
      index = await evaluateArithmetic(ctx, arithAst.expression, false);
    } catch (e) {
      if (e instanceof ArithmeticError) {
        const lineNum = ctx.state.currentLine;
        const errorMsg = `bash: line ${lineNum}: ${subscriptExpr}: ${e.message}
`;
        if (e.fatal) {
          throw new ExitError(1, "", errorMsg);
        }
        return { index: 0, error: result("", errorMsg, 1) };
      }
      const varValue = ctx.state.env[subscriptExpr];
      index = varValue ? Number.parseInt(varValue, 10) : 0;
    }
    if (Number.isNaN(index))
      index = 0;
  }
  if (index < 0) {
    const elements = getArrayElements(ctx, arrayName);
    if (elements.length === 0) {
      const lineNum = ctx.state.currentLine;
      return {
        index: 0,
        error: result("", `bash: line ${lineNum}: ${arrayName}[${subscriptExpr}]: bad array subscript
`, 1)
      };
    }
    const maxIndex = Math.max(...elements.map(([idx]) => typeof idx === "number" ? idx : 0));
    index = maxIndex + 1 + index;
    if (index < 0) {
      const lineNum = ctx.state.currentLine;
      return {
        index: 0,
        error: result("", `bash: line ${lineNum}: ${arrayName}[${subscriptExpr}]: bad array subscript
`, 1)
      };
    }
  }
  return { index };
}
__name(computeIndexedArrayIndex, "computeIndexedArrayIndex");
async function processScalarAssignment(ctx, node, name, value, append, tempAssignments) {
  let xtraceOutput = "";
  let targetName = name;
  let namerefArrayRef = null;
  if (isNameref(ctx, name)) {
    const resolved = resolveNamerefForAssignment(ctx, name, value);
    if (resolved === void 0) {
      return {
        continueToNext: false,
        xtraceOutput: "",
        error: result("", `bash: ${name}: circular name reference
`, 1)
      };
    }
    if (resolved === null) {
      return { continueToNext: true, xtraceOutput: "" };
    }
    targetName = resolved;
    const arrayRefMatch = targetName.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[(.+)\]$/);
    if (arrayRefMatch) {
      namerefArrayRef = {
        arrayName: arrayRefMatch[1],
        subscriptExpr: arrayRefMatch[2]
      };
      targetName = arrayRefMatch[1];
    }
  }
  if (isReadonly(ctx, targetName)) {
    if (node.name) {
      xtraceOutput += `bash: ${targetName}: readonly variable
`;
      return { continueToNext: true, xtraceOutput };
    }
    const readonlyError = checkReadonlyError(ctx, targetName);
    if (readonlyError) {
      return { continueToNext: false, xtraceOutput: "", error: readonlyError };
    }
  }
  let finalValue;
  if (isInteger(ctx, targetName)) {
    try {
      const parser = new Parser();
      if (append) {
        const currentVal = ctx.state.env[targetName] || "0";
        const expr = `(${currentVal}) + (${value})`;
        const arithAst = parseArithmeticExpression(parser, expr);
        finalValue = String(await evaluateArithmetic(ctx, arithAst.expression));
      } else {
        const arithAst = parseArithmeticExpression(parser, value);
        finalValue = String(await evaluateArithmetic(ctx, arithAst.expression));
      }
    } catch {
      finalValue = "0";
    }
  } else {
    const { isArray: isArray2 } = await import("./chunks/expansion-JQZIG5LU.js");
    const appendKey = isArray2(ctx, targetName) ? `${targetName}_0` : targetName;
    finalValue = append ? (ctx.state.env[appendKey] || "") + value : value;
  }
  finalValue = applyCaseTransform(ctx, targetName, finalValue);
  xtraceOutput += await traceAssignment(ctx, targetName, finalValue);
  let actualEnvKey = targetName;
  if (namerefArrayRef) {
    actualEnvKey = await computeNamerefArrayEnvKey(ctx, namerefArrayRef);
  } else {
    const { isArray: isArray2 } = await import("./chunks/expansion-JQZIG5LU.js");
    if (isArray2(ctx, targetName)) {
      actualEnvKey = `${targetName}_0`;
    }
  }
  if (node.name) {
    tempAssignments[actualEnvKey] = ctx.state.env[actualEnvKey];
    ctx.state.env[actualEnvKey] = finalValue;
  } else {
    ctx.state.env[actualEnvKey] = finalValue;
    if (ctx.state.options.allexport) {
      ctx.state.exportedVars = ctx.state.exportedVars || /* @__PURE__ */ new Set();
      ctx.state.exportedVars.add(targetName);
    }
    if (ctx.state.tempEnvBindings?.some((b) => b.has(targetName))) {
      ctx.state.mutatedTempEnvVars = ctx.state.mutatedTempEnvVars || /* @__PURE__ */ new Set();
      ctx.state.mutatedTempEnvVars.add(targetName);
    }
  }
  return { continueToNext: false, xtraceOutput };
}
__name(processScalarAssignment, "processScalarAssignment");
async function computeNamerefArrayEnvKey(ctx, namerefArrayRef) {
  const { arrayName, subscriptExpr } = namerefArrayRef;
  const isAssoc = ctx.state.associativeArrays?.has(arrayName);
  if (isAssoc) {
    return computeAssocArrayEnvKey(ctx, arrayName, subscriptExpr);
  }
  let index;
  if (/^-?\d+$/.test(subscriptExpr)) {
    index = Number.parseInt(subscriptExpr, 10);
  } else {
    try {
      const parser = new Parser();
      const arithAst = parseArithmeticExpression(parser, subscriptExpr);
      index = await evaluateArithmetic(ctx, arithAst.expression, false);
    } catch {
      const varValue = ctx.state.env[subscriptExpr];
      index = varValue ? Number.parseInt(varValue, 10) : 0;
    }
    if (Number.isNaN(index))
      index = 0;
  }
  if (index < 0) {
    const elements = getArrayElements(ctx, arrayName);
    if (elements.length > 0) {
      const maxIdx = Math.max(...elements.map((e) => e[0]));
      index = maxIdx + 1 + index;
    }
  }
  return `${arrayName}_${index}`;
}
__name(computeNamerefArrayEnvKey, "computeNamerefArrayEnvKey");

// dist/interpreter/subshell-group.js
async function executeSubshell(ctx, node, stdin, executeStatement) {
  const preOpenError = await preOpenOutputRedirects(ctx, node.redirections);
  if (preOpenError) {
    return preOpenError;
  }
  const savedEnv = { ...ctx.state.env };
  const savedCwd = ctx.state.cwd;
  const savedOptions = { ...ctx.state.options };
  const savedLocalScopes = ctx.state.localScopes;
  const savedLocalVarStack = ctx.state.localVarStack;
  const savedLocalVarDepth = ctx.state.localVarDepth;
  const savedFullyUnsetLocals = ctx.state.fullyUnsetLocals;
  ctx.state.localScopes = savedLocalScopes.map((scope) => new Map(scope));
  if (savedLocalVarStack) {
    ctx.state.localVarStack = /* @__PURE__ */ new Map();
    for (const [name, stack] of savedLocalVarStack.entries()) {
      ctx.state.localVarStack.set(name, stack.map((entry) => ({ ...entry })));
    }
  }
  if (savedLocalVarDepth) {
    ctx.state.localVarDepth = new Map(savedLocalVarDepth);
  }
  if (savedFullyUnsetLocals) {
    ctx.state.fullyUnsetLocals = new Map(savedFullyUnsetLocals);
  }
  const savedLoopDepth = ctx.state.loopDepth;
  const savedParentHasLoopContext = ctx.state.parentHasLoopContext;
  ctx.state.parentHasLoopContext = savedLoopDepth > 0;
  ctx.state.loopDepth = 0;
  const savedLastArg = ctx.state.lastArg;
  const savedBashPid = ctx.state.bashPid;
  ctx.state.bashPid = ctx.state.nextVirtualPid++;
  const savedGroupStdin = ctx.state.groupStdin;
  if (stdin) {
    ctx.state.groupStdin = stdin;
  }
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  const restore = /* @__PURE__ */ __name(() => {
    ctx.state.env = savedEnv;
    ctx.state.cwd = savedCwd;
    ctx.state.options = savedOptions;
    ctx.state.localScopes = savedLocalScopes;
    ctx.state.localVarStack = savedLocalVarStack;
    ctx.state.localVarDepth = savedLocalVarDepth;
    ctx.state.fullyUnsetLocals = savedFullyUnsetLocals;
    ctx.state.loopDepth = savedLoopDepth;
    ctx.state.parentHasLoopContext = savedParentHasLoopContext;
    ctx.state.groupStdin = savedGroupStdin;
    ctx.state.bashPid = savedBashPid;
    ctx.state.lastArg = savedLastArg;
  }, "restore");
  try {
    for (const stmt of node.body) {
      const res = await executeStatement(stmt);
      stdout += res.stdout;
      stderr += res.stderr;
      exitCode = res.exitCode;
    }
  } catch (error) {
    restore();
    if (error instanceof ExecutionLimitError) {
      throw error;
    }
    if (error instanceof SubshellExitError) {
      stdout += error.stdout;
      stderr += error.stderr;
      const bodyResult3 = result(stdout, stderr, 0);
      return applyRedirections(ctx, bodyResult3, node.redirections);
    }
    if (error instanceof BreakError || error instanceof ContinueError) {
      stdout += error.stdout;
      stderr += error.stderr;
      const bodyResult3 = result(stdout, stderr, 0);
      return applyRedirections(ctx, bodyResult3, node.redirections);
    }
    if (error instanceof ExitError) {
      stdout += error.stdout;
      stderr += error.stderr;
      const bodyResult3 = result(stdout, stderr, error.exitCode);
      return applyRedirections(ctx, bodyResult3, node.redirections);
    }
    if (error instanceof ReturnError) {
      stdout += error.stdout;
      stderr += error.stderr;
      const bodyResult3 = result(stdout, stderr, error.exitCode);
      return applyRedirections(ctx, bodyResult3, node.redirections);
    }
    if (error instanceof ErrexitError) {
      const bodyResult3 = result(stdout + error.stdout, stderr + error.stderr, error.exitCode);
      return applyRedirections(ctx, bodyResult3, node.redirections);
    }
    const bodyResult2 = result(stdout, `${stderr}${getErrorMessage(error)}
`, 1);
    return applyRedirections(ctx, bodyResult2, node.redirections);
  }
  restore();
  const bodyResult = result(stdout, stderr, exitCode);
  return applyRedirections(ctx, bodyResult, node.redirections);
}
__name(executeSubshell, "executeSubshell");
async function executeGroup(ctx, node, stdin, executeStatement) {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  const fdVarError = await processFdVariableRedirections(ctx, node.redirections);
  if (fdVarError) {
    return fdVarError;
  }
  let effectiveStdin = stdin;
  for (const redir of node.redirections) {
    if ((redir.operator === "<<" || redir.operator === "<<-") && redir.target.type === "HereDoc") {
      const hereDoc = redir.target;
      let content = await expandWord(ctx, hereDoc.content);
      if (hereDoc.stripTabs) {
        content = content.split("\n").map((line) => line.replace(/^\t+/, "")).join("\n");
      }
      const fd = redir.fd ?? 0;
      if (fd !== 0) {
        if (!ctx.state.fileDescriptors) {
          ctx.state.fileDescriptors = /* @__PURE__ */ new Map();
        }
        ctx.state.fileDescriptors.set(fd, content);
      } else {
        effectiveStdin = content;
      }
    } else if (redir.operator === "<<<" && redir.target.type === "Word") {
      effectiveStdin = `${await expandWord(ctx, redir.target)}
`;
    } else if (redir.operator === "<" && redir.target.type === "Word") {
      try {
        const target = await expandWord(ctx, redir.target);
        const filePath = ctx.fs.resolvePath(ctx.state.cwd, target);
        effectiveStdin = await ctx.fs.readFile(filePath);
      } catch {
        const target = await expandWord(ctx, redir.target);
        return result("", `bash: ${target}: No such file or directory
`, 1);
      }
    }
  }
  const savedGroupStdin = ctx.state.groupStdin;
  if (effectiveStdin) {
    ctx.state.groupStdin = effectiveStdin;
  }
  try {
    for (const stmt of node.body) {
      const res = await executeStatement(stmt);
      stdout += res.stdout;
      stderr += res.stderr;
      exitCode = res.exitCode;
    }
  } catch (error) {
    ctx.state.groupStdin = savedGroupStdin;
    if (error instanceof ExecutionLimitError) {
      throw error;
    }
    if (isScopeExitError(error) || error instanceof ErrexitError || error instanceof ExitError) {
      error.prependOutput(stdout, stderr);
      throw error;
    }
    return result(stdout, `${stderr}${getErrorMessage(error)}
`, 1);
  }
  ctx.state.groupStdin = savedGroupStdin;
  const bodyResult = result(stdout, stderr, exitCode);
  return applyRedirections(ctx, bodyResult, node.redirections);
}
__name(executeGroup, "executeGroup");
async function executeUserScript(ctx, scriptPath, args, stdin, executeScript) {
  let content;
  try {
    content = await ctx.fs.readFile(scriptPath);
  } catch {
    return failure(`bash: ${scriptPath}: No such file or directory
`, 127);
  }
  if (content.startsWith("#!")) {
    const firstNewline = content.indexOf("\n");
    if (firstNewline !== -1) {
      content = content.slice(firstNewline + 1);
    }
  }
  const savedEnv = { ...ctx.state.env };
  const savedCwd = ctx.state.cwd;
  const savedOptions = { ...ctx.state.options };
  const savedLoopDepth = ctx.state.loopDepth;
  const savedParentHasLoopContext = ctx.state.parentHasLoopContext;
  const savedLastArg = ctx.state.lastArg;
  const savedBashPid = ctx.state.bashPid;
  const savedGroupStdin = ctx.state.groupStdin;
  const savedSource = ctx.state.currentSource;
  ctx.state.parentHasLoopContext = savedLoopDepth > 0;
  ctx.state.loopDepth = 0;
  ctx.state.bashPid = ctx.state.nextVirtualPid++;
  if (stdin) {
    ctx.state.groupStdin = stdin;
  }
  ctx.state.currentSource = scriptPath;
  ctx.state.env["0"] = scriptPath;
  ctx.state.env["#"] = String(args.length);
  ctx.state.env["@"] = args.join(" ");
  ctx.state.env["*"] = args.join(" ");
  for (let i = 0; i < args.length && i < 9; i++) {
    ctx.state.env[String(i + 1)] = args[i];
  }
  for (let i = args.length + 1; i <= 9; i++) {
    delete ctx.state.env[String(i)];
  }
  const cleanup = /* @__PURE__ */ __name(() => {
    ctx.state.env = savedEnv;
    ctx.state.cwd = savedCwd;
    ctx.state.options = savedOptions;
    ctx.state.loopDepth = savedLoopDepth;
    ctx.state.parentHasLoopContext = savedParentHasLoopContext;
    ctx.state.lastArg = savedLastArg;
    ctx.state.bashPid = savedBashPid;
    ctx.state.groupStdin = savedGroupStdin;
    ctx.state.currentSource = savedSource;
  }, "cleanup");
  try {
    const parser = new Parser();
    const ast = parser.parse(content);
    const execResult = await executeScript(ast);
    cleanup();
    return execResult;
  } catch (error) {
    cleanup();
    if (error instanceof ExitError) {
      throw error;
    }
    if (error instanceof ExecutionLimitError) {
      throw error;
    }
    if (error.name === "ParseException") {
      return failure(`bash: ${scriptPath}: ${error.message}
`);
    }
    throw error;
  }
}
__name(executeUserScript, "executeUserScript");

// dist/interpreter/interpreter.js
var Interpreter = class {
  static {
    __name(this, "Interpreter");
  }
  ctx;
  constructor(options, state) {
    this.ctx = {
      state,
      fs: options.fs,
      commands: options.commands,
      limits: options.limits,
      execFn: options.exec,
      executeScript: this.executeScript.bind(this),
      executeStatement: this.executeStatement.bind(this),
      executeCommand: this.executeCommand.bind(this),
      fetch: options.fetch,
      sleep: options.sleep,
      trace: options.trace
    };
  }
  /**
   * Build environment record containing only exported variables.
   * In bash, only exported variables are passed to child processes.
   * This includes both permanently exported variables (via export/declare -x)
   * and temporarily exported variables (prefix assignments like FOO=bar cmd).
   */
  buildExportedEnv() {
    const exportedVars = this.ctx.state.exportedVars;
    const tempExportedVars = this.ctx.state.tempExportedVars;
    const allExported = /* @__PURE__ */ new Set();
    if (exportedVars) {
      for (const name of exportedVars) {
        allExported.add(name);
      }
    }
    if (tempExportedVars) {
      for (const name of tempExportedVars) {
        allExported.add(name);
      }
    }
    if (allExported.size === 0) {
      return {};
    }
    const env = {};
    for (const name of allExported) {
      const value = this.ctx.state.env[name];
      if (value !== void 0) {
        env[name] = value;
      }
    }
    return env;
  }
  async executeScript(node) {
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    for (const statement of node.statements) {
      try {
        const result2 = await this.executeStatement(statement);
        stdout += result2.stdout;
        stderr += result2.stderr;
        exitCode = result2.exitCode;
        this.ctx.state.lastExitCode = exitCode;
        this.ctx.state.env["?"] = String(exitCode);
      } catch (error) {
        if (error instanceof ExitError) {
          error.prependOutput(stdout, stderr);
          throw error;
        }
        if (error instanceof PosixFatalError) {
          stdout += error.stdout;
          stderr += error.stderr;
          exitCode = error.exitCode;
          this.ctx.state.lastExitCode = exitCode;
          this.ctx.state.env["?"] = String(exitCode);
          return { stdout, stderr, exitCode, env: { ...this.ctx.state.env } };
        }
        if (error instanceof ExecutionLimitError) {
          throw error;
        }
        if (error instanceof ErrexitError) {
          stdout += error.stdout;
          stderr += error.stderr;
          exitCode = error.exitCode;
          this.ctx.state.lastExitCode = exitCode;
          this.ctx.state.env["?"] = String(exitCode);
          return { stdout, stderr, exitCode, env: { ...this.ctx.state.env } };
        }
        if (error instanceof NounsetError) {
          stdout += error.stdout;
          stderr += error.stderr;
          exitCode = 1;
          this.ctx.state.lastExitCode = exitCode;
          this.ctx.state.env["?"] = String(exitCode);
          return { stdout, stderr, exitCode, env: { ...this.ctx.state.env } };
        }
        if (error instanceof BadSubstitutionError) {
          stdout += error.stdout;
          stderr += error.stderr;
          exitCode = 1;
          this.ctx.state.lastExitCode = exitCode;
          this.ctx.state.env["?"] = String(exitCode);
          return { stdout, stderr, exitCode, env: { ...this.ctx.state.env } };
        }
        if (error instanceof ArithmeticError) {
          stdout += error.stdout;
          stderr += error.stderr;
          exitCode = 1;
          this.ctx.state.lastExitCode = exitCode;
          this.ctx.state.env["?"] = String(exitCode);
          continue;
        }
        if (error instanceof BraceExpansionError) {
          stdout += error.stdout;
          stderr += error.stderr;
          exitCode = 1;
          this.ctx.state.lastExitCode = exitCode;
          this.ctx.state.env["?"] = String(exitCode);
          continue;
        }
        if (error instanceof BreakError || error instanceof ContinueError) {
          if (this.ctx.state.loopDepth > 0) {
            error.prependOutput(stdout, stderr);
            throw error;
          }
          stdout += error.stdout;
          stderr += error.stderr;
          continue;
        }
        if (error instanceof ReturnError) {
          error.prependOutput(stdout, stderr);
          throw error;
        }
        throw error;
      }
    }
    return { stdout, stderr, exitCode, env: { ...this.ctx.state.env } };
  }
  /**
   * Execute a user script file found in PATH.
   */
  async executeUserScript(scriptPath, args, stdin = "") {
    return executeUserScript(this.ctx, scriptPath, args, stdin, (ast) => this.executeScript(ast));
  }
  async executeStatement(node) {
    this.ctx.state.commandCount++;
    if (this.ctx.state.commandCount > this.ctx.limits.maxCommandCount) {
      throwExecutionLimit(`too many commands executed (>${this.ctx.limits.maxCommandCount}), increase executionLimits.maxCommandCount`, "commands");
    }
    if (node.deferredError) {
      throw new ParseException(node.deferredError.message, node.line ?? 1, 1);
    }
    if (this.ctx.state.options.noexec) {
      return OK;
    }
    this.ctx.state.errexitSafe = false;
    let stdout = "";
    let stderr = "";
    if (this.ctx.state.options.verbose && !this.ctx.state.suppressVerbose && node.sourceText) {
      stderr += `${node.sourceText}
`;
    }
    let exitCode = 0;
    let lastExecutedIndex = -1;
    let lastPipelineNegated = false;
    for (let i = 0; i < node.pipelines.length; i++) {
      const pipeline = node.pipelines[i];
      const operator = i > 0 ? node.operators[i - 1] : null;
      if (operator === "&&" && exitCode !== 0)
        continue;
      if (operator === "||" && exitCode === 0)
        continue;
      const result2 = await this.executePipeline(pipeline);
      stdout += result2.stdout;
      stderr += result2.stderr;
      exitCode = result2.exitCode;
      lastExecutedIndex = i;
      lastPipelineNegated = pipeline.negated;
      this.ctx.state.lastExitCode = exitCode;
      this.ctx.state.env["?"] = String(exitCode);
    }
    const wasShortCircuited = lastExecutedIndex < node.pipelines.length - 1;
    const innerWasSafe = this.ctx.state.errexitSafe;
    this.ctx.state.errexitSafe = wasShortCircuited || lastPipelineNegated || innerWasSafe;
    if (this.ctx.state.options.errexit && exitCode !== 0 && lastExecutedIndex === node.pipelines.length - 1 && !lastPipelineNegated && !this.ctx.state.inCondition && !innerWasSafe) {
      throw new ErrexitError(exitCode, stdout, stderr);
    }
    return result(stdout, stderr, exitCode);
  }
  async executePipeline(node) {
    return executePipeline(this.ctx, node, (cmd, stdin) => this.executeCommand(cmd, stdin));
  }
  async executeCommand(node, stdin) {
    switch (node.type) {
      case "SimpleCommand":
        return this.executeSimpleCommand(node, stdin);
      case "If":
        return executeIf(this.ctx, node);
      case "For":
        return executeFor(this.ctx, node);
      case "CStyleFor":
        return executeCStyleFor(this.ctx, node);
      case "While":
        return executeWhile(this.ctx, node, stdin);
      case "Until":
        return executeUntil(this.ctx, node);
      case "Case":
        return executeCase(this.ctx, node);
      case "Subshell":
        return this.executeSubshell(node, stdin);
      case "Group":
        return this.executeGroup(node, stdin);
      case "FunctionDef":
        return executeFunctionDef(this.ctx, node);
      case "ArithmeticCommand":
        return this.executeArithmeticCommand(node);
      case "ConditionalCommand":
        return this.executeConditionalCommand(node);
      default:
        return OK;
    }
  }
  async executeSimpleCommand(node, stdin) {
    try {
      return await this.executeSimpleCommandInner(node, stdin);
    } catch (error) {
      if (error instanceof GlobError) {
        return failure(error.stderr);
      }
      throw error;
    }
  }
  async executeSimpleCommandInner(node, stdin) {
    if (node.line !== void 0) {
      this.ctx.state.currentLine = node.line;
    }
    if (this.ctx.state.shoptOptions.expand_aliases && node.name) {
      let currentNode = node;
      let maxExpansions = 100;
      while (maxExpansions > 0) {
        const expandedNode = this.expandAlias(currentNode);
        if (expandedNode === currentNode) {
          break;
        }
        currentNode = expandedNode;
        maxExpansions--;
      }
      this.aliasExpansionStack.clear();
      if (currentNode !== node) {
        node = currentNode;
      }
    }
    this.ctx.state.expansionStderr = "";
    const assignmentResult = await processAssignments(this.ctx, node);
    if (assignmentResult.error) {
      return assignmentResult.error;
    }
    const tempAssignments = assignmentResult.tempAssignments;
    const xtraceAssignmentOutput = assignmentResult.xtraceOutput;
    if (!node.name) {
      if (node.redirections.length > 0) {
        const redirectError = await preOpenOutputRedirects(this.ctx, node.redirections);
        if (redirectError) {
          return redirectError;
        }
        const baseResult = result("", xtraceAssignmentOutput, 0);
        return applyRedirections(this.ctx, baseResult, node.redirections);
      }
      this.ctx.state.lastArg = "";
      const stderrOutput = (this.ctx.state.expansionStderr || "") + xtraceAssignmentOutput;
      this.ctx.state.expansionStderr = "";
      return result("", stderrOutput, this.ctx.state.lastExitCode);
    }
    const isLiteralAssignmentBuiltinForExport = node.name && isWordLiteralMatch(node.name, [
      "local",
      "declare",
      "typeset",
      "export",
      "readonly"
    ]);
    const tempExportedVars = Object.keys(tempAssignments);
    if (tempExportedVars.length > 0 && !isLiteralAssignmentBuiltinForExport) {
      this.ctx.state.tempExportedVars = this.ctx.state.tempExportedVars || /* @__PURE__ */ new Set();
      for (const name of tempExportedVars) {
        this.ctx.state.tempExportedVars.add(name);
      }
    }
    const fdVarError = await processFdVariableRedirections(this.ctx, node.redirections);
    if (fdVarError) {
      for (const [name, value] of Object.entries(tempAssignments)) {
        if (value === void 0)
          delete this.ctx.state.env[name];
        else
          this.ctx.state.env[name] = value;
      }
      return fdVarError;
    }
    let stdinSourceFd = -1;
    for (const redir of node.redirections) {
      if ((redir.operator === "<<" || redir.operator === "<<-") && redir.target.type === "HereDoc") {
        const hereDoc = redir.target;
        let content = await expandWord(this.ctx, hereDoc.content);
        if (hereDoc.stripTabs) {
          content = content.split("\n").map((line) => line.replace(/^\t+/, "")).join("\n");
        }
        const fd = redir.fd ?? 0;
        if (fd !== 0) {
          if (!this.ctx.state.fileDescriptors) {
            this.ctx.state.fileDescriptors = /* @__PURE__ */ new Map();
          }
          this.ctx.state.fileDescriptors.set(fd, content);
        } else {
          stdin = content;
        }
        continue;
      }
      if (redir.operator === "<<<" && redir.target.type === "Word") {
        stdin = `${await expandWord(this.ctx, redir.target)}
`;
        continue;
      }
      if (redir.operator === "<" && redir.target.type === "Word") {
        try {
          const target = await expandWord(this.ctx, redir.target);
          const filePath = this.ctx.fs.resolvePath(this.ctx.state.cwd, target);
          stdin = await this.ctx.fs.readFile(filePath);
        } catch {
          const target = await expandWord(this.ctx, redir.target);
          for (const [name, value] of Object.entries(tempAssignments)) {
            if (value === void 0)
              delete this.ctx.state.env[name];
            else
              this.ctx.state.env[name] = value;
          }
          return failure(`bash: ${target}: No such file or directory
`);
        }
      }
      if (redir.operator === "<&" && redir.target.type === "Word") {
        const target = await expandWord(this.ctx, redir.target);
        const sourceFd = Number.parseInt(target, 10);
        if (!Number.isNaN(sourceFd) && this.ctx.state.fileDescriptors) {
          const fdContent = this.ctx.state.fileDescriptors.get(sourceFd);
          if (fdContent !== void 0) {
            if (fdContent.startsWith("__rw__:")) {
              const parsed = parseRwFdContent3(fdContent);
              if (parsed) {
                stdin = parsed.content.slice(parsed.position);
                stdinSourceFd = sourceFd;
              }
            } else if (fdContent.startsWith("__file__:") || fdContent.startsWith("__file_append__:")) {
            } else {
              stdin = fdContent;
            }
          }
        }
      }
    }
    const commandName = await expandWord(this.ctx, node.name);
    const args = [];
    const quotedArgs = [];
    const isLiteralAssignmentBuiltin = isWordLiteralMatch(node.name, [
      "local",
      "declare",
      "typeset",
      "export",
      "readonly"
    ]) && (commandName === "local" || commandName === "declare" || commandName === "typeset" || commandName === "export" || commandName === "readonly");
    if (isLiteralAssignmentBuiltin) {
      for (const arg of node.args) {
        const arrayAssignResult = await expandLocalArrayAssignment(this.ctx, arg);
        if (arrayAssignResult) {
          args.push(arrayAssignResult);
          quotedArgs.push(true);
        } else {
          const scalarAssignResult = await expandScalarAssignmentArg(this.ctx, arg);
          if (scalarAssignResult !== null) {
            args.push(scalarAssignResult);
            quotedArgs.push(true);
          } else {
            const expanded = await expandWordWithGlob(this.ctx, arg);
            for (const value of expanded.values) {
              args.push(value);
              quotedArgs.push(expanded.quoted);
            }
          }
        }
      }
    } else {
      for (const arg of node.args) {
        const expanded = await expandWordWithGlob(this.ctx, arg);
        for (const value of expanded.values) {
          args.push(value);
          quotedArgs.push(expanded.quoted);
        }
      }
    }
    if (!commandName) {
      const isOnlyExpansions = node.name.parts.every((p) => p.type === "CommandSubstitution" || p.type === "ParameterExpansion" || p.type === "ArithmeticExpansion");
      if (isOnlyExpansions) {
        if (args.length > 0) {
          const newCommandName = args.shift();
          quotedArgs.shift();
          return await this.runCommand(newCommandName, args, quotedArgs, stdin, false, false, stdinSourceFd);
        }
        return result("", "", this.ctx.state.lastExitCode);
      }
      return failure("bash: : command not found\n", 127);
    }
    if (commandName === "exec" && (args.length === 0 || args[0] === "--")) {
      for (const redir of node.redirections) {
        if (redir.target.type === "HereDoc")
          continue;
        if (redir.fdVariable)
          continue;
        const target = await expandWord(this.ctx, redir.target);
        const fd = redir.fd ?? (redir.operator === "<" || redir.operator === "<>" ? 0 : 1);
        if (!this.ctx.state.fileDescriptors) {
          this.ctx.state.fileDescriptors = /* @__PURE__ */ new Map();
        }
        switch (redir.operator) {
          case ">":
          case ">|": {
            const filePath = this.ctx.fs.resolvePath(this.ctx.state.cwd, target);
            await this.ctx.fs.writeFile(filePath, "", "utf8");
            this.ctx.state.fileDescriptors.set(fd, `__file__:${filePath}`);
            break;
          }
          case ">>": {
            const filePath = this.ctx.fs.resolvePath(this.ctx.state.cwd, target);
            this.ctx.state.fileDescriptors.set(fd, `__file_append__:${filePath}`);
            break;
          }
          case "<": {
            const filePath = this.ctx.fs.resolvePath(this.ctx.state.cwd, target);
            try {
              const content = await this.ctx.fs.readFile(filePath);
              this.ctx.state.fileDescriptors.set(fd, content);
            } catch {
              return failure(`bash: ${target}: No such file or directory
`);
            }
            break;
          }
          case "<>": {
            const filePath = this.ctx.fs.resolvePath(this.ctx.state.cwd, target);
            try {
              const content = await this.ctx.fs.readFile(filePath);
              this.ctx.state.fileDescriptors.set(fd, `__rw__:${filePath.length}:${filePath}:0:${content}`);
            } catch {
              await this.ctx.fs.writeFile(filePath, "", "utf8");
              this.ctx.state.fileDescriptors.set(fd, `__rw__:${filePath.length}:${filePath}:0:`);
            }
            break;
          }
          case ">&": {
            if (target === "-") {
              this.ctx.state.fileDescriptors.delete(fd);
            } else if (target.endsWith("-")) {
              const sourceFdStr = target.slice(0, -1);
              const sourceFd = Number.parseInt(sourceFdStr, 10);
              if (!Number.isNaN(sourceFd)) {
                const sourceInfo = this.ctx.state.fileDescriptors.get(sourceFd);
                if (sourceInfo !== void 0) {
                  this.ctx.state.fileDescriptors.set(fd, sourceInfo);
                } else {
                  this.ctx.state.fileDescriptors.set(fd, `__dupout__:${sourceFd}`);
                }
                this.ctx.state.fileDescriptors.delete(sourceFd);
              }
            } else {
              const sourceFd = Number.parseInt(target, 10);
              if (!Number.isNaN(sourceFd)) {
                this.ctx.state.fileDescriptors.set(fd, `__dupout__:${sourceFd}`);
              }
            }
            break;
          }
          case "<&": {
            if (target === "-") {
              this.ctx.state.fileDescriptors.delete(fd);
            } else if (target.endsWith("-")) {
              const sourceFdStr = target.slice(0, -1);
              const sourceFd = Number.parseInt(sourceFdStr, 10);
              if (!Number.isNaN(sourceFd)) {
                const sourceInfo = this.ctx.state.fileDescriptors.get(sourceFd);
                if (sourceInfo !== void 0) {
                  this.ctx.state.fileDescriptors.set(fd, sourceInfo);
                } else {
                  this.ctx.state.fileDescriptors.set(fd, `__dupin__:${sourceFd}`);
                }
                this.ctx.state.fileDescriptors.delete(sourceFd);
              }
            } else {
              const sourceFd = Number.parseInt(target, 10);
              if (!Number.isNaN(sourceFd)) {
                this.ctx.state.fileDescriptors.set(fd, `__dupin__:${sourceFd}`);
              }
            }
            break;
          }
        }
      }
      for (const [name, value] of Object.entries(tempAssignments)) {
        if (value === void 0)
          delete this.ctx.state.env[name];
        else
          this.ctx.state.env[name] = value;
      }
      if (this.ctx.state.tempExportedVars) {
        for (const name of Object.keys(tempAssignments)) {
          this.ctx.state.tempExportedVars.delete(name);
        }
      }
      return OK;
    }
    const xtraceOutput = await traceSimpleCommand(this.ctx, commandName, args);
    if (Object.keys(tempAssignments).length > 0) {
      this.ctx.state.tempEnvBindings = this.ctx.state.tempEnvBindings || [];
      this.ctx.state.tempEnvBindings.push(new Map(Object.entries(tempAssignments)));
    }
    let cmdResult;
    let controlFlowError = null;
    try {
      cmdResult = await this.runCommand(commandName, args, quotedArgs, stdin, false, false, stdinSourceFd);
    } catch (error) {
      if (error instanceof BreakError || error instanceof ContinueError) {
        controlFlowError = error;
        cmdResult = OK;
      } else {
        throw error;
      }
    }
    const stderrPrefix = xtraceAssignmentOutput + xtraceOutput;
    if (stderrPrefix) {
      cmdResult = {
        ...cmdResult,
        stderr: stderrPrefix + cmdResult.stderr
      };
    }
    cmdResult = await applyRedirections(this.ctx, cmdResult, node.redirections);
    if (controlFlowError) {
      throw controlFlowError;
    }
    if (args.length > 0) {
      let lastArg = args[args.length - 1];
      if ((commandName === "declare" || commandName === "local" || commandName === "typeset") && /^[a-zA-Z_][a-zA-Z0-9_]*=\(/.test(lastArg)) {
        const match = lastArg.match(/^([a-zA-Z_][a-zA-Z0-9_]*)=\(/);
        if (match) {
          lastArg = match[1];
        }
      }
      this.ctx.state.lastArg = lastArg;
    } else {
      this.ctx.state.lastArg = commandName;
    }
    const isPosixSpecialWithPersistence = isPosixSpecialBuiltin(commandName) && commandName !== "unset" && commandName !== "eval";
    const shouldRestoreTempAssignments = !this.ctx.state.options.posix || !isPosixSpecialWithPersistence;
    if (shouldRestoreTempAssignments) {
      for (const [name, value] of Object.entries(tempAssignments)) {
        if (this.ctx.state.fullyUnsetLocals?.has(name)) {
          continue;
        }
        if (value === void 0)
          delete this.ctx.state.env[name];
        else
          this.ctx.state.env[name] = value;
      }
    }
    if (this.ctx.state.tempExportedVars) {
      for (const name of Object.keys(tempAssignments)) {
        this.ctx.state.tempExportedVars.delete(name);
      }
    }
    if (Object.keys(tempAssignments).length > 0 && this.ctx.state.tempEnvBindings) {
      this.ctx.state.tempEnvBindings.pop();
    }
    if (this.ctx.state.expansionStderr) {
      cmdResult = {
        ...cmdResult,
        stderr: this.ctx.state.expansionStderr + cmdResult.stderr
      };
      this.ctx.state.expansionStderr = "";
    }
    return cmdResult;
  }
  async runCommand(commandName, args, quotedArgs, stdin, skipFunctions = false, useDefaultPath = false, stdinSourceFd = -1) {
    const dispatchCtx = {
      ctx: this.ctx,
      runCommand: /* @__PURE__ */ __name((name, a, qa, s, sf, udp, ssf) => this.runCommand(name, a, qa, s, sf, udp, ssf), "runCommand"),
      buildExportedEnv: /* @__PURE__ */ __name(() => this.buildExportedEnv(), "buildExportedEnv"),
      executeUserScript: /* @__PURE__ */ __name((path, a, s) => this.executeUserScript(path, a, s), "executeUserScript")
    };
    const builtinResult = await dispatchBuiltin(dispatchCtx, commandName, args, quotedArgs, stdin, skipFunctions, useDefaultPath, stdinSourceFd);
    if (builtinResult !== null) {
      return builtinResult;
    }
    return executeExternalCommand(dispatchCtx, commandName, args, stdin, useDefaultPath);
  }
  // Alias expansion state
  aliasExpansionStack = /* @__PURE__ */ new Set();
  expandAlias(node) {
    return expandAlias(this.ctx.state, node, this.aliasExpansionStack);
  }
  async findCommandInPath(commandName) {
    return findCommandInPath(this.ctx, commandName);
  }
  async executeSubshell(node, stdin = "") {
    return executeSubshell(this.ctx, node, stdin, (stmt) => this.executeStatement(stmt));
  }
  async executeGroup(node, stdin = "") {
    return executeGroup(this.ctx, node, stdin, (stmt) => this.executeStatement(stmt));
  }
  async executeArithmeticCommand(node) {
    if (node.line !== void 0) {
      this.ctx.state.currentLine = node.line;
    }
    const preOpenError = await preOpenOutputRedirects(this.ctx, node.redirections);
    if (preOpenError) {
      return preOpenError;
    }
    try {
      const arithResult = await evaluateArithmetic(this.ctx, node.expression.expression);
      let bodyResult = testResult(arithResult !== 0);
      if (this.ctx.state.expansionStderr) {
        bodyResult = {
          ...bodyResult,
          stderr: this.ctx.state.expansionStderr + bodyResult.stderr
        };
        this.ctx.state.expansionStderr = "";
      }
      return applyRedirections(this.ctx, bodyResult, node.redirections);
    } catch (error) {
      const bodyResult = failure(`bash: arithmetic expression: ${error.message}
`);
      return applyRedirections(this.ctx, bodyResult, node.redirections);
    }
  }
  async executeConditionalCommand(node) {
    if (node.line !== void 0) {
      this.ctx.state.currentLine = node.line;
    }
    const preOpenError = await preOpenOutputRedirects(this.ctx, node.redirections);
    if (preOpenError) {
      return preOpenError;
    }
    try {
      const condResult = await evaluateConditional(this.ctx, node.expression);
      let bodyResult = testResult(condResult);
      if (this.ctx.state.expansionStderr) {
        bodyResult = {
          ...bodyResult,
          stderr: this.ctx.state.expansionStderr + bodyResult.stderr
        };
        this.ctx.state.expansionStderr = "";
      }
      return applyRedirections(this.ctx, bodyResult, node.redirections);
    } catch (error) {
      const exitCode = error instanceof ArithmeticError ? 1 : 2;
      const bodyResult = failure(`bash: conditional expression: ${error.message}
`, exitCode);
      return applyRedirections(this.ctx, bodyResult, node.redirections);
    }
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

// dist/network/allow-list.js
function parseUrl(urlString) {
  try {
    const url = new URL(urlString);
    return {
      origin: url.origin,
      pathname: url.pathname,
      href: url.href
    };
  } catch {
    return null;
  }
}
__name(parseUrl, "parseUrl");
function normalizeAllowListEntry(entry) {
  const parsed = parseUrl(entry);
  if (!parsed) {
    return null;
  }
  return {
    origin: parsed.origin,
    // Keep the pathname exactly as specified (including trailing slash if present)
    pathPrefix: parsed.pathname
  };
}
__name(normalizeAllowListEntry, "normalizeAllowListEntry");
function matchesAllowListEntry(url, allowedEntry) {
  const parsedUrl = parseUrl(url);
  if (!parsedUrl) {
    return false;
  }
  const normalizedEntry = normalizeAllowListEntry(allowedEntry);
  if (!normalizedEntry) {
    return false;
  }
  if (parsedUrl.origin !== normalizedEntry.origin) {
    return false;
  }
  if (normalizedEntry.pathPrefix === "/" || normalizedEntry.pathPrefix === "") {
    return true;
  }
  return parsedUrl.pathname.startsWith(normalizedEntry.pathPrefix);
}
__name(matchesAllowListEntry, "matchesAllowListEntry");
function isUrlAllowed(url, allowedUrlPrefixes) {
  if (!allowedUrlPrefixes || allowedUrlPrefixes.length === 0) {
    return false;
  }
  return allowedUrlPrefixes.some((entry) => matchesAllowListEntry(url, entry));
}
__name(isUrlAllowed, "isUrlAllowed");

// dist/network/types.js
var NetworkAccessDeniedError = class extends Error {
  static {
    __name(this, "NetworkAccessDeniedError");
  }
  constructor(url) {
    super(`Network access denied: URL not in allow-list: ${url}`);
    this.name = "NetworkAccessDeniedError";
  }
};
var TooManyRedirectsError = class extends Error {
  static {
    __name(this, "TooManyRedirectsError");
  }
  constructor(maxRedirects) {
    super(`Too many redirects (max: ${maxRedirects})`);
    this.name = "TooManyRedirectsError";
  }
};
var RedirectNotAllowedError = class extends Error {
  static {
    __name(this, "RedirectNotAllowedError");
  }
  constructor(url) {
    super(`Redirect target not in allow-list: ${url}`);
    this.name = "RedirectNotAllowedError";
  }
};
var MethodNotAllowedError = class extends Error {
  static {
    __name(this, "MethodNotAllowedError");
  }
  constructor(method, allowedMethods) {
    super(`HTTP method '${method}' not allowed. Allowed methods: ${allowedMethods.join(", ")}`);
    this.name = "MethodNotAllowedError";
  }
};

// dist/network/fetch.js
var DEFAULT_MAX_REDIRECTS = 20;
var DEFAULT_TIMEOUT_MS = 3e4;
var DEFAULT_ALLOWED_METHODS = ["GET", "HEAD"];
var BODYLESS_METHODS = /* @__PURE__ */ new Set(["GET", "HEAD", "OPTIONS"]);
var REDIRECT_CODES = /* @__PURE__ */ new Set([301, 302, 303, 307, 308]);
function createSecureFetch(config) {
  const maxRedirects = config.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const allowedMethods = config.dangerouslyAllowFullInternetAccess ? ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"] : config.allowedMethods ?? DEFAULT_ALLOWED_METHODS;
  function checkAllowed(url) {
    if (config.dangerouslyAllowFullInternetAccess) {
      return;
    }
    if (!isUrlAllowed(url, config.allowedUrlPrefixes ?? [])) {
      throw new NetworkAccessDeniedError(url);
    }
  }
  __name(checkAllowed, "checkAllowed");
  function checkMethodAllowed(method) {
    if (config.dangerouslyAllowFullInternetAccess) {
      return;
    }
    const upperMethod = method.toUpperCase();
    if (!allowedMethods.includes(upperMethod)) {
      throw new MethodNotAllowedError(upperMethod, allowedMethods);
    }
  }
  __name(checkMethodAllowed, "checkMethodAllowed");
  async function secureFetch(url, options = {}) {
    const method = options.method?.toUpperCase() ?? "GET";
    checkAllowed(url);
    checkMethodAllowed(method);
    let currentUrl = url;
    let redirectCount = 0;
    const followRedirects = options.followRedirects ?? true;
    const effectiveTimeout = options.timeoutMs !== void 0 ? Math.min(options.timeoutMs, timeoutMs) : timeoutMs;
    while (true) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);
      try {
        const fetchOptions = {
          method,
          headers: options.headers,
          signal: controller.signal,
          redirect: "manual"
          // Handle redirects manually to check allow-list
        };
        if (options.body && !BODYLESS_METHODS.has(method)) {
          fetchOptions.body = options.body;
        }
        const response = await fetch(currentUrl, fetchOptions);
        if (REDIRECT_CODES.has(response.status) && followRedirects) {
          const location = response.headers.get("location");
          if (!location) {
            return await responseToResult(response, currentUrl);
          }
          const redirectUrl = new URL(location, currentUrl).href;
          if (!config.dangerouslyAllowFullInternetAccess) {
            if (!isUrlAllowed(redirectUrl, config.allowedUrlPrefixes ?? [])) {
              throw new RedirectNotAllowedError(redirectUrl);
            }
          }
          redirectCount++;
          if (redirectCount > maxRedirects) {
            throw new TooManyRedirectsError(maxRedirects);
          }
          currentUrl = redirectUrl;
          continue;
        }
        return await responseToResult(response, currentUrl);
      } finally {
        clearTimeout(timeoutId);
      }
    }
  }
  __name(secureFetch, "secureFetch");
  return secureFetch;
}
__name(createSecureFetch, "createSecureFetch");
async function responseToResult(response, url) {
  const headers = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body: await response.text(),
    url
  };
}
__name(responseToResult, "responseToResult");

// dist/Bash.js
var Bash = class _Bash {
  static {
    __name(this, "Bash");
  }
  fs;
  commands = /* @__PURE__ */ new Map();
  useDefaultLayout = false;
  limits;
  secureFetch;
  sleepFn;
  traceFn;
  logger;
  // Interpreter state (shared with interpreter instances)
  state;
  constructor(options = {}) {
    const fs3 = options.fs ?? new InMemoryFs(options.files);
    this.fs = fs3;
    this.useDefaultLayout = !options.cwd && !options.files;
    const cwd = options.cwd || (this.useDefaultLayout ? "/home/user" : "/");
    const env = {
      HOME: this.useDefaultLayout ? "/home/user" : "/",
      PATH: "/usr/bin:/bin",
      IFS: " 	\n",
      OSTYPE: "linux-gnu",
      MACHTYPE: "x86_64-pc-linux-gnu",
      HOSTTYPE: "x86_64",
      HOSTNAME: "localhost",
      // Match hostname command in sandboxed environment
      PWD: cwd,
      OLDPWD: cwd,
      OPTIND: "1",
      // getopts option index
      ...options.env
    };
    this.limits = resolveLimits({
      ...options.executionLimits,
      // Support deprecated individual options (they override executionLimits if set)
      ...options.maxCallDepth !== void 0 && {
        maxCallDepth: options.maxCallDepth
      },
      ...options.maxCommandCount !== void 0 && {
        maxCommandCount: options.maxCommandCount
      },
      ...options.maxLoopIterations !== void 0 && {
        maxLoopIterations: options.maxLoopIterations
      }
    });
    if (options.network) {
      this.secureFetch = createSecureFetch(options.network);
    }
    this.sleepFn = options.sleep;
    this.traceFn = options.trace;
    this.logger = options.logger;
    this.state = {
      env,
      cwd,
      previousDir: "/home/user",
      functions: /* @__PURE__ */ new Map(),
      localScopes: [],
      callDepth: 0,
      sourceDepth: 0,
      commandCount: 0,
      lastExitCode: 0,
      lastArg: "",
      // $_ is initially empty (or could be shell name)
      startTime: Date.now(),
      lastBackgroundPid: 0,
      bashPid: process.pid,
      // BASHPID starts as the main process PID
      nextVirtualPid: process.pid + 1,
      // Counter for unique subshell PIDs
      currentLine: 1,
      // $LINENO starts at 1
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
        // Default to true in bash >=5.2
        nocaseglob: false,
        nocasematch: false,
        expand_aliases: false,
        lastpipe: false,
        xpg_echo: false
      },
      inCondition: false,
      loopDepth: 0,
      // Export standard shell variables by default (matches bash behavior)
      // These variables are typically inherited from the parent shell environment
      exportedVars: /* @__PURE__ */ new Set([
        "HOME",
        "PATH",
        "PWD",
        "OLDPWD",
        // Also export any user-provided environment variables
        ...Object.keys(options.env || {})
      ]),
      // SHELLOPTS and BASHOPTS are readonly
      readonlyVars: /* @__PURE__ */ new Set(["SHELLOPTS", "BASHOPTS"]),
      // Hash table for PATH command lookup caching
      hashTable: /* @__PURE__ */ new Map()
    };
    this.state.env.SHELLOPTS = buildShellopts(this.state.options);
    this.state.env.BASHOPTS = buildBashopts(this.state.shoptOptions);
    initFilesystem(fs3, this.useDefaultLayout);
    if (cwd !== "/" && fs3 instanceof InMemoryFs) {
      try {
        fs3.mkdirSync(cwd, { recursive: true });
      } catch {
      }
    }
    for (const cmd of createLazyCommands(options.commands)) {
      this.registerCommand(cmd);
    }
    if (options.network) {
      for (const cmd of createNetworkCommands()) {
        this.registerCommand(cmd);
      }
    }
    if (options.customCommands) {
      for (const cmd of options.customCommands) {
        if (isLazyCommand(cmd)) {
          this.registerCommand(createLazyCustomCommand(cmd));
        } else {
          this.registerCommand(cmd);
        }
      }
    }
  }
  // ===========================================================================
  // Workflow Serde Support
  // ===========================================================================
  /**
   * Serialize Bash instance for Workflow DevKit.
   * Serializes filesystem and interpreter state. Callbacks (logger, trace, sleep,
   * secureFetch) and custom commands are NOT serialized - re-register after deserialize.
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
   * Note: Only works with InMemoryFs. Callbacks must be re-configured after deserialize.
   */
  static [WORKFLOW_DESERIALIZE](serialized) {
    const bash = new _Bash({ fs: serialized.fs });
    bash.state = serialized.state;
    bash.limits = serialized.limits;
    return bash;
  }
  registerCommand(command) {
    this.commands.set(command.name, command);
    const fs3 = this.fs;
    if (typeof fs3.writeFileSync === "function") {
      const stub = `#!/bin/bash
# Built-in command: ${command.name}
`;
      try {
        fs3.writeFileSync(`/bin/${command.name}`, stub);
      } catch {
      }
      try {
        fs3.writeFileSync(`/usr/bin/${command.name}`, stub);
      } catch {
      }
    }
  }
  logResult(result2) {
    if (this.logger) {
      if (result2.stdout) {
        this.logger.debug("stdout", { output: result2.stdout });
      }
      if (result2.stderr) {
        this.logger.info("stderr", { output: result2.stderr });
      }
      this.logger.info("exit", { exitCode: result2.exitCode });
    }
    return result2;
  }
  async exec(commandLine, options) {
    if (this.state.callDepth === 0) {
      this.state.commandCount = 0;
    }
    this.state.commandCount++;
    if (this.state.commandCount > this.limits.maxCommandCount) {
      return {
        stdout: "",
        stderr: `bash: maximum command count (${this.limits.maxCommandCount}) exceeded (possible infinite loop). Increase with executionLimits.maxCommandCount option.
`,
        exitCode: 1,
        env: { ...this.state.env, ...options?.env }
      };
    }
    if (!commandLine.trim()) {
      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        env: { ...this.state.env, ...options?.env }
      };
    }
    this.logger?.info("exec", { command: commandLine });
    const effectiveCwd = options?.cwd ?? this.state.cwd;
    let newPwd;
    let newCwd = effectiveCwd;
    if (options?.cwd) {
      if (options.env && "PWD" in options.env) {
        newPwd = options.env.PWD;
      } else if (options?.env && !("PWD" in options.env)) {
        try {
          newPwd = await this.fs.realpath(effectiveCwd);
          newCwd = newPwd;
        } catch {
          newPwd = effectiveCwd;
        }
      } else {
        newPwd = effectiveCwd;
      }
    }
    const execState = {
      ...this.state,
      env: {
        ...this.state.env,
        ...options?.env,
        // Update PWD when cwd option is provided
        ...newPwd !== void 0 ? { PWD: newPwd } : {}
      },
      cwd: newCwd,
      // Deep copy mutable objects to prevent interference
      functions: new Map(this.state.functions),
      localScopes: [...this.state.localScopes],
      options: { ...this.state.options },
      // Share hashTable reference - it should persist across exec calls
      hashTable: this.state.hashTable
    };
    let normalized = commandLine;
    if (!options?.rawScript) {
      normalized = normalizeScript(commandLine);
    }
    try {
      const ast = parse(normalized);
      const interpreterOptions = {
        fs: this.fs,
        commands: this.commands,
        limits: this.limits,
        exec: this.exec.bind(this),
        fetch: this.secureFetch,
        sleep: this.sleepFn,
        trace: this.traceFn
      };
      const interpreter = new Interpreter(interpreterOptions, execState);
      const result2 = await interpreter.executeScript(ast);
      return this.logResult(result2);
    } catch (error) {
      if (error instanceof ExitError) {
        return this.logResult({
          stdout: error.stdout,
          stderr: error.stderr,
          exitCode: error.exitCode,
          env: { ...this.state.env, ...options?.env }
        });
      }
      if (error instanceof PosixFatalError) {
        return this.logResult({
          stdout: error.stdout,
          stderr: error.stderr,
          exitCode: error.exitCode,
          env: { ...this.state.env, ...options?.env }
        });
      }
      if (error instanceof ArithmeticError) {
        return this.logResult({
          stdout: error.stdout,
          stderr: error.stderr,
          exitCode: 1,
          env: { ...this.state.env, ...options?.env }
        });
      }
      if (error instanceof ExecutionLimitError) {
        return this.logResult({
          stdout: error.stdout,
          stderr: error.stderr,
          exitCode: ExecutionLimitError.EXIT_CODE,
          env: { ...this.state.env, ...options?.env }
        });
      }
      if (error.name === "ParseException") {
        return this.logResult({
          stdout: "",
          stderr: `bash: syntax error: ${error.message}
`,
          exitCode: 2,
          env: { ...this.state.env, ...options?.env }
        });
      }
      if (error instanceof LexerError) {
        return this.logResult({
          stdout: "",
          stderr: `bash: ${error.message}
`,
          exitCode: 2,
          env: { ...this.state.env, ...options?.env }
        });
      }
      if (error instanceof RangeError) {
        return this.logResult({
          stdout: "",
          stderr: `bash: ${error.message}
`,
          exitCode: 1,
          env: { ...this.state.env, ...options?.env }
        });
      }
      throw error;
    }
  }
  // ===========================================================================
  // PUBLIC API
  // ===========================================================================
  async readFile(path) {
    return this.fs.readFile(this.fs.resolvePath(this.state.cwd, path));
  }
  async writeFile(path, content) {
    return this.fs.writeFile(this.fs.resolvePath(this.state.cwd, path), content);
  }
  getCwd() {
    return this.state.cwd;
  }
  getEnv() {
    return { ...this.state.env };
  }
};
function normalizeScript(script) {
  const lines = script.split("\n");
  const result2 = [];
  const pendingDelimiters = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (pendingDelimiters.length > 0) {
      const current = pendingDelimiters[pendingDelimiters.length - 1];
      const lineToCheck = current.stripTabs ? line.replace(/^\t+/, "") : line;
      if (lineToCheck === current.delimiter) {
        result2.push(line.trimStart());
        pendingDelimiters.pop();
        continue;
      }
      result2.push(line);
      continue;
    }
    const normalizedLine = line.trimStart();
    result2.push(normalizedLine);
    const heredocPattern = /<<(-?)\s*(['"]?)([\w-]+)\2/g;
    for (const match of normalizedLine.matchAll(heredocPattern)) {
      const stripTabs = match[1] === "-";
      const delimiter = match[3];
      pendingDelimiters.push({ delimiter, stripTabs });
    }
  }
  return result2.join("\n");
}
__name(normalizeScript, "normalizeScript");

// dist/fs/mountable-fs/mountable-fs.js
var MountableFs = class {
  static {
    __name(this, "MountableFs");
  }
  baseFs;
  mounts = /* @__PURE__ */ new Map();
  constructor(options) {
    this.baseFs = options?.base ?? new InMemoryFs();
    if (options?.mounts) {
      for (const { mountPoint, filesystem } of options.mounts) {
        this.mount(mountPoint, filesystem);
      }
    }
  }
  /**
   * Mount a filesystem at the specified virtual path.
   *
   * @param mountPoint - The virtual path where the filesystem will be accessible
   * @param filesystem - The filesystem to mount
   * @throws Error if mounting at root '/' or inside an existing mount
   */
  mount(mountPoint, filesystem) {
    this.validateMountPath(mountPoint);
    const normalized = this.normalizePath(mountPoint);
    this.validateMount(normalized);
    this.mounts.set(normalized, {
      mountPoint: normalized,
      filesystem
    });
  }
  /**
   * Unmount the filesystem at the specified path.
   *
   * @param mountPoint - The virtual path to unmount
   * @throws Error if no filesystem is mounted at this path
   */
  unmount(mountPoint) {
    const normalized = this.normalizePath(mountPoint);
    if (!this.mounts.has(normalized)) {
      throw new Error(`No filesystem mounted at '${mountPoint}'`);
    }
    this.mounts.delete(normalized);
  }
  /**
   * Get all current mounts.
   */
  getMounts() {
    return Array.from(this.mounts.values()).map((entry) => ({
      mountPoint: entry.mountPoint,
      filesystem: entry.filesystem
    }));
  }
  /**
   * Check if a path is exactly a mount point.
   */
  isMountPoint(path) {
    const normalized = this.normalizePath(path);
    return this.mounts.has(normalized);
  }
  /**
   * Validate mount path format before normalization.
   * Rejects paths containing . or .. segments.
   */
  validateMountPath(mountPoint) {
    const segments = mountPoint.split("/");
    for (const segment of segments) {
      if (segment === "." || segment === "..") {
        throw new Error(`Invalid mount point '${mountPoint}': contains '.' or '..' segments`);
      }
    }
  }
  /**
   * Validate that a mount point is allowed.
   */
  validateMount(mountPoint) {
    if (mountPoint === "/") {
      throw new Error("Cannot mount at root '/'");
    }
    for (const existingMount of this.mounts.keys()) {
      if (existingMount === mountPoint) {
        continue;
      }
      if (mountPoint.startsWith(`${existingMount}/`)) {
        throw new Error(`Cannot mount at '${mountPoint}': inside existing mount '${existingMount}'`);
      }
      if (existingMount.startsWith(`${mountPoint}/`)) {
        throw new Error(`Cannot mount at '${mountPoint}': would contain existing mount '${existingMount}'`);
      }
    }
  }
  /**
   * Normalize a path to a consistent format.
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
      } else {
        resolved.push(part);
      }
    }
    return `/${resolved.join("/")}`;
  }
  /**
   * Route a path to the appropriate filesystem.
   * Returns the filesystem and the relative path within that filesystem.
   */
  routePath(path) {
    const normalized = this.normalizePath(path);
    let bestMatch = null;
    let bestMatchLength = 0;
    for (const entry of this.mounts.values()) {
      const mp = entry.mountPoint;
      if (normalized === mp) {
        return { fs: entry.filesystem, relativePath: "/" };
      }
      if (normalized.startsWith(`${mp}/`)) {
        if (mp.length > bestMatchLength) {
          bestMatch = entry;
          bestMatchLength = mp.length;
        }
      }
    }
    if (bestMatch) {
      const relativePath = normalized.slice(bestMatchLength);
      return {
        fs: bestMatch.filesystem,
        relativePath: relativePath || "/"
      };
    }
    return { fs: this.baseFs, relativePath: normalized };
  }
  /**
   * Get mount points that are immediate children of a directory.
   */
  getChildMountPoints(dirPath) {
    const normalized = this.normalizePath(dirPath);
    const prefix = normalized === "/" ? "/" : `${normalized}/`;
    const children = [];
    for (const mountPoint of this.mounts.keys()) {
      if (mountPoint.startsWith(prefix)) {
        const remainder = mountPoint.slice(prefix.length);
        const childName = remainder.split("/")[0];
        if (childName && !children.includes(childName)) {
          children.push(childName);
        }
      }
    }
    return children;
  }
  // ==================== IFileSystem Implementation ====================
  async readFile(path, options) {
    const { fs: fs3, relativePath } = this.routePath(path);
    return fs3.readFile(relativePath, options);
  }
  async readFileBuffer(path) {
    const { fs: fs3, relativePath } = this.routePath(path);
    return fs3.readFileBuffer(relativePath);
  }
  async writeFile(path, content, options) {
    const { fs: fs3, relativePath } = this.routePath(path);
    return fs3.writeFile(relativePath, content, options);
  }
  async appendFile(path, content, options) {
    const { fs: fs3, relativePath } = this.routePath(path);
    return fs3.appendFile(relativePath, content, options);
  }
  async exists(path) {
    const normalized = this.normalizePath(path);
    if (this.mounts.has(normalized)) {
      return true;
    }
    const childMounts = this.getChildMountPoints(normalized);
    if (childMounts.length > 0) {
      return true;
    }
    const { fs: fs3, relativePath } = this.routePath(path);
    return fs3.exists(relativePath);
  }
  async stat(path) {
    const normalized = this.normalizePath(path);
    const mountEntry = this.mounts.get(normalized);
    if (mountEntry) {
      try {
        return await mountEntry.filesystem.stat("/");
      } catch {
        return {
          isFile: false,
          isDirectory: true,
          isSymbolicLink: false,
          mode: 493,
          size: 0,
          mtime: /* @__PURE__ */ new Date()
        };
      }
    }
    const childMounts = this.getChildMountPoints(normalized);
    if (childMounts.length > 0) {
      try {
        const baseStat = await this.baseFs.stat(normalized);
        return baseStat;
      } catch {
        return {
          isFile: false,
          isDirectory: true,
          isSymbolicLink: false,
          mode: 493,
          size: 0,
          mtime: /* @__PURE__ */ new Date()
        };
      }
    }
    const { fs: fs3, relativePath } = this.routePath(path);
    return fs3.stat(relativePath);
  }
  async lstat(path) {
    const normalized = this.normalizePath(path);
    const mountEntry = this.mounts.get(normalized);
    if (mountEntry) {
      try {
        return await mountEntry.filesystem.lstat("/");
      } catch {
        return {
          isFile: false,
          isDirectory: true,
          isSymbolicLink: false,
          mode: 493,
          size: 0,
          mtime: /* @__PURE__ */ new Date()
        };
      }
    }
    const childMounts = this.getChildMountPoints(normalized);
    if (childMounts.length > 0) {
      try {
        return await this.baseFs.lstat(normalized);
      } catch {
        return {
          isFile: false,
          isDirectory: true,
          isSymbolicLink: false,
          mode: 493,
          size: 0,
          mtime: /* @__PURE__ */ new Date()
        };
      }
    }
    const { fs: fs3, relativePath } = this.routePath(path);
    return fs3.lstat(relativePath);
  }
  async mkdir(path, options) {
    const normalized = this.normalizePath(path);
    if (this.mounts.has(normalized)) {
      if (options?.recursive) {
        return;
      }
      throw new Error(`EEXIST: directory already exists, mkdir '${path}'`);
    }
    const childMounts = this.getChildMountPoints(normalized);
    if (childMounts.length > 0 && options?.recursive) {
      return;
    }
    const { fs: fs3, relativePath } = this.routePath(path);
    return fs3.mkdir(relativePath, options);
  }
  async readdir(path) {
    const normalized = this.normalizePath(path);
    const entries = /* @__PURE__ */ new Set();
    let readdirError = null;
    const { fs: fs3, relativePath } = this.routePath(path);
    try {
      const fsEntries = await fs3.readdir(relativePath);
      for (const entry of fsEntries) {
        entries.add(entry);
      }
    } catch (err) {
      const code = err.code;
      const message = err.message || "";
      if (code !== "ENOENT" && !message.includes("ENOENT")) {
        throw err;
      }
      readdirError = err;
    }
    const childMounts = this.getChildMountPoints(normalized);
    for (const child of childMounts) {
      entries.add(child);
    }
    if (entries.size === 0 && readdirError && !this.mounts.has(normalized)) {
      throw readdirError;
    }
    return Array.from(entries).sort();
  }
  async rm(path, options) {
    const normalized = this.normalizePath(path);
    if (this.mounts.has(normalized)) {
      throw new Error(`EBUSY: mount point, cannot remove '${path}'`);
    }
    const childMounts = this.getChildMountPoints(normalized);
    if (childMounts.length > 0) {
      throw new Error(`EBUSY: contains mount points, cannot remove '${path}'`);
    }
    const { fs: fs3, relativePath } = this.routePath(path);
    return fs3.rm(relativePath, options);
  }
  async cp(src, dest, options) {
    const srcRoute = this.routePath(src);
    const destRoute = this.routePath(dest);
    if (srcRoute.fs === destRoute.fs) {
      return srcRoute.fs.cp(srcRoute.relativePath, destRoute.relativePath, options);
    }
    return this.crossMountCopy(src, dest, options);
  }
  async mv(src, dest) {
    const normalized = this.normalizePath(src);
    if (this.mounts.has(normalized)) {
      throw new Error(`EBUSY: mount point, cannot move '${src}'`);
    }
    const srcRoute = this.routePath(src);
    const destRoute = this.routePath(dest);
    if (srcRoute.fs === destRoute.fs) {
      return srcRoute.fs.mv(srcRoute.relativePath, destRoute.relativePath);
    }
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
    const allPaths = /* @__PURE__ */ new Set();
    for (const p of this.baseFs.getAllPaths()) {
      allPaths.add(p);
    }
    for (const mountPoint of this.mounts.keys()) {
      const parts = mountPoint.split("/").filter(Boolean);
      let current = "";
      for (const part of parts) {
        current = `${current}/${part}`;
        allPaths.add(current);
      }
      const entry = this.mounts.get(mountPoint);
      if (!entry)
        continue;
      for (const p of entry.filesystem.getAllPaths()) {
        if (p === "/") {
          allPaths.add(mountPoint);
        } else {
          allPaths.add(`${mountPoint}${p}`);
        }
      }
    }
    return Array.from(allPaths).sort();
  }
  async chmod(path, mode) {
    const normalized = this.normalizePath(path);
    const mountEntry = this.mounts.get(normalized);
    if (mountEntry) {
      return mountEntry.filesystem.chmod("/", mode);
    }
    const { fs: fs3, relativePath } = this.routePath(path);
    return fs3.chmod(relativePath, mode);
  }
  async symlink(target, linkPath) {
    const { fs: fs3, relativePath } = this.routePath(linkPath);
    return fs3.symlink(target, relativePath);
  }
  async link(existingPath, newPath) {
    const existingRoute = this.routePath(existingPath);
    const newRoute = this.routePath(newPath);
    if (existingRoute.fs !== newRoute.fs) {
      throw new Error(`EXDEV: cross-device link not permitted, link '${existingPath}' -> '${newPath}'`);
    }
    return existingRoute.fs.link(existingRoute.relativePath, newRoute.relativePath);
  }
  async readlink(path) {
    const { fs: fs3, relativePath } = this.routePath(path);
    return fs3.readlink(relativePath);
  }
  /**
   * Resolve all symlinks in a path to get the canonical physical path.
   * This is equivalent to POSIX realpath().
   */
  async realpath(path) {
    const normalized = this.normalizePath(path);
    const mountEntry = this.mounts.get(normalized);
    if (mountEntry) {
      return normalized;
    }
    const { fs: fs3, relativePath } = this.routePath(path);
    const resolvedRelative = await fs3.realpath(relativePath);
    for (const [mp, _entry] of this.mounts) {
      if (normalized === mp || normalized.startsWith(`${mp}/`)) {
        if (resolvedRelative === "/") {
          return mp;
        }
        return `${mp}${resolvedRelative}`;
      }
    }
    return resolvedRelative;
  }
  /**
   * Perform a cross-mount copy operation.
   */
  async crossMountCopy(src, dest, options) {
    const srcStat = await this.lstat(src);
    if (srcStat.isFile) {
      const content = await this.readFileBuffer(src);
      await this.writeFile(dest, content);
      await this.chmod(dest, srcStat.mode);
    } else if (srcStat.isDirectory) {
      if (!options?.recursive) {
        throw new Error(`cp: ${src} is a directory (not copied)`);
      }
      await this.mkdir(dest, { recursive: true });
      const children = await this.readdir(src);
      for (const child of children) {
        const srcChild = src === "/" ? `/${child}` : `${src}/${child}`;
        const destChild = dest === "/" ? `/${child}` : `${dest}/${child}`;
        await this.crossMountCopy(srcChild, destChild, options);
      }
    } else if (srcStat.isSymbolicLink) {
      const target = await this.readlink(src);
      await this.symlink(target, dest);
    }
  }
  /**
   * Set access and modification times of a file
   * @param path - The file path
   * @param atime - Access time
   * @param mtime - Modification time
   */
  async utimes(path, atime, mtime) {
    const { fs: fs3, relativePath } = this.routePath(path);
    return fs3.utimes(relativePath, atime, mtime);
  }
};

// dist/fs/overlay-fs/overlay-fs.js
import * as fs from "node:fs";
import * as nodePath from "node:path";
var DEFAULT_MOUNT_POINT = "/home/user/project";
var OverlayFs = class {
  static {
    __name(this, "OverlayFs");
  }
  root;
  mountPoint;
  readOnly;
  memory = /* @__PURE__ */ new Map();
  deleted = /* @__PURE__ */ new Set();
  constructor(options) {
    this.root = nodePath.resolve(options.root);
    const mp = options.mountPoint ?? DEFAULT_MOUNT_POINT;
    this.mountPoint = mp === "/" ? "/" : mp.replace(/\/+$/, "");
    if (!this.mountPoint.startsWith("/")) {
      throw new Error(`Mount point must be an absolute path: ${mp}`);
    }
    this.readOnly = options.readOnly ?? false;
    if (!fs.existsSync(this.root)) {
      throw new Error(`OverlayFs root does not exist: ${this.root}`);
    }
    const stat = fs.statSync(this.root);
    if (!stat.isDirectory()) {
      throw new Error(`OverlayFs root is not a directory: ${this.root}`);
    }
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
          mode: 493,
          mtime: /* @__PURE__ */ new Date()
        });
      }
    }
    if (!this.memory.has("/")) {
      this.memory.set("/", {
        type: "directory",
        mode: 493,
        mtime: /* @__PURE__ */ new Date()
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
          mode: 493,
          mtime: /* @__PURE__ */ new Date()
        });
      }
    }
  }
  /**
   * Create a virtual file in memory (sync, for initialization)
   */
  writeFileSync(path, content) {
    const normalized = this.normalizePath(path);
    const parent = this.getDirname(normalized);
    if (parent !== "/") {
      this.mkdirSync(parent);
    }
    const buffer = content instanceof Uint8Array ? content : new TextEncoder().encode(content);
    this.memory.set(normalized, {
      type: "file",
      content: buffer,
      mode: 420,
      mtime: /* @__PURE__ */ new Date()
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
      } else {
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
    const relativePath = this.getRelativeToMount(normalized);
    if (relativePath === null) {
      return null;
    }
    const realPath = nodePath.join(this.root, relativePath);
    const resolvedReal = nodePath.resolve(realPath);
    if (!resolvedReal.startsWith(this.root) && resolvedReal !== this.root.replace(/\/$/, "")) {
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
        mode: 493,
        mtime: /* @__PURE__ */ new Date()
      });
    }
    this.deleted.delete(dir);
  }
  /**
   * Check if a path exists in the overlay (memory + real fs - deleted)
   */
  async existsInOverlay(virtualPath) {
    const normalized = this.normalizePath(virtualPath);
    if (this.deleted.has(normalized)) {
      return false;
    }
    if (this.memory.has(normalized)) {
      return true;
    }
    const realPath = this.toRealPath(normalized);
    if (!realPath) {
      return false;
    }
    try {
      await fs.promises.access(realPath);
      return true;
    } catch {
      return false;
    }
  }
  async readFile(path, options) {
    const buffer = await this.readFileBuffer(path);
    const encoding = getEncoding(options);
    return fromBuffer(buffer, encoding);
  }
  async readFileBuffer(path, seen = /* @__PURE__ */ new Set()) {
    const normalized = this.normalizePath(path);
    if (seen.has(normalized)) {
      throw new Error(`ELOOP: too many levels of symbolic links, open '${path}'`);
    }
    seen.add(normalized);
    if (this.deleted.has(normalized)) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }
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
    } catch (e) {
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
      mode: 420,
      mtime: /* @__PURE__ */ new Date()
    });
    this.deleted.delete(normalized);
  }
  async appendFile(path, content, options) {
    this.assertWritable(`append '${path}'`);
    const normalized = this.normalizePath(path);
    const encoding = getEncoding(options);
    const newBuffer = toBuffer(content, encoding);
    let existingBuffer;
    try {
      existingBuffer = await this.readFileBuffer(normalized);
    } catch {
      existingBuffer = new Uint8Array(0);
    }
    const combined = new Uint8Array(existingBuffer.length + newBuffer.length);
    combined.set(existingBuffer);
    combined.set(newBuffer, existingBuffer.length);
    this.ensureParentDirs(normalized);
    this.memory.set(normalized, {
      type: "file",
      content: combined,
      mode: 420,
      mtime: /* @__PURE__ */ new Date()
    });
    this.deleted.delete(normalized);
  }
  async exists(path) {
    return this.existsInOverlay(path);
  }
  async stat(path, seen = /* @__PURE__ */ new Set()) {
    const normalized = this.normalizePath(path);
    if (seen.has(normalized)) {
      throw new Error(`ELOOP: too many levels of symbolic links, stat '${path}'`);
    }
    seen.add(normalized);
    if (this.deleted.has(normalized)) {
      throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
    }
    const entry = this.memory.get(normalized);
    if (entry) {
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
        mtime: entry.mtime
      };
    }
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
        mtime: stat.mtime
      };
    } catch (e) {
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
    const entry = this.memory.get(normalized);
    if (entry) {
      if (entry.type === "symlink") {
        return {
          isFile: false,
          isDirectory: false,
          isSymbolicLink: true,
          mode: entry.mode,
          size: entry.target.length,
          mtime: entry.mtime
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
        mtime: entry.mtime
      };
    }
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
        mtime: stat.mtime
      };
    } catch (e) {
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
    const exists = await this.existsInOverlay(normalized);
    if (exists) {
      if (!options?.recursive) {
        throw new Error(`EEXIST: file already exists, mkdir '${path}'`);
      }
      return;
    }
    const parent = this.dirname(normalized);
    if (parent !== "/") {
      const parentExists = await this.existsInOverlay(parent);
      if (!parentExists) {
        if (options?.recursive) {
          await this.mkdir(parent, { recursive: true });
        } else {
          throw new Error(`ENOENT: no such file or directory, mkdir '${path}'`);
        }
      }
    }
    this.memory.set(normalized, {
      type: "directory",
      mode: 493,
      mtime: /* @__PURE__ */ new Date()
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
    const entriesMap = /* @__PURE__ */ new Map();
    const deletedChildren = /* @__PURE__ */ new Set();
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
    for (const [memPath, entry] of this.memory) {
      if (memPath === normalized)
        continue;
      if (memPath.startsWith(prefix)) {
        const rest = memPath.slice(prefix.length);
        const name = rest.split("/")[0];
        if (name && !deletedChildren.has(name) && !rest.includes("/", 1)) {
          entriesMap.set(name, {
            name,
            isFile: entry.type === "file",
            isDirectory: entry.type === "directory",
            isSymbolicLink: entry.type === "symlink"
          });
        }
      }
    }
    const realPath = this.toRealPath(normalized);
    if (realPath) {
      try {
        const realEntries = await fs.promises.readdir(realPath, {
          withFileTypes: true
        });
        for (const dirent of realEntries) {
          if (!deletedChildren.has(dirent.name) && !entriesMap.has(dirent.name)) {
            entriesMap.set(dirent.name, {
              name: dirent.name,
              isFile: dirent.isFile(),
              isDirectory: dirent.isDirectory(),
              isSymbolicLink: dirent.isSymbolicLink()
            });
          }
        }
      } catch (e) {
        if (e.code === "ENOENT") {
          if (!this.memory.has(normalized)) {
            throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
          }
        } else if (e.code !== "ENOTDIR") {
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
    const seen = /* @__PURE__ */ new Set();
    let didFollowSymlink = followedSymlink;
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
    if (entry) {
      return { normalized, outsideOverlay: false };
    }
    const relativePath = this.getRelativeToMount(normalized);
    if (relativePath === null) {
      return { normalized, outsideOverlay: true };
    }
    const realPath = this.toRealPath(normalized);
    if (!realPath) {
      return { normalized, outsideOverlay: true };
    }
    try {
      const stat = await fs.promises.lstat(realPath);
      if (stat.isSymbolicLink()) {
        const target = await fs.promises.readlink(realPath);
        const resolvedTarget = this.resolveSymlink(normalized, target);
        return this.resolveForReaddir(resolvedTarget, true);
      }
      return { normalized, outsideOverlay: false };
    } catch {
      if (didFollowSymlink) {
        return { normalized, outsideOverlay: true };
      }
      return { normalized, outsideOverlay: false };
    }
  }
  async readdir(path) {
    const { normalized, outsideOverlay } = await this.resolveForReaddir(path);
    if (outsideOverlay) {
      return [];
    }
    const entriesMap = await this.readdirCore(path, normalized);
    return Array.from(entriesMap.keys()).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  }
  async readdirWithFileTypes(path) {
    const { normalized, outsideOverlay } = await this.resolveForReaddir(path);
    if (outsideOverlay) {
      return [];
    }
    const entriesMap = await this.readdirCore(path, normalized);
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
    } catch {
    }
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
    } else if (srcStat.isDirectory) {
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
    const paths = new Set(this.memory.keys());
    for (const deleted of this.deleted) {
      paths.delete(deleted);
    }
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
    } catch {
    }
  }
  async chmod(path, mode) {
    this.assertWritable(`chmod '${path}'`);
    const normalized = this.normalizePath(path);
    const exists = await this.existsInOverlay(normalized);
    if (!exists) {
      throw new Error(`ENOENT: no such file or directory, chmod '${path}'`);
    }
    const entry = this.memory.get(normalized);
    if (entry) {
      entry.mode = mode;
      return;
    }
    const stat = await this.stat(normalized);
    if (stat.isFile) {
      const content = await this.readFileBuffer(normalized);
      this.memory.set(normalized, {
        type: "file",
        content,
        mode,
        mtime: /* @__PURE__ */ new Date()
      });
    } else if (stat.isDirectory) {
      this.memory.set(normalized, {
        type: "directory",
        mode,
        mtime: /* @__PURE__ */ new Date()
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
      mode: 511,
      mtime: /* @__PURE__ */ new Date()
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
    const content = await this.readFileBuffer(existingNorm);
    this.ensureParentDirs(newNorm);
    this.memory.set(newNorm, {
      type: "file",
      content,
      mode: existingStat.mode,
      mtime: /* @__PURE__ */ new Date()
    });
    this.deleted.delete(newNorm);
  }
  async readlink(path) {
    const normalized = this.normalizePath(path);
    if (this.deleted.has(normalized)) {
      throw new Error(`ENOENT: no such file or directory, readlink '${path}'`);
    }
    const entry = this.memory.get(normalized);
    if (entry) {
      if (entry.type !== "symlink") {
        throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
      }
      return entry.target;
    }
    const realPath = this.toRealPath(normalized);
    if (!realPath) {
      throw new Error(`ENOENT: no such file or directory, readlink '${path}'`);
    }
    try {
      return await fs.promises.readlink(realPath);
    } catch (e) {
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
    const seen = /* @__PURE__ */ new Set();
    const resolveAll = /* @__PURE__ */ __name(async (p) => {
      const parts = p === "/" ? [] : p.slice(1).split("/");
      let resolved = "";
      for (const part of parts) {
        resolved = `${resolved}/${part}`;
        if (seen.has(resolved)) {
          throw new Error(`ELOOP: too many levels of symbolic links, realpath '${path}'`);
        }
        if (this.deleted.has(resolved)) {
          throw new Error(`ENOENT: no such file or directory, realpath '${path}'`);
        }
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
        if (!entry) {
          const realPath = this.toRealPath(resolved);
          if (realPath) {
            try {
              const stat = await fs.promises.lstat(realPath);
              if (stat.isSymbolicLink()) {
                const target = await fs.promises.readlink(realPath);
                seen.add(resolved);
                resolved = this.resolveSymlink(resolved, target);
                return resolveAll(resolved);
              }
            } catch (e) {
              if (e.code === "ENOENT") {
                throw new Error(`ENOENT: no such file or directory, realpath '${path}'`);
              }
              throw e;
            }
          }
        }
      }
      return resolved || "/";
    }, "resolveAll");
    const result2 = await resolveAll(normalized);
    const exists = await this.existsInOverlay(result2);
    if (!exists) {
      throw new Error(`ENOENT: no such file or directory, realpath '${path}'`);
    }
    return result2;
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
    const entry = this.memory.get(normalized);
    if (entry) {
      entry.mtime = mtime;
      return;
    }
    const stat = await this.stat(normalized);
    if (stat.isFile) {
      const content = await this.readFileBuffer(normalized);
      this.memory.set(normalized, {
        type: "file",
        content,
        mode: stat.mode,
        mtime
      });
    } else if (stat.isDirectory) {
      this.memory.set(normalized, {
        type: "directory",
        mode: stat.mode,
        mtime
      });
    }
  }
};

// dist/fs/read-write-fs/read-write-fs.js
import * as fs2 from "node:fs";
import * as nodePath2 from "node:path";
var ReadWriteFs = class {
  static {
    __name(this, "ReadWriteFs");
  }
  root;
  constructor(options) {
    this.root = nodePath2.resolve(options.root);
    if (!fs2.existsSync(this.root)) {
      throw new Error(`ReadWriteFs root does not exist: ${this.root}`);
    }
    const stat = fs2.statSync(this.root);
    if (!stat.isDirectory()) {
      throw new Error(`ReadWriteFs root is not a directory: ${this.root}`);
    }
  }
  /**
   * Convert a virtual path to a real filesystem path.
   */
  toRealPath(virtualPath) {
    const normalized = this.normalizePath(virtualPath);
    const realPath = nodePath2.join(this.root, normalized);
    return nodePath2.resolve(realPath);
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
      } else {
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
      const content = await fs2.promises.readFile(realPath);
      return new Uint8Array(content);
    } catch (e) {
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
    const dir = nodePath2.dirname(realPath);
    await fs2.promises.mkdir(dir, { recursive: true });
    await fs2.promises.writeFile(realPath, buffer);
  }
  async appendFile(path, content, options) {
    const realPath = this.toRealPath(path);
    const encoding = getEncoding(options);
    const buffer = toBuffer(content, encoding);
    const dir = nodePath2.dirname(realPath);
    await fs2.promises.mkdir(dir, { recursive: true });
    await fs2.promises.appendFile(realPath, buffer);
  }
  async exists(path) {
    const realPath = this.toRealPath(path);
    try {
      await fs2.promises.access(realPath);
      return true;
    } catch {
      return false;
    }
  }
  async stat(path) {
    const realPath = this.toRealPath(path);
    try {
      const stat = await fs2.promises.stat(realPath);
      return {
        isFile: stat.isFile(),
        isDirectory: stat.isDirectory(),
        isSymbolicLink: false,
        // stat follows symlinks
        mode: stat.mode,
        size: stat.size,
        mtime: stat.mtime
      };
    } catch (e) {
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
      const stat = await fs2.promises.lstat(realPath);
      return {
        isFile: stat.isFile(),
        isDirectory: stat.isDirectory(),
        isSymbolicLink: stat.isSymbolicLink(),
        mode: stat.mode,
        size: stat.size,
        mtime: stat.mtime
      };
    } catch (e) {
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
      await fs2.promises.mkdir(realPath, { recursive: options?.recursive });
    } catch (e) {
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
      const entries = await fs2.promises.readdir(realPath, {
        withFileTypes: true
      });
      return entries.map((dirent) => ({
        name: dirent.name,
        isFile: dirent.isFile(),
        isDirectory: dirent.isDirectory(),
        isSymbolicLink: dirent.isSymbolicLink()
      })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    } catch (e) {
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
      await fs2.promises.rm(realPath, {
        recursive: options?.recursive ?? false,
        force: options?.force ?? false
      });
    } catch (e) {
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
      await fs2.promises.cp(srcReal, destReal, {
        recursive: options?.recursive ?? false
      });
    } catch (e) {
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
    const destDir = nodePath2.dirname(destReal);
    await fs2.promises.mkdir(destDir, { recursive: true });
    try {
      await fs2.promises.rename(srcReal, destReal);
    } catch (e) {
      const err = e;
      if (err.code === "ENOENT") {
        throw new Error(`ENOENT: no such file or directory, mv '${src}'`);
      }
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
    const paths = [];
    this.scanDir("/", paths);
    return paths;
  }
  scanDir(virtualDir, paths) {
    const realPath = this.toRealPath(virtualDir);
    try {
      const entries = fs2.readdirSync(realPath);
      for (const entry of entries) {
        const virtualPath = virtualDir === "/" ? `/${entry}` : `${virtualDir}/${entry}`;
        paths.push(virtualPath);
        const entryRealPath = nodePath2.join(realPath, entry);
        const stat = fs2.statSync(entryRealPath);
        if (stat.isDirectory()) {
          this.scanDir(virtualPath, paths);
        }
      }
    } catch {
    }
  }
  async chmod(path, mode) {
    const realPath = this.toRealPath(path);
    try {
      await fs2.promises.chmod(realPath, mode);
    } catch (e) {
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
      await fs2.promises.symlink(target, realLinkPath);
    } catch (e) {
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
      await fs2.promises.link(realExisting, realNew);
    } catch (e) {
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
      return await fs2.promises.readlink(realPath);
    } catch (e) {
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
      const resolved = await fs2.promises.realpath(realPath);
      if (resolved.startsWith(this.root)) {
        const relative = resolved.slice(this.root.length);
        return relative || "/";
      }
      return resolved;
    } catch (e) {
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
      await fs2.promises.utimes(realPath, atime, mtime);
    } catch (e) {
      const err = e;
      if (err.code === "ENOENT") {
        throw new Error(`ENOENT: no such file or directory, utimes '${path}'`);
      }
      throw e;
    }
  }
};

// dist/sandbox/Command.js
var Command = class {
  static {
    __name(this, "Command");
  }
  cmdId;
  cwd;
  startedAt;
  exitCode;
  bashEnv;
  cmdLine;
  env;
  explicitCwd;
  resultPromise;
  constructor(bashEnv, cmdLine, cwd, env, explicitCwd = false) {
    this.cmdId = crypto.randomUUID();
    this.cwd = cwd;
    this.startedAt = /* @__PURE__ */ new Date();
    this.bashEnv = bashEnv;
    this.cmdLine = cmdLine;
    this.env = env;
    this.explicitCwd = explicitCwd;
    this.resultPromise = this.execute();
  }
  async execute() {
    const options = this.env || this.explicitCwd ? { cwd: this.explicitCwd ? this.cwd : void 0, env: this.env } : void 0;
    const result2 = await this.bashEnv.exec(this.cmdLine, options);
    this.exitCode = result2.exitCode;
    return result2;
  }
  async *logs() {
    const result2 = await this.resultPromise;
    if (result2.stdout) {
      yield { type: "stdout", data: result2.stdout, timestamp: /* @__PURE__ */ new Date() };
    }
    if (result2.stderr) {
      yield { type: "stderr", data: result2.stderr, timestamp: /* @__PURE__ */ new Date() };
    }
  }
  async wait() {
    await this.resultPromise;
    return this;
  }
  async output() {
    const result2 = await this.resultPromise;
    return result2.stdout + result2.stderr;
  }
  async stdout() {
    const result2 = await this.resultPromise;
    return result2.stdout;
  }
  async stderr() {
    const result2 = await this.resultPromise;
    return result2.stderr;
  }
  async kill() {
  }
};

// dist/sandbox/Sandbox.js
var Sandbox = class _Sandbox {
  static {
    __name(this, "Sandbox");
  }
  bashEnv;
  constructor(bashEnv) {
    this.bashEnv = bashEnv;
  }
  static async create(opts) {
    let fs3 = opts?.fs;
    if (opts?.overlayRoot) {
      if (opts?.fs) {
        throw new Error("Cannot specify both 'fs' and 'overlayRoot' options");
      }
      fs3 = new OverlayFs({ root: opts.overlayRoot });
    }
    const bashEnv = new Bash({
      env: opts?.env,
      cwd: opts?.cwd,
      // Bash-specific extensions
      fs: fs3,
      maxCallDepth: opts?.maxCallDepth,
      maxCommandCount: opts?.maxCommandCount,
      maxLoopIterations: opts?.maxLoopIterations,
      network: opts?.network
    });
    return new _Sandbox(bashEnv);
  }
  async runCommand(cmd, opts) {
    const cwd = opts?.cwd ?? this.bashEnv.getCwd();
    const explicitCwd = opts?.cwd !== void 0;
    return new Command(this.bashEnv, cmd, cwd, opts?.env, explicitCwd);
  }
  async writeFiles(files) {
    for (const [path, content] of Object.entries(files)) {
      let data;
      if (typeof content === "string") {
        data = content;
      } else {
        if (content.encoding === "base64") {
          data = Buffer.from(content.content, "base64").toString("utf-8");
        } else {
          data = content.content;
        }
      }
      const parentDir = path.substring(0, path.lastIndexOf("/")) || "/";
      if (parentDir !== "/") {
        await this.bashEnv.exec(`mkdir -p ${parentDir}`);
      }
      await this.bashEnv.writeFile(path, data);
    }
  }
  async readFile(path, encoding) {
    const content = await this.bashEnv.readFile(path);
    if (encoding === "base64") {
      return Buffer.from(content).toString("base64");
    }
    return content;
  }
  async mkDir(path, opts) {
    const flags = opts?.recursive ? "-p" : "";
    await this.bashEnv.exec(`mkdir ${flags} ${path}`);
  }
  async stop() {
  }
  async extendTimeout(_ms) {
  }
  get domain() {
    return void 0;
  }
  /**
   * Bash-specific: Get the underlying Bash instance for advanced operations.
   * Not available in Vercel Sandbox API.
   */
  get bashEnvInstance() {
    return this.bashEnv;
  }
};
export {
  Bash,
  InMemoryFs,
  MountableFs,
  NetworkAccessDeniedError,
  OverlayFs,
  ReadWriteFs,
  RedirectNotAllowedError,
  Sandbox,
  Command as SandboxCommand,
  TooManyRedirectsError,
  WORKFLOW_DESERIALIZE,
  WORKFLOW_SERIALIZE,
  defineCommand,
  getCommandNames,
  getNetworkCommandNames
};
