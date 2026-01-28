var _a, _b, _c;
import { b as buildRegex, s as searchContent, c as convertReplacement } from "./chunk-FTAGPMQM.mjs";
import { h as hasHelpFlag, s as showHelp, u as unknownOption } from "./chunk-HAN5425M.mjs";
import { _ as __name } from "../index.mjs";
import { gunzipSync } from "node:zlib";
import "./_libs/@vercel/functions.mjs";
import "../_libs/srvx.mjs";
import "node:http";
import "node:stream";
import "node:https";
import "node:http2";
import "../_libs/h3.mjs";
import "../_libs/rou3.mjs";
import "../_libs/ms.mjs";
import "./_libs/@mongodb-js/zstd.mjs";
import "util";
import "util/types";
import "../_libs/ulid.mjs";
import "node:crypto";
import "node:module";
import "node:path";
import "node:child_process";
import "node:fs/promises";
import "node:util";
import "node:url";
import "node:timers/promises";
import "./_libs/@vercel/queue.mjs";
import "../_libs/mixpart.mjs";
import "./_libs/@vercel/oidc.mjs";
import "path";
import "fs";
import "os";
import "./_libs/async-sema.mjs";
import "events";
import "./_libs/undici.mjs";
import "node:assert";
import "node:net";
import "node:buffer";
import "node:querystring";
import "node:events";
import "node:diagnostics_channel";
import "node:tls";
import "node:perf_hooks";
import "node:util/types";
import "node:worker_threads";
import "node:async_hooks";
import "node:console";
import "node:dns";
import "string_decoder";
import "../_libs/zod.mjs";
import "node:fs";
import "node:os";
import "../_libs/cbor-x.mjs";
import "../_libs/devalue.mjs";
import "./_libs/debug.mjs";
import "tty";
import "../_libs/supports-color.mjs";
import "../_libs/has-flag.mjs";
import "./_libs/@jridgewell/trace-mapping.mjs";
import "./_libs/@jridgewell/sourcemap-codec.mjs";
import "./_libs/@jridgewell/resolve-uri.mjs";
import "node:vm";
import "../_libs/nanoid.mjs";
import "../_libs/seedrandom.mjs";
import "../_libs/ufo.mjs";
var FILE_TYPES = {
  // Web languages
  js: { extensions: [".js", ".mjs", ".cjs", ".jsx"], globs: [] },
  ts: { extensions: [".ts", ".tsx", ".mts", ".cts"], globs: [] },
  html: { extensions: [".html", ".htm", ".xhtml"], globs: [] },
  css: { extensions: [".css", ".scss", ".sass", ".less"], globs: [] },
  json: { extensions: [".json", ".jsonc", ".json5"], globs: [] },
  xml: { extensions: [".xml", ".xsl", ".xslt"], globs: [] },
  // Systems languages
  c: { extensions: [".c", ".h"], globs: [] },
  cpp: {
    extensions: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx", ".h"],
    globs: []
  },
  rust: { extensions: [".rs"], globs: [] },
  go: { extensions: [".go"], globs: [] },
  zig: { extensions: [".zig"], globs: [] },
  // JVM languages
  java: { extensions: [".java"], globs: [] },
  kotlin: { extensions: [".kt", ".kts"], globs: [] },
  scala: { extensions: [".scala", ".sc"], globs: [] },
  clojure: { extensions: [".clj", ".cljc", ".cljs", ".edn"], globs: [] },
  // Scripting languages
  py: { extensions: [".py", ".pyi", ".pyw"], globs: [] },
  rb: {
    extensions: [".rb", ".rake", ".gemspec"],
    globs: ["Rakefile", "Gemfile"]
  },
  php: { extensions: [".php", ".phtml", ".php3", ".php4", ".php5"], globs: [] },
  perl: { extensions: [".pl", ".pm", ".pod", ".t"], globs: [] },
  lua: { extensions: [".lua"], globs: [] },
  // Shell
  sh: {
    extensions: [".sh", ".bash", ".zsh", ".fish"],
    globs: [".bashrc", ".zshrc", ".profile"]
  },
  bat: { extensions: [".bat", ".cmd"], globs: [] },
  ps: { extensions: [".ps1", ".psm1", ".psd1"], globs: [] },
  // Data/Config
  yaml: { extensions: [".yaml", ".yml"], globs: [] },
  toml: { extensions: [".toml"], globs: ["Cargo.toml", "pyproject.toml"] },
  ini: { extensions: [".ini", ".cfg", ".conf"], globs: [] },
  csv: { extensions: [".csv", ".tsv"], globs: [] },
  // Documentation
  md: { extensions: [".md", ".mdx", ".markdown", ".mdown", ".mkd"], globs: [] },
  markdown: {
    extensions: [".md", ".mdx", ".markdown", ".mdown", ".mkd"],
    globs: []
  },
  rst: { extensions: [".rst"], globs: [] },
  txt: { extensions: [".txt", ".text"], globs: [] },
  tex: { extensions: [".tex", ".ltx", ".sty", ".cls"], globs: [] },
  // Other
  sql: { extensions: [".sql"], globs: [] },
  graphql: { extensions: [".graphql", ".gql"], globs: [] },
  proto: { extensions: [".proto"], globs: [] },
  make: {
    extensions: [".mk", ".mak"],
    globs: ["Makefile", "GNUmakefile", "makefile"]
  },
  docker: {
    extensions: [],
    globs: ["Dockerfile", "Dockerfile.*", "*.dockerfile"]
  },
  tf: { extensions: [".tf", ".tfvars"], globs: [] }
};
var FileTypeRegistry = (_a = class {
  types;
  constructor() {
    this.types = new Map(Object.entries(FILE_TYPES).map(([name, type]) => [
      name,
      { extensions: [...type.extensions], globs: [...type.globs] }
    ]));
  }
  /**
   * Add a type definition
   * Format: "name:pattern" where pattern can be:
   * - "*.ext" - glob pattern
   * - "include:other" - include patterns from another type
   */
  addType(spec) {
    const colonIdx = spec.indexOf(":");
    if (colonIdx === -1)
      return;
    const name = spec.slice(0, colonIdx);
    const pattern = spec.slice(colonIdx + 1);
    if (pattern.startsWith("include:")) {
      const otherName = pattern.slice(8);
      const other = this.types.get(otherName);
      if (other) {
        const existing = this.types.get(name) || { extensions: [], globs: [] };
        existing.extensions.push(...other.extensions);
        existing.globs.push(...other.globs);
        this.types.set(name, existing);
      }
    } else {
      const existing = this.types.get(name) || { extensions: [], globs: [] };
      if (pattern.startsWith("*.") && !pattern.slice(2).includes("*")) {
        const ext = pattern.slice(1);
        if (!existing.extensions.includes(ext)) {
          existing.extensions.push(ext);
        }
      } else {
        if (!existing.globs.includes(pattern)) {
          existing.globs.push(pattern);
        }
      }
      this.types.set(name, existing);
    }
  }
  /**
   * Clear all patterns from a type
   */
  clearType(name) {
    const existing = this.types.get(name);
    if (existing) {
      existing.extensions = [];
      existing.globs = [];
    }
  }
  /**
   * Get a type by name
   */
  getType(name) {
    return this.types.get(name);
  }
  /**
   * Get all type names
   */
  getAllTypes() {
    return this.types;
  }
  /**
   * Check if a filename matches any of the specified types
   */
  matchesType(filename, typeNames) {
    const lowerFilename = filename.toLowerCase();
    for (const typeName of typeNames) {
      if (typeName === "all") {
        if (this.matchesAnyType(filename)) {
          return true;
        }
        continue;
      }
      const fileType = this.types.get(typeName);
      if (!fileType)
        continue;
      for (const ext of fileType.extensions) {
        if (lowerFilename.endsWith(ext)) {
          return true;
        }
      }
      for (const glob of fileType.globs) {
        if (glob.includes("*")) {
          const pattern = glob.replace(/\./g, "\\.").replace(/\*/g, ".*");
          if (new RegExp(`^${pattern}$`, "i").test(filename)) {
            return true;
          }
        } else if (lowerFilename === glob.toLowerCase()) {
          return true;
        }
      }
    }
    return false;
  }
  /**
   * Check if a filename matches any recognized type
   */
  matchesAnyType(filename) {
    const lowerFilename = filename.toLowerCase();
    for (const fileType of this.types.values()) {
      for (const ext of fileType.extensions) {
        if (lowerFilename.endsWith(ext)) {
          return true;
        }
      }
      for (const glob of fileType.globs) {
        if (glob.includes("*")) {
          const pattern = glob.replace(/\./g, "\\.").replace(/\*/g, ".*");
          if (new RegExp(`^${pattern}$`, "i").test(filename)) {
            return true;
          }
        } else if (lowerFilename === glob.toLowerCase()) {
          return true;
        }
      }
    }
    return false;
  }
}, __name(_a, "FileTypeRegistry"), _a);
function formatTypeList() {
  const lines = [];
  for (const [name, type] of Object.entries(FILE_TYPES).sort()) {
    const patterns = [];
    for (const ext of type.extensions) {
      patterns.push(`*${ext}`);
    }
    for (const glob of type.globs) {
      patterns.push(glob);
    }
    lines.push(`${name}: ${patterns.join(", ")}`);
  }
  return `${lines.join("\n")}
`;
}
__name(formatTypeList, "formatTypeList");
function createDefaultOptions() {
  return {
    ignoreCase: false,
    caseSensitive: false,
    smartCase: true,
    fixedStrings: false,
    wordRegexp: false,
    lineRegexp: false,
    invertMatch: false,
    multiline: false,
    multilineDotall: false,
    patterns: [],
    patternFiles: [],
    count: false,
    countMatches: false,
    files: false,
    filesWithMatches: false,
    filesWithoutMatch: false,
    stats: false,
    onlyMatching: false,
    maxCount: 0,
    lineNumber: true,
    noFilename: false,
    withFilename: false,
    nullSeparator: false,
    byteOffset: false,
    column: false,
    vimgrep: false,
    replace: null,
    afterContext: 0,
    beforeContext: 0,
    contextSeparator: "--",
    quiet: false,
    heading: false,
    passthru: false,
    includeZero: false,
    sort: "path",
    json: false,
    globs: [],
    iglobs: [],
    globCaseInsensitive: false,
    types: [],
    typesNot: [],
    typeAdd: [],
    typeClear: [],
    hidden: false,
    noIgnore: false,
    noIgnoreDot: false,
    noIgnoreVcs: false,
    ignoreFiles: [],
    maxDepth: Infinity,
    maxFilesize: 0,
    followSymlinks: false,
    searchZip: false,
    searchBinary: false,
    preprocessor: null,
    preprocessorGlobs: []
  };
}
__name(createDefaultOptions, "createDefaultOptions");
function parseFilesize(value) {
  const match = value.match(/^(\d+)([KMG])?$/i);
  if (!match) {
    return 0;
  }
  const num = parseInt(match[1], 10);
  const suffix = (match[2] || "").toUpperCase();
  switch (suffix) {
    case "K":
      return num * 1024;
    case "M":
      return num * 1024 * 1024;
    case "G":
      return num * 1024 * 1024 * 1024;
    default:
      return num;
  }
}
__name(parseFilesize, "parseFilesize");
function validateFilesize(value) {
  if (!/^\d+[KMG]?$/i.test(value)) {
    return {
      stdout: "",
      stderr: `rg: invalid --max-filesize value: ${value}
`,
      exitCode: 1
    };
  }
  return null;
}
__name(validateFilesize, "validateFilesize");
function validateType(_typeName) {
  return null;
}
__name(validateType, "validateType");
var VALUE_OPTS = [
  { short: "g", long: "glob", target: "globs", multi: true },
  { long: "iglob", target: "iglobs", multi: true },
  {
    short: "t",
    long: "type",
    target: "types",
    multi: true,
    validate: validateType
  },
  {
    short: "T",
    long: "type-not",
    target: "typesNot",
    multi: true,
    validate: validateType
  },
  { long: "type-add", target: "typeAdd", multi: true },
  { long: "type-clear", target: "typeClear", multi: true },
  { short: "m", long: "max-count", target: "maxCount", parse: parseInt },
  { short: "e", long: "regexp", target: "patterns", multi: true },
  { short: "f", long: "file", target: "patternFiles", multi: true },
  { short: "r", long: "replace", target: "replace" },
  { short: "d", long: "max-depth", target: "maxDepth", parse: parseInt },
  {
    long: "max-filesize",
    target: "maxFilesize",
    parse: parseFilesize,
    validate: validateFilesize
  },
  { long: "context-separator", target: "contextSeparator" },
  // Thread count (no-op in single-threaded environment, but accept the option)
  { short: "j", long: "threads", target: "maxDepth", parse: /* @__PURE__ */ __name(() => Infinity, "parse") },
  // Use maxDepth as dummy target (value ignored)
  // Custom ignore file
  { long: "ignore-file", target: "ignoreFiles", multi: true },
  // Preprocessing
  { long: "pre", target: "preprocessor" },
  { long: "pre-glob", target: "preprocessorGlobs", multi: true }
];
var BOOL_FLAGS = {
  // Case sensitivity
  i: /* @__PURE__ */ __name((o) => {
    o.ignoreCase = true;
    o.caseSensitive = false;
    o.smartCase = false;
  }, "i"),
  "--ignore-case": /* @__PURE__ */ __name((o) => {
    o.ignoreCase = true;
    o.caseSensitive = false;
    o.smartCase = false;
  }, "--ignore-case"),
  s: /* @__PURE__ */ __name((o) => {
    o.caseSensitive = true;
    o.ignoreCase = false;
    o.smartCase = false;
  }, "s"),
  "--case-sensitive": /* @__PURE__ */ __name((o) => {
    o.caseSensitive = true;
    o.ignoreCase = false;
    o.smartCase = false;
  }, "--case-sensitive"),
  S: /* @__PURE__ */ __name((o) => {
    o.smartCase = true;
    o.ignoreCase = false;
    o.caseSensitive = false;
  }, "S"),
  "--smart-case": /* @__PURE__ */ __name((o) => {
    o.smartCase = true;
    o.ignoreCase = false;
    o.caseSensitive = false;
  }, "--smart-case"),
  // Pattern matching
  F: /* @__PURE__ */ __name((o) => {
    o.fixedStrings = true;
  }, "F"),
  "--fixed-strings": /* @__PURE__ */ __name((o) => {
    o.fixedStrings = true;
  }, "--fixed-strings"),
  w: /* @__PURE__ */ __name((o) => {
    o.wordRegexp = true;
  }, "w"),
  "--word-regexp": /* @__PURE__ */ __name((o) => {
    o.wordRegexp = true;
  }, "--word-regexp"),
  x: /* @__PURE__ */ __name((o) => {
    o.lineRegexp = true;
  }, "x"),
  "--line-regexp": /* @__PURE__ */ __name((o) => {
    o.lineRegexp = true;
  }, "--line-regexp"),
  v: /* @__PURE__ */ __name((o) => {
    o.invertMatch = true;
  }, "v"),
  "--invert-match": /* @__PURE__ */ __name((o) => {
    o.invertMatch = true;
  }, "--invert-match"),
  U: /* @__PURE__ */ __name((o) => {
    o.multiline = true;
  }, "U"),
  "--multiline": /* @__PURE__ */ __name((o) => {
    o.multiline = true;
  }, "--multiline"),
  "--multiline-dotall": /* @__PURE__ */ __name((o) => {
    o.multilineDotall = true;
    o.multiline = true;
  }, "--multiline-dotall"),
  // Output modes
  c: /* @__PURE__ */ __name((o) => {
    o.count = true;
  }, "c"),
  "--count": /* @__PURE__ */ __name((o) => {
    o.count = true;
  }, "--count"),
  "--count-matches": /* @__PURE__ */ __name((o) => {
    o.countMatches = true;
  }, "--count-matches"),
  l: /* @__PURE__ */ __name((o) => {
    o.filesWithMatches = true;
  }, "l"),
  "--files": /* @__PURE__ */ __name((o) => {
    o.files = true;
  }, "--files"),
  "--files-with-matches": /* @__PURE__ */ __name((o) => {
    o.filesWithMatches = true;
  }, "--files-with-matches"),
  "--files-without-match": /* @__PURE__ */ __name((o) => {
    o.filesWithoutMatch = true;
  }, "--files-without-match"),
  "--stats": /* @__PURE__ */ __name((o) => {
    o.stats = true;
  }, "--stats"),
  o: /* @__PURE__ */ __name((o) => {
    o.onlyMatching = true;
  }, "o"),
  "--only-matching": /* @__PURE__ */ __name((o) => {
    o.onlyMatching = true;
  }, "--only-matching"),
  q: /* @__PURE__ */ __name((o) => {
    o.quiet = true;
  }, "q"),
  "--quiet": /* @__PURE__ */ __name((o) => {
    o.quiet = true;
  }, "--quiet"),
  // Line numbers
  N: /* @__PURE__ */ __name((o) => {
    o.lineNumber = false;
  }, "N"),
  "--no-line-number": /* @__PURE__ */ __name((o) => {
    o.lineNumber = false;
  }, "--no-line-number"),
  // Filename display
  H: /* @__PURE__ */ __name((o) => {
    o.withFilename = true;
  }, "H"),
  "--with-filename": /* @__PURE__ */ __name((o) => {
    o.withFilename = true;
  }, "--with-filename"),
  I: /* @__PURE__ */ __name((o) => {
    o.noFilename = true;
  }, "I"),
  "--no-filename": /* @__PURE__ */ __name((o) => {
    o.noFilename = true;
  }, "--no-filename"),
  "0": /* @__PURE__ */ __name((o) => {
    o.nullSeparator = true;
  }, "0"),
  "--null": /* @__PURE__ */ __name((o) => {
    o.nullSeparator = true;
  }, "--null"),
  // Column and byte offset
  b: /* @__PURE__ */ __name((o) => {
    o.byteOffset = true;
  }, "b"),
  "--byte-offset": /* @__PURE__ */ __name((o) => {
    o.byteOffset = true;
  }, "--byte-offset"),
  "--column": /* @__PURE__ */ __name((o) => {
    o.column = true;
    o.lineNumber = true;
  }, "--column"),
  "--no-column": /* @__PURE__ */ __name((o) => {
    o.column = false;
  }, "--no-column"),
  "--vimgrep": /* @__PURE__ */ __name((o) => {
    o.vimgrep = true;
    o.column = true;
    o.lineNumber = true;
  }, "--vimgrep"),
  "--json": /* @__PURE__ */ __name((o) => {
    o.json = true;
  }, "--json"),
  // File selection
  "--hidden": /* @__PURE__ */ __name((o) => {
    o.hidden = true;
  }, "--hidden"),
  "--no-ignore": /* @__PURE__ */ __name((o) => {
    o.noIgnore = true;
  }, "--no-ignore"),
  "--no-ignore-dot": /* @__PURE__ */ __name((o) => {
    o.noIgnoreDot = true;
  }, "--no-ignore-dot"),
  "--no-ignore-vcs": /* @__PURE__ */ __name((o) => {
    o.noIgnoreVcs = true;
  }, "--no-ignore-vcs"),
  L: /* @__PURE__ */ __name((o) => {
    o.followSymlinks = true;
  }, "L"),
  "--follow": /* @__PURE__ */ __name((o) => {
    o.followSymlinks = true;
  }, "--follow"),
  z: /* @__PURE__ */ __name((o) => {
    o.searchZip = true;
  }, "z"),
  "--search-zip": /* @__PURE__ */ __name((o) => {
    o.searchZip = true;
  }, "--search-zip"),
  a: /* @__PURE__ */ __name((o) => {
    o.searchBinary = true;
  }, "a"),
  "--text": /* @__PURE__ */ __name((o) => {
    o.searchBinary = true;
  }, "--text"),
  // Output formatting
  "--heading": /* @__PURE__ */ __name((o) => {
    o.heading = true;
  }, "--heading"),
  "--passthru": /* @__PURE__ */ __name((o) => {
    o.passthru = true;
  }, "--passthru"),
  "--include-zero": /* @__PURE__ */ __name((o) => {
    o.includeZero = true;
  }, "--include-zero"),
  "--glob-case-insensitive": /* @__PURE__ */ __name((o) => {
    o.globCaseInsensitive = true;
  }, "--glob-case-insensitive")
};
var LINE_NUMBER_FLAGS = /* @__PURE__ */ new Set(["n", "--line-number"]);
function handleUnrestricted(options) {
  if (options.hidden) {
    options.searchBinary = true;
  } else if (options.noIgnore) {
    options.hidden = true;
  } else {
    options.noIgnore = true;
  }
}
__name(handleUnrestricted, "handleUnrestricted");
function tryParseValueOpt(args, i, options) {
  const arg = args[i];
  for (const def of VALUE_OPTS) {
    if (arg.startsWith(`--${def.long}=`)) {
      const value = arg.slice(`--${def.long}=`.length);
      const error = applyValueOpt(options, def, value);
      if (error)
        return { newIndex: i, error };
      return { newIndex: i };
    }
    if (def.short && arg.startsWith(`-${def.short}`) && arg.length > 2) {
      const value = arg.slice(2);
      const error = applyValueOpt(options, def, value);
      if (error)
        return { newIndex: i, error };
      return { newIndex: i };
    }
    if (def.short && arg === `-${def.short}` || arg === `--${def.long}`) {
      if (i + 1 >= args.length)
        return null;
      const value = args[i + 1];
      const error = applyValueOpt(options, def, value);
      if (error)
        return { newIndex: i + 1, error };
      return { newIndex: i + 1 };
    }
  }
  return null;
}
__name(tryParseValueOpt, "tryParseValueOpt");
function findValueOptByShort(shortFlag) {
  return VALUE_OPTS.find((def) => def.short === shortFlag);
}
__name(findValueOptByShort, "findValueOptByShort");
function applyValueOpt(options, def, value) {
  if (def.validate) {
    const error = def.validate(value);
    if (error)
      return error;
  }
  const parsed = def.parse ? def.parse(value) : value;
  if (def.multi) {
    options[def.target].push(parsed);
  } else {
    options[def.target] = parsed;
  }
  return void 0;
}
__name(applyValueOpt, "applyValueOpt");
function parseSort(args, i) {
  const arg = args[i];
  if (arg === "--sort" && i + 1 < args.length) {
    const val = args[i + 1];
    if (val === "path" || val === "none") {
      return { value: val, newIndex: i + 1 };
    }
  }
  if (arg.startsWith("--sort=")) {
    const val = arg.slice("--sort=".length);
    if (val === "path" || val === "none") {
      return { value: val, newIndex: i };
    }
  }
  return null;
}
__name(parseSort, "parseSort");
function parseContextFlag(args, i) {
  const arg = args[i];
  const attached = arg.match(/^-([ABC])(\d+)$/);
  if (attached) {
    return {
      flag: attached[1],
      value: parseInt(attached[2], 10),
      newIndex: i
    };
  }
  if ((arg === "-A" || arg === "-B" || arg === "-C") && i + 1 < args.length) {
    return {
      flag: arg[1],
      value: parseInt(args[i + 1], 10),
      newIndex: i + 1
    };
  }
  return null;
}
__name(parseContextFlag, "parseContextFlag");
function parseMaxCountAttached(arg) {
  const match = arg.match(/^-m(\d+)$/);
  return match ? parseInt(match[1], 10) : null;
}
__name(parseMaxCountAttached, "parseMaxCountAttached");
function parseArgs(args) {
  const options = createDefaultOptions();
  let positionalPattern = null;
  const paths = [];
  let explicitA = -1;
  let explicitB = -1;
  let explicitC = -1;
  let explicitLineNumbers = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("-") && arg !== "-") {
      const contextResult = parseContextFlag(args, i);
      if (contextResult) {
        const { flag, value, newIndex } = contextResult;
        if (flag === "A")
          explicitA = Math.max(explicitA, value);
        else if (flag === "B")
          explicitB = Math.max(explicitB, value);
        else
          explicitC = value;
        i = newIndex;
        continue;
      }
      const maxCountNum = parseMaxCountAttached(arg);
      if (maxCountNum !== null) {
        options.maxCount = maxCountNum;
        continue;
      }
      const valueResult = tryParseValueOpt(args, i, options);
      if (valueResult) {
        if (valueResult.error) {
          return { success: false, error: valueResult.error };
        }
        i = valueResult.newIndex;
        continue;
      }
      const sortResult = parseSort(args, i);
      if (sortResult) {
        options.sort = sortResult.value;
        i = sortResult.newIndex;
        continue;
      }
      const flags = arg.startsWith("--") ? [arg] : arg.slice(1).split("");
      for (const flag of flags) {
        if (LINE_NUMBER_FLAGS.has(flag)) {
          options.lineNumber = true;
          explicitLineNumbers = true;
          continue;
        }
        if (flag === "u" || flag === "--unrestricted") {
          handleUnrestricted(options);
          continue;
        }
        if (flag === "P" || flag === "--pcre2") {
          return {
            success: false,
            error: {
              stdout: "",
              stderr: "rg: PCRE2 is not supported. Use standard regex syntax instead.\n",
              exitCode: 1
            }
          };
        }
        if (flag.length === 1) {
          const valueDef = findValueOptByShort(flag);
          if (valueDef) {
            if (i + 1 >= args.length) {
              return { success: false, error: unknownOption("rg", `-${flag}`) };
            }
            const error = applyValueOpt(options, valueDef, args[i + 1]);
            if (error) {
              return { success: false, error };
            }
            i++;
            continue;
          }
        }
        const handler = BOOL_FLAGS[flag];
        if (handler) {
          handler(options);
          continue;
        }
        if (flag.startsWith("--")) {
          return { success: false, error: unknownOption("rg", flag) };
        }
        if (flag.length === 1) {
          return { success: false, error: unknownOption("rg", `-${flag}`) };
        }
      }
    } else if (positionalPattern === null && options.patterns.length === 0 && options.patternFiles.length === 0) {
      positionalPattern = arg;
    } else {
      paths.push(arg);
    }
  }
  if (explicitA >= 0 || explicitC >= 0) {
    options.afterContext = Math.max(explicitA >= 0 ? explicitA : 0, explicitC >= 0 ? explicitC : 0);
  }
  if (explicitB >= 0 || explicitC >= 0) {
    options.beforeContext = Math.max(explicitB >= 0 ? explicitB : 0, explicitC >= 0 ? explicitC : 0);
  }
  if (positionalPattern !== null) {
    options.patterns.push(positionalPattern);
  }
  if (options.column || options.vimgrep) {
    explicitLineNumbers = true;
  }
  return {
    success: true,
    options,
    paths,
    explicitLineNumbers
  };
}
__name(parseArgs, "parseArgs");
var GitignoreParser = (_b = class {
  patterns = [];
  basePath;
  constructor(basePath = "/") {
    this.basePath = basePath;
  }
  /**
   * Parse .gitignore content and add patterns
   */
  parse(content) {
    const lines = content.split("\n");
    for (const line of lines) {
      let trimmed = line.replace(/\s+$/, "");
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      let negated = false;
      if (trimmed.startsWith("!")) {
        negated = true;
        trimmed = trimmed.slice(1);
      }
      let directoryOnly = false;
      if (trimmed.endsWith("/")) {
        directoryOnly = true;
        trimmed = trimmed.slice(0, -1);
      }
      let rooted = false;
      if (trimmed.startsWith("/")) {
        rooted = true;
        trimmed = trimmed.slice(1);
      } else if (trimmed.includes("/") && !trimmed.startsWith("**/")) {
        rooted = true;
      }
      const regex = this.patternToRegex(trimmed, rooted);
      this.patterns.push({
        pattern: line,
        regex,
        negated,
        directoryOnly,
        rooted
      });
    }
  }
  /**
   * Convert a gitignore pattern to a regex
   */
  patternToRegex(pattern, rooted) {
    let regexStr = "";
    if (!rooted) {
      regexStr = "(?:^|/)";
    } else {
      regexStr = "^";
    }
    let i = 0;
    while (i < pattern.length) {
      const char = pattern[i];
      if (char === "*") {
        if (pattern[i + 1] === "*") {
          if (pattern[i + 2] === "/") {
            regexStr += "(?:.*/)?";
            i += 3;
          } else if (i + 2 >= pattern.length) {
            regexStr += ".*";
            i += 2;
          } else {
            regexStr += ".*";
            i += 2;
          }
        } else {
          regexStr += "[^/]*";
          i++;
        }
      } else if (char === "?") {
        regexStr += "[^/]";
        i++;
      } else if (char === "[") {
        let j = i + 1;
        if (j < pattern.length && pattern[j] === "!")
          j++;
        if (j < pattern.length && pattern[j] === "]")
          j++;
        while (j < pattern.length && pattern[j] !== "]")
          j++;
        if (j < pattern.length) {
          let charClass = pattern.slice(i, j + 1);
          if (charClass.startsWith("[!")) {
            charClass = `[^${charClass.slice(2)}`;
          }
          regexStr += charClass;
          i = j + 1;
        } else {
          regexStr += "\\[";
          i++;
        }
      } else if (char === "/") {
        regexStr += "/";
        i++;
      } else {
        regexStr += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        i++;
      }
    }
    regexStr += "(?:/.*)?$";
    return new RegExp(regexStr);
  }
  /**
   * Check if a path should be ignored
   *
   * @param relativePath Path relative to the gitignore location
   * @param isDirectory Whether the path is a directory
   * @returns true if the path should be ignored
   */
  matches(relativePath, isDirectory) {
    let path = relativePath.replace(/^\.\//, "");
    path = path.replace(/^\//, "");
    let ignored = false;
    for (const pattern of this.patterns) {
      if (pattern.directoryOnly && !isDirectory) {
        continue;
      }
      if (pattern.regex.test(path)) {
        ignored = !pattern.negated;
      }
    }
    return ignored;
  }
  /**
   * Check if a path is explicitly whitelisted by a negation pattern
   *
   * @param relativePath Path relative to the gitignore location
   * @param isDirectory Whether the path is a directory
   * @returns true if the path is whitelisted by a negation pattern
   */
  isWhitelisted(relativePath, isDirectory) {
    let path = relativePath.replace(/^\.\//, "");
    path = path.replace(/^\//, "");
    for (const pattern of this.patterns) {
      if (pattern.directoryOnly && !isDirectory) {
        continue;
      }
      if (pattern.negated && pattern.regex.test(path)) {
        return true;
      }
    }
    return false;
  }
  /**
   * Get the base path for this gitignore
   */
  getBasePath() {
    return this.basePath;
  }
}, __name(_b, "GitignoreParser"), _b);
var GitignoreManager = (_c = class {
  parsers = [];
  fs;
  skipDotIgnore;
  skipVcsIgnore;
  loadedDirs = /* @__PURE__ */ new Set();
  constructor(fs, _rootPath, skipDotIgnore = false, skipVcsIgnore = false) {
    this.fs = fs;
    this.skipDotIgnore = skipDotIgnore;
    this.skipVcsIgnore = skipVcsIgnore;
  }
  /**
   * Load all .gitignore and .ignore files from root to the specified path
   */
  async load(targetPath) {
    const dirs = [];
    let current = targetPath;
    while (true) {
      dirs.unshift(current);
      const parent = this.fs.resolvePath(current, "..");
      if (parent === current)
        break;
      current = parent;
    }
    const ignoreFiles = [];
    if (!this.skipVcsIgnore) {
      ignoreFiles.push(".gitignore");
    }
    if (!this.skipDotIgnore) {
      ignoreFiles.push(".rgignore", ".ignore");
    }
    for (const dir of dirs) {
      this.loadedDirs.add(dir);
      for (const filename of ignoreFiles) {
        const ignorePath = this.fs.resolvePath(dir, filename);
        try {
          const content = await this.fs.readFile(ignorePath);
          const parser = new GitignoreParser(dir);
          parser.parse(content);
          this.parsers.push(parser);
        } catch {
        }
      }
    }
  }
  /**
   * Load ignore files for a directory during traversal.
   * Only loads if the directory hasn't been loaded before.
   */
  async loadForDirectory(dir) {
    if (this.loadedDirs.has(dir))
      return;
    this.loadedDirs.add(dir);
    const ignoreFiles = [];
    if (!this.skipVcsIgnore) {
      ignoreFiles.push(".gitignore");
    }
    if (!this.skipDotIgnore) {
      ignoreFiles.push(".rgignore", ".ignore");
    }
    for (const filename of ignoreFiles) {
      const ignorePath = this.fs.resolvePath(dir, filename);
      try {
        const content = await this.fs.readFile(ignorePath);
        const parser = new GitignoreParser(dir);
        parser.parse(content);
        this.parsers.push(parser);
      } catch {
      }
    }
  }
  /**
   * Add patterns from raw content at the specified base path.
   * Used for --ignore-file flag.
   */
  addPatternsFromContent(content, basePath) {
    const parser = new GitignoreParser(basePath);
    parser.parse(content);
    this.parsers.push(parser);
  }
  /**
   * Check if a path should be ignored
   *
   * @param absolutePath Absolute path to check
   * @param isDirectory Whether the path is a directory
   * @returns true if the path should be ignored
   */
  matches(absolutePath, isDirectory) {
    for (const parser of this.parsers) {
      const basePath = parser.getBasePath();
      if (!absolutePath.startsWith(basePath))
        continue;
      const relativePath = absolutePath.slice(basePath.length).replace(/^\//, "");
      if (parser.matches(relativePath, isDirectory)) {
        return true;
      }
    }
    return false;
  }
  /**
   * Check if a path is explicitly whitelisted by a negation pattern.
   * Used to include hidden files that have negation patterns like "!.foo"
   *
   * @param absolutePath Absolute path to check
   * @param isDirectory Whether the path is a directory
   * @returns true if the path is whitelisted by a negation pattern
   */
  isWhitelisted(absolutePath, isDirectory) {
    for (const parser of this.parsers) {
      const basePath = parser.getBasePath();
      if (!absolutePath.startsWith(basePath))
        continue;
      const relativePath = absolutePath.slice(basePath.length).replace(/^\//, "");
      if (parser.isWhitelisted(relativePath, isDirectory)) {
        return true;
      }
    }
    return false;
  }
  /**
   * Quick check for common ignored directories
   * Used for early pruning during traversal
   */
  static isCommonIgnored(name) {
    const common = /* @__PURE__ */ new Set([
      "node_modules",
      ".git",
      ".svn",
      ".hg",
      "__pycache__",
      ".pytest_cache",
      ".mypy_cache",
      "venv",
      ".venv",
      ".next",
      ".nuxt",
      ".cargo"
    ]);
    return common.has(name);
  }
}, __name(_c, "GitignoreManager"), _c);
async function loadGitignores(fs, startPath, skipDotIgnore = false, skipVcsIgnore = false, customIgnoreFiles = []) {
  const manager = new GitignoreManager(fs, startPath, skipDotIgnore, skipVcsIgnore);
  await manager.load(startPath);
  for (const ignoreFile of customIgnoreFiles) {
    try {
      const absolutePath = fs.resolvePath(startPath, ignoreFile);
      const content = await fs.readFile(absolutePath);
      manager.addPatternsFromContent(content, startPath);
    } catch {
    }
  }
  return manager;
}
__name(loadGitignores, "loadGitignores");
function isGzip(data) {
  return data.length >= 2 && data[0] === 31 && data[1] === 139;
}
__name(isGzip, "isGzip");
function validateGlob(glob) {
  let inClass = false;
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "[" && !inClass) {
      inClass = true;
    } else if (char === "]" && inClass) {
      inClass = false;
    }
  }
  if (inClass) {
    return `rg: glob '${glob}' has an unclosed character class`;
  }
  return null;
}
__name(validateGlob, "validateGlob");
async function executeSearch(searchCtx) {
  const { ctx, options, paths: inputPaths, explicitLineNumbers } = searchCtx;
  for (const glob of options.globs) {
    const globToValidate = glob.startsWith("!") ? glob.slice(1) : glob;
    const error = validateGlob(globToValidate);
    if (error) {
      return { stdout: "", stderr: `${error}
`, exitCode: 1 };
    }
  }
  if (options.files) {
    const filesPaths = [...options.patterns, ...inputPaths];
    return listFiles(ctx, filesPaths, options);
  }
  const patterns = [...options.patterns];
  for (const patternFile of options.patternFiles) {
    try {
      let content;
      if (patternFile === "-") {
        content = ctx.stdin;
      } else {
        const filePath = ctx.fs.resolvePath(ctx.cwd, patternFile);
        content = await ctx.fs.readFile(filePath);
      }
      const filePatterns = content.split("\n").filter((line) => line.length > 0);
      patterns.push(...filePatterns);
    } catch {
      return {
        stdout: "",
        stderr: `rg: ${patternFile}: No such file or directory
`,
        exitCode: 2
      };
    }
  }
  if (patterns.length === 0) {
    if (options.patternFiles.length > 0) {
      return { stdout: "", stderr: "", exitCode: 1 };
    }
    return {
      stdout: "",
      stderr: "rg: no pattern given\n",
      exitCode: 2
    };
  }
  const paths = inputPaths.length === 0 ? ["."] : inputPaths;
  const effectiveIgnoreCase = determineIgnoreCase(options, patterns);
  let regex;
  let kResetGroup;
  try {
    const regexResult = buildSearchRegex(patterns, options, effectiveIgnoreCase);
    regex = regexResult.regex;
    kResetGroup = regexResult.kResetGroup;
  } catch {
    return {
      stdout: "",
      stderr: `rg: invalid regex: ${patterns.join(", ")}
`,
      exitCode: 2
    };
  }
  let gitignore = null;
  if (!options.noIgnore) {
    gitignore = await loadGitignores(ctx.fs, ctx.cwd, options.noIgnoreDot, options.noIgnoreVcs, options.ignoreFiles);
  }
  const typeRegistry = new FileTypeRegistry();
  for (const name of options.typeClear) {
    typeRegistry.clearType(name);
  }
  for (const spec of options.typeAdd) {
    typeRegistry.addType(spec);
  }
  const { files, singleExplicitFile } = await collectFiles(ctx, paths, options, gitignore, typeRegistry);
  if (files.length === 0) {
    return { stdout: "", stderr: "", exitCode: 1 };
  }
  const showFilename = !options.noFilename && (options.withFilename || !singleExplicitFile || files.length > 1);
  let effectiveLineNumbers = options.lineNumber;
  if (!explicitLineNumbers) {
    if (singleExplicitFile && files.length === 1) {
      effectiveLineNumbers = false;
    }
    if (options.onlyMatching) {
      effectiveLineNumbers = false;
    }
  }
  return searchFiles(ctx, files, regex, options, showFilename, effectiveLineNumbers, kResetGroup);
}
__name(executeSearch, "executeSearch");
function determineIgnoreCase(options, patterns) {
  if (options.caseSensitive) {
    return false;
  }
  if (options.ignoreCase) {
    return true;
  }
  if (options.smartCase) {
    return !patterns.some((p) => /[A-Z]/.test(p));
  }
  return false;
}
__name(determineIgnoreCase, "determineIgnoreCase");
function buildSearchRegex(patterns, options, ignoreCase) {
  let combinedPattern;
  if (patterns.length === 1) {
    combinedPattern = patterns[0];
  } else {
    combinedPattern = patterns.map((p) => options.fixedStrings ? p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : `(?:${p})`).join("|");
  }
  return buildRegex(combinedPattern, {
    mode: options.fixedStrings && patterns.length === 1 ? "fixed" : "perl",
    ignoreCase,
    wholeWord: options.wordRegexp,
    lineRegexp: options.lineRegexp,
    multiline: options.multiline,
    multilineDotall: options.multilineDotall
  });
}
__name(buildSearchRegex, "buildSearchRegex");
async function collectFiles(ctx, paths, options, gitignore, typeRegistry) {
  const files = [];
  let explicitFileCount = 0;
  let directoryCount = 0;
  for (const path of paths) {
    const fullPath = ctx.fs.resolvePath(ctx.cwd, path);
    try {
      const stat = await ctx.fs.stat(fullPath);
      if (stat.isFile) {
        explicitFileCount++;
        if (options.maxFilesize > 0 && stat.size > options.maxFilesize) {
          continue;
        }
        if (shouldIncludeFile(path, options, gitignore, fullPath, typeRegistry)) {
          files.push(path);
        }
      } else if (stat.isDirectory) {
        directoryCount++;
        await walkDirectory(ctx, path, fullPath, 0, options, gitignore, typeRegistry, files);
      }
    } catch {
    }
  }
  const sortedFiles = options.sort === "path" ? files.sort() : files;
  return {
    files: sortedFiles,
    singleExplicitFile: explicitFileCount === 1 && directoryCount === 0
  };
}
__name(collectFiles, "collectFiles");
async function walkDirectory(ctx, relativePath, absolutePath, depth, options, gitignore, typeRegistry, files) {
  if (depth >= options.maxDepth) {
    return;
  }
  if (gitignore) {
    await gitignore.loadForDirectory(absolutePath);
  }
  try {
    const entries = ctx.fs.readdirWithFileTypes ? await ctx.fs.readdirWithFileTypes(absolutePath) : (await ctx.fs.readdir(absolutePath)).map((name) => ({
      name,
      isFile: void 0
    }));
    for (const entry of entries) {
      const name = entry.name;
      if (!options.noIgnore && GitignoreManager.isCommonIgnored(name)) {
        continue;
      }
      const isHidden = name.startsWith(".");
      const entryRelativePath = relativePath === "." ? name : relativePath === "./" ? `./${name}` : relativePath.endsWith("/") ? `${relativePath}${name}` : `${relativePath}/${name}`;
      const entryAbsolutePath = ctx.fs.resolvePath(absolutePath, name);
      let isFile;
      let isDirectory;
      let isSymlink = false;
      const hasTypeInfo = entry.isFile !== void 0 && "isDirectory" in entry;
      if (hasTypeInfo) {
        const dirent = entry;
        isSymlink = dirent.isSymbolicLink === true;
        if (isSymlink && !options.followSymlinks) {
          continue;
        }
        if (isSymlink && options.followSymlinks) {
          try {
            const stat = await ctx.fs.stat(entryAbsolutePath);
            isFile = stat.isFile;
            isDirectory = stat.isDirectory;
          } catch {
            continue;
          }
        } else {
          isFile = dirent.isFile;
          isDirectory = dirent.isDirectory;
        }
      } else {
        try {
          const lstat = ctx.fs.lstat ? await ctx.fs.lstat(entryAbsolutePath) : await ctx.fs.stat(entryAbsolutePath);
          isSymlink = lstat.isSymbolicLink === true;
          if (isSymlink && !options.followSymlinks) {
            continue;
          }
          const stat = isSymlink && options.followSymlinks ? await ctx.fs.stat(entryAbsolutePath) : lstat;
          isFile = stat.isFile;
          isDirectory = stat.isDirectory;
        } catch {
          continue;
        }
      }
      const gitignoreIgnored = gitignore?.matches(entryAbsolutePath, isDirectory);
      if (gitignoreIgnored) {
        continue;
      }
      if (isHidden && !options.hidden) {
        const isWhitelisted = gitignore?.isWhitelisted(entryAbsolutePath, isDirectory);
        if (!isWhitelisted) {
          continue;
        }
      }
      if (isDirectory) {
        await walkDirectory(ctx, entryRelativePath, entryAbsolutePath, depth + 1, options, gitignore, typeRegistry, files);
      } else if (isFile) {
        if (options.maxFilesize > 0) {
          try {
            const fileStat = await ctx.fs.stat(entryAbsolutePath);
            if (fileStat.size > options.maxFilesize) {
              continue;
            }
          } catch {
            continue;
          }
        }
        if (shouldIncludeFile(entryRelativePath, options, gitignore, entryAbsolutePath, typeRegistry)) {
          files.push(entryRelativePath);
        }
      }
    }
  } catch {
  }
}
__name(walkDirectory, "walkDirectory");
function shouldIncludeFile(relativePath, options, gitignore, absolutePath, typeRegistry) {
  const filename = relativePath.split("/").pop() || relativePath;
  if (gitignore?.matches(absolutePath, false)) {
    return false;
  }
  if (options.types.length > 0 && !typeRegistry.matchesType(filename, options.types)) {
    return false;
  }
  if (options.typesNot.length > 0 && typeRegistry.matchesType(filename, options.typesNot)) {
    return false;
  }
  if (options.globs.length > 0) {
    const ignoreCase = options.globCaseInsensitive;
    const positiveGlobs = options.globs.filter((g) => !g.startsWith("!"));
    const negativeGlobs = options.globs.filter((g) => g.startsWith("!")).map((g) => g.slice(1));
    if (positiveGlobs.length > 0) {
      let matchesPositive = false;
      for (const glob of positiveGlobs) {
        if (matchGlob(filename, glob, ignoreCase) || matchGlob(relativePath, glob, ignoreCase)) {
          matchesPositive = true;
          break;
        }
      }
      if (!matchesPositive) {
        return false;
      }
    }
    for (const glob of negativeGlobs) {
      if (glob.startsWith("/")) {
        const rootedGlob = glob.slice(1);
        if (matchGlob(relativePath, rootedGlob, ignoreCase)) {
          return false;
        }
      } else if (matchGlob(filename, glob, ignoreCase) || matchGlob(relativePath, glob, ignoreCase)) {
        return false;
      }
    }
  }
  if (options.iglobs.length > 0) {
    const positiveIglobs = options.iglobs.filter((g) => !g.startsWith("!"));
    const negativeIglobs = options.iglobs.filter((g) => g.startsWith("!")).map((g) => g.slice(1));
    if (positiveIglobs.length > 0) {
      let matchesPositive = false;
      for (const glob of positiveIglobs) {
        if (matchGlob(filename, glob, true) || matchGlob(relativePath, glob, true)) {
          matchesPositive = true;
          break;
        }
      }
      if (!matchesPositive) {
        return false;
      }
    }
    for (const glob of negativeIglobs) {
      if (glob.startsWith("/")) {
        const rootedGlob = glob.slice(1);
        if (matchGlob(relativePath, rootedGlob, true)) {
          return false;
        }
      } else if (matchGlob(filename, glob, true) || matchGlob(relativePath, glob, true)) {
        return false;
      }
    }
  }
  return true;
}
__name(shouldIncludeFile, "shouldIncludeFile");
function matchGlob(str, pattern, ignoreCase = false) {
  let regexStr = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        regexStr += ".*";
        i++;
      } else {
        regexStr += "[^/]*";
      }
    } else if (char === "?") {
      regexStr += "[^/]";
    } else if (char === "[") {
      let j = i + 1;
      if (j < pattern.length && pattern[j] === "!")
        j++;
      if (j < pattern.length && pattern[j] === "]")
        j++;
      while (j < pattern.length && pattern[j] !== "]")
        j++;
      if (j < pattern.length) {
        let charClass = pattern.slice(i, j + 1);
        if (charClass.startsWith("[!")) {
          charClass = `[^${charClass.slice(2)}`;
        }
        regexStr += charClass;
        i = j;
      } else {
        regexStr += "\\[";
      }
    } else {
      regexStr += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  regexStr += "$";
  return new RegExp(regexStr, ignoreCase ? "i" : "").test(str);
}
__name(matchGlob, "matchGlob");
async function listFiles(ctx, inputPaths, options) {
  let gitignore = null;
  if (!options.noIgnore) {
    gitignore = await loadGitignores(ctx.fs, ctx.cwd, options.noIgnoreDot, options.noIgnoreVcs, options.ignoreFiles);
  }
  const typeRegistry = new FileTypeRegistry();
  for (const name of options.typeClear) {
    typeRegistry.clearType(name);
  }
  for (const spec of options.typeAdd) {
    typeRegistry.addType(spec);
  }
  const paths = inputPaths.length === 0 ? ["."] : inputPaths;
  const { files } = await collectFiles(ctx, paths, options, gitignore, typeRegistry);
  if (files.length === 0) {
    return { stdout: "", stderr: "", exitCode: 1 };
  }
  if (options.quiet) {
    return { stdout: "", stderr: "", exitCode: 0 };
  }
  const sep = options.nullSeparator ? "\0" : "\n";
  const stdout = files.map((f) => f + sep).join("");
  return { stdout, stderr: "", exitCode: 0 };
}
__name(listFiles, "listFiles");
function matchesPreGlob(filename, preGlobs) {
  if (preGlobs.length === 0)
    return true;
  for (const glob of preGlobs) {
    if (matchGlob(filename, glob, false)) {
      return true;
    }
  }
  return false;
}
__name(matchesPreGlob, "matchesPreGlob");
async function readFileContent(ctx, filePath, file, options) {
  try {
    if (options.preprocessor && ctx.exec) {
      const filename = file.split("/").pop() || file;
      if (matchesPreGlob(filename, options.preprocessorGlobs)) {
        const result = await ctx.exec(`${options.preprocessor} "${filePath}"`, {
          cwd: ctx.cwd
        });
        if (result.exitCode === 0 && result.stdout) {
          const sample2 = result.stdout.slice(0, 8192);
          return { content: result.stdout, isBinary: sample2.includes("\0") };
        }
      }
    }
    if (options.searchZip && file.endsWith(".gz")) {
      const buffer = await ctx.fs.readFileBuffer(filePath);
      if (isGzip(buffer)) {
        try {
          const decompressed = gunzipSync(buffer);
          const content2 = new TextDecoder().decode(decompressed);
          const sample2 = content2.slice(0, 8192);
          return { content: content2, isBinary: sample2.includes("\0") };
        } catch {
          return null;
        }
      }
    }
    const content = await ctx.fs.readFile(filePath);
    const sample = content.slice(0, 8192);
    return { content, isBinary: sample.includes("\0") };
  } catch {
    return null;
  }
}
__name(readFileContent, "readFileContent");
async function searchFiles(ctx, files, regex, options, showFilename, effectiveLineNumbers, kResetGroup) {
  let stdout = "";
  let anyMatch = false;
  const jsonMessages = [];
  let totalMatches = 0;
  let filesWithMatch = 0;
  let bytesSearched = 0;
  const BATCH_SIZE = 50;
  outer: for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(async (file) => {
      const filePath = ctx.fs.resolvePath(ctx.cwd, file);
      const fileData = await readFileContent(ctx, filePath, file, options);
      if (!fileData)
        return null;
      const { content, isBinary } = fileData;
      bytesSearched += content.length;
      if (isBinary && !options.searchBinary) {
        return null;
      }
      const filenameForSearch = showFilename && !options.heading ? file : "";
      const result = searchContent(content, regex, {
        invertMatch: options.invertMatch,
        showLineNumbers: effectiveLineNumbers,
        countOnly: options.count,
        countMatches: options.countMatches,
        filename: filenameForSearch,
        onlyMatching: options.onlyMatching,
        beforeContext: options.beforeContext,
        afterContext: options.afterContext,
        maxCount: options.maxCount,
        contextSeparator: options.contextSeparator,
        showColumn: options.column,
        vimgrep: options.vimgrep,
        showByteOffset: options.byteOffset,
        replace: options.replace !== null ? convertReplacement(options.replace) : null,
        passthru: options.passthru,
        multiline: options.multiline,
        kResetGroup
      });
      if (options.json && result.matched) {
        return { file, result, content, isBinary: false };
      }
      return { file, result };
    }));
    for (const res of results) {
      if (!res)
        continue;
      const { file, result } = res;
      if (result.matched) {
        anyMatch = true;
        filesWithMatch++;
        totalMatches += result.matchCount;
        if (options.quiet && !options.json) {
          break outer;
        }
        if (options.json && !options.quiet) {
          const content = res.content || "";
          jsonMessages.push(JSON.stringify({ type: "begin", data: { path: { text: file } } }));
          const lines = content.split("\n");
          regex.lastIndex = 0;
          let lineOffset = 0;
          for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
            const line = lines[lineIdx];
            regex.lastIndex = 0;
            const submatches = [];
            for (let match = regex.exec(line); match !== null; match = regex.exec(line)) {
              const submatch = {
                match: { text: match[0] },
                start: match.index,
                end: match.index + match[0].length
              };
              if (options.replace !== null) {
                submatch.replacement = { text: options.replace };
              }
              submatches.push(submatch);
              if (match[0].length === 0)
                regex.lastIndex++;
            }
            if (submatches.length > 0) {
              const matchMsg = {
                type: "match",
                data: {
                  path: { text: file },
                  lines: { text: `${line}
` },
                  line_number: lineIdx + 1,
                  absolute_offset: lineOffset,
                  submatches
                }
              };
              jsonMessages.push(JSON.stringify(matchMsg));
            }
            lineOffset += line.length + 1;
          }
          jsonMessages.push(JSON.stringify({
            type: "end",
            data: {
              path: { text: file },
              binary_offset: null,
              stats: {
                elapsed: { secs: 0, nanos: 0, human: "0s" },
                searches: 1,
                searches_with_match: 1,
                bytes_searched: content.length,
                bytes_printed: 0,
                matched_lines: result.matchCount,
                matches: result.matchCount
              }
            }
          }));
        } else if (options.filesWithMatches) {
          const sep = options.nullSeparator ? "\0" : "\n";
          stdout += `${file}${sep}`;
        } else if (!options.filesWithoutMatch) {
          if (options.heading && !options.noFilename) {
            stdout += `${file}
`;
          }
          stdout += result.output;
        }
      } else if (options.filesWithoutMatch) {
        const sep = options.nullSeparator ? "\0" : "\n";
        stdout += `${file}${sep}`;
      } else if (options.includeZero && (options.count || options.countMatches)) {
        stdout += result.output;
      }
    }
  }
  if (options.json) {
    jsonMessages.push(JSON.stringify({
      type: "summary",
      data: {
        elapsed_total: { secs: 0, nanos: 0, human: "0s" },
        stats: {
          elapsed: { secs: 0, nanos: 0, human: "0s" },
          searches: files.length,
          searches_with_match: filesWithMatch,
          bytes_searched: bytesSearched,
          bytes_printed: 0,
          matched_lines: totalMatches,
          matches: totalMatches
        }
      }
    }));
    stdout = `${jsonMessages.join("\n")}
`;
  }
  let finalStdout = options.quiet && !options.json ? "" : stdout;
  if (options.stats && !options.json) {
    const statsOutput = [
      "",
      `${totalMatches} matches`,
      `${totalMatches} matched lines`,
      `${filesWithMatch} files contained matches`,
      `${files.length} files searched`,
      `${bytesSearched} bytes searched`
    ].join("\n");
    finalStdout += `${statsOutput}
`;
  }
  let exitCode;
  if (options.filesWithoutMatch) {
    exitCode = stdout.length > 0 ? 0 : 1;
  } else {
    exitCode = anyMatch ? 0 : 1;
  }
  return {
    stdout: finalStdout,
    stderr: "",
    exitCode
  };
}
__name(searchFiles, "searchFiles");
var rgHelp = {
  name: "rg",
  summary: "recursively search for a pattern",
  usage: "rg [OPTIONS] PATTERN [PATH ...]",
  description: `rg (ripgrep) recursively searches directories for a regex pattern.
Unlike grep, rg is recursive by default and respects .gitignore files.

EXAMPLES:
  rg foo                    Search for 'foo' in current directory
  rg foo src/               Search in src/ directory
  rg -i foo                 Case-insensitive search
  rg -w foo                 Match whole words only
  rg -t js foo              Search only JavaScript files
  rg -g '*.ts' foo          Search files matching glob
  rg --hidden foo           Include hidden files
  rg -l foo                 List files with matches only`,
  options: [
    "-e, --regexp PATTERN    search for PATTERN (can be used multiple times)",
    "-f, --file FILE         read patterns from FILE, one per line",
    "-i, --ignore-case       case-insensitive search",
    "-s, --case-sensitive    case-sensitive search (overrides smart-case)",
    "-S, --smart-case        smart case (default: case-insensitive unless pattern has uppercase)",
    "-F, --fixed-strings     treat pattern as literal string",
    "-w, --word-regexp       match whole words only",
    "-x, --line-regexp       match whole lines only",
    "-v, --invert-match      select non-matching lines",
    "-r, --replace TEXT      replace matches with TEXT",
    "-c, --count             print count of matching lines per file",
    "    --count-matches     print count of individual matches per file",
    "-l, --files-with-matches print only file names with matches",
    "    --files-without-match print file names without matches",
    "    --files             list files that would be searched",
    "-o, --only-matching     print only matching parts",
    "-m, --max-count NUM     stop after NUM matches per file",
    "-q, --quiet             suppress output, exit 0 on match",
    "    --stats             print search statistics",
    "-n, --line-number       print line numbers (default: on)",
    "-N, --no-line-number    do not print line numbers",
    "-I, --no-filename       suppress the prefixing of file names",
    "-0, --null              use NUL as filename separator",
    "-b, --byte-offset       show byte offset of each match",
    "    --column            show column number of first match",
    "    --vimgrep           show results in vimgrep format",
    "    --json              show results in JSON Lines format",
    "-A NUM                  print NUM lines after each match",
    "-B NUM                  print NUM lines before each match",
    "-C NUM                  print NUM lines before and after each match",
    "    --context-separator SEP  separator for context groups (default: --)",
    "-U, --multiline         match patterns across lines",
    "-z, --search-zip        search in compressed files (gzip only)",
    "-g, --glob GLOB         include files matching GLOB",
    "-t, --type TYPE         only search files of TYPE (e.g., js, py, ts)",
    "-T, --type-not TYPE     exclude files of TYPE",
    "-L, --follow            follow symbolic links",
    "-u, --unrestricted      reduce filtering (-u: no ignore, -uu: +hidden, -uuu: +binary)",
    "-a, --text              search binary files as text",
    "    --hidden            search hidden files and directories",
    "    --no-ignore         don't respect .gitignore/.ignore files",
    "-d, --max-depth NUM     maximum search depth",
    "    --sort TYPE         sort files (path, none)",
    "    --heading           show file path above matches",
    "    --passthru          print all lines (non-matches use - separator)",
    "    --include-zero      include files with 0 matches in count output",
    "    --type-list         list all available file types",
    "    --help              display this help and exit"
  ]
};
var rgCommand = {
  name: "rg",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(rgHelp);
    }
    if (args.includes("--type-list")) {
      return {
        stdout: formatTypeList(),
        stderr: "",
        exitCode: 0
      };
    }
    const parseResult = parseArgs(args);
    if (!parseResult.success) {
      return parseResult.error;
    }
    return executeSearch({
      ctx,
      options: parseResult.options,
      paths: parseResult.paths,
      explicitLineNumbers: parseResult.explicitLineNumbers
    });
  }
};
export {
  rgCommand
};
