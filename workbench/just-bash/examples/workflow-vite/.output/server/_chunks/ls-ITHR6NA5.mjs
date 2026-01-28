import { D as DEFAULT_BATCH_SIZE, _ as __name } from "../index.mjs";
import { p as parseArgs } from "./chunk-5NTVBLMJ.mjs";
import { h as hasHelpFlag, s as showHelp } from "./chunk-HAN5425M.mjs";
import { m as minimatch } from "../_libs/minimatch.mjs";
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
import "node:zlib";
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
import "./_libs/@isaacs/brace-expansion.mjs";
import "./_libs/@isaacs/balanced-match.mjs";
function formatHumanSize(bytes) {
  if (bytes < 1024)
    return String(bytes);
  if (bytes < 1024 * 1024) {
    const k = bytes / 1024;
    return k < 10 ? `${k.toFixed(1)}K` : `${Math.round(k)}K`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    const m = bytes / (1024 * 1024);
    return m < 10 ? `${m.toFixed(1)}M` : `${Math.round(m)}M`;
  }
  const g = bytes / (1024 * 1024 * 1024);
  return g < 10 ? `${g.toFixed(1)}G` : `${Math.round(g)}G`;
}
__name(formatHumanSize, "formatHumanSize");
function formatDate(date) {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec"
  ];
  const month = months[date.getMonth()];
  const day = String(date.getDate()).padStart(2, " ");
  const now = /* @__PURE__ */ new Date();
  const sixMonthsAgo = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1e3);
  if (date > sixMonthsAgo) {
    const hours = String(date.getHours()).padStart(2, "0");
    const mins = String(date.getMinutes()).padStart(2, "0");
    return `${month} ${day} ${hours}:${mins}`;
  }
  const year = date.getFullYear();
  return `${month} ${day}  ${year}`;
}
__name(formatDate, "formatDate");
var lsHelp = {
  name: "ls",
  summary: "list directory contents",
  usage: "ls [OPTION]... [FILE]...",
  options: [
    "-a, --all            do not ignore entries starting with .",
    "-A, --almost-all     do not list . and ..",
    "-d, --directory      list directories themselves, not their contents",
    "-h, --human-readable with -l, print sizes like 1K 234M 2G etc.",
    "-l                   use a long listing format",
    "-r, --reverse        reverse order while sorting",
    "-R, --recursive      list subdirectories recursively",
    "-S                   sort by file size, largest first",
    "-t                   sort by time, newest first",
    "-1                   list one file per line",
    "    --help           display this help and exit"
  ]
};
var argDefs = {
  showAll: { short: "a", long: "all", type: "boolean" },
  showAlmostAll: { short: "A", long: "almost-all", type: "boolean" },
  longFormat: { short: "l", type: "boolean" },
  humanReadable: {
    short: "h",
    long: "human-readable",
    type: "boolean"
  },
  recursive: { short: "R", long: "recursive", type: "boolean" },
  reverse: { short: "r", long: "reverse", type: "boolean" },
  sortBySize: { short: "S", type: "boolean" },
  directoryOnly: { short: "d", long: "directory", type: "boolean" },
  sortByTime: { short: "t", type: "boolean" },
  onePerLine: { short: "1", type: "boolean" }
};
var lsCommand = {
  name: "ls",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(lsHelp);
    }
    const parsed = parseArgs("ls", args, argDefs);
    if (!parsed.ok)
      return parsed.error;
    const showAll = parsed.result.flags.showAll;
    const showAlmostAll = parsed.result.flags.showAlmostAll;
    const longFormat = parsed.result.flags.longFormat;
    const humanReadable = parsed.result.flags.humanReadable;
    const recursive = parsed.result.flags.recursive;
    const reverse = parsed.result.flags.reverse;
    const sortBySize = parsed.result.flags.sortBySize;
    const directoryOnly = parsed.result.flags.directoryOnly;
    parsed.result.flags.sortByTime;
    void parsed.result.flags.onePerLine;
    const paths = parsed.result.positional;
    if (paths.length === 0) {
      paths.push(".");
    }
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    for (let i = 0; i < paths.length; i++) {
      const path = paths[i];
      if (i > 0 && stdout && !stdout.endsWith("\n\n")) {
        stdout += "\n";
      }
      if (directoryOnly) {
        const fullPath = ctx.fs.resolvePath(ctx.cwd, path);
        try {
          const stat = await ctx.fs.stat(fullPath);
          if (longFormat) {
            const mode = stat.isDirectory ? "drwxr-xr-x" : "-rw-r--r--";
            const type = stat.isDirectory ? "/" : "";
            const size = stat.size ?? 0;
            const sizeStr = humanReadable ? formatHumanSize(size).padStart(5) : String(size).padStart(5);
            const mtime = stat.mtime ?? /* @__PURE__ */ new Date(0);
            const dateStr = formatDate(mtime);
            stdout += `${mode} 1 user user ${sizeStr} ${dateStr} ${path}${type}
`;
          } else {
            stdout += `${path}
`;
          }
        } catch {
          stderr += `ls: cannot access '${path}': No such file or directory
`;
          exitCode = 2;
        }
        continue;
      }
      if (path.includes("*") || path.includes("?") || path.includes("[")) {
        const result = await listGlob(path, ctx, showAll, showAlmostAll, longFormat, reverse, humanReadable, sortBySize);
        stdout += result.stdout;
        stderr += result.stderr;
        if (result.exitCode !== 0)
          exitCode = result.exitCode;
      } else {
        const result = await listPath(path, ctx, showAll, showAlmostAll, longFormat, recursive, paths.length > 1, reverse, humanReadable, sortBySize);
        stdout += result.stdout;
        stderr += result.stderr;
        if (result.exitCode !== 0)
          exitCode = result.exitCode;
      }
    }
    return { stdout, stderr, exitCode };
  }
};
async function listGlob(pattern, ctx, showAll, showAlmostAll, longFormat, reverse = false, humanReadable = false, sortBySize = false) {
  const showHidden = showAll || showAlmostAll;
  const allPaths = ctx.fs.getAllPaths();
  const basePath = ctx.fs.resolvePath(ctx.cwd, ".");
  const matches = [];
  for (const p of allPaths) {
    const relativePath = p.startsWith(basePath) ? p.slice(basePath.length + 1) || p : p;
    if (minimatch(relativePath, pattern) || minimatch(p, pattern)) {
      const basename = relativePath.split("/").pop() || relativePath;
      if (!showHidden && basename.startsWith(".")) {
        continue;
      }
      matches.push(relativePath || p);
    }
  }
  if (matches.length === 0) {
    return {
      stdout: "",
      stderr: `ls: ${pattern}: No such file or directory
`,
      exitCode: 2
    };
  }
  if (sortBySize) {
    const matchesWithSize = [];
    for (const match of matches) {
      const fullPath = ctx.fs.resolvePath(ctx.cwd, match);
      try {
        const stat = await ctx.fs.stat(fullPath);
        matchesWithSize.push({ path: match, size: stat.size ?? 0 });
      } catch {
        matchesWithSize.push({ path: match, size: 0 });
      }
    }
    matchesWithSize.sort((a, b) => b.size - a.size);
    matches.length = 0;
    matches.push(...matchesWithSize.map((m) => m.path));
  } else {
    matches.sort();
  }
  if (reverse) {
    matches.reverse();
  }
  if (longFormat) {
    const lines = [];
    for (const match of matches) {
      const fullPath = ctx.fs.resolvePath(ctx.cwd, match);
      try {
        const stat = await ctx.fs.stat(fullPath);
        const mode = stat.isDirectory ? "drwxr-xr-x" : "-rw-r--r--";
        const type = stat.isDirectory ? "/" : "";
        const size = stat.size ?? 0;
        const sizeStr = humanReadable ? formatHumanSize(size).padStart(5) : String(size).padStart(5);
        const mtime = stat.mtime ?? /* @__PURE__ */ new Date(0);
        const dateStr = formatDate(mtime);
        lines.push(`${mode} 1 user user ${sizeStr} ${dateStr} ${match}${type}`);
      } catch {
        lines.push(`-rw-r--r-- 1 user user     0 Jan  1 00:00 ${match}`);
      }
    }
    return { stdout: `${lines.join("\n")}
`, stderr: "", exitCode: 0 };
  }
  return { stdout: `${matches.join("\n")}
`, stderr: "", exitCode: 0 };
}
__name(listGlob, "listGlob");
async function listPath(path, ctx, showAll, showAlmostAll, longFormat, recursive, showHeader, reverse = false, humanReadable = false, sortBySize = false, _isSubdir = false) {
  const showHidden = showAll || showAlmostAll;
  const fullPath = ctx.fs.resolvePath(ctx.cwd, path);
  try {
    const stat = await ctx.fs.stat(fullPath);
    if (!stat.isDirectory) {
      if (longFormat) {
        const size = stat.size ?? 0;
        const sizeStr = humanReadable ? formatHumanSize(size).padStart(5) : String(size).padStart(5);
        const mtime = stat.mtime ?? /* @__PURE__ */ new Date(0);
        const dateStr = formatDate(mtime);
        return {
          stdout: `-rw-r--r-- 1 user user ${sizeStr} ${dateStr} ${path}
`,
          stderr: "",
          exitCode: 0
        };
      }
      return { stdout: `${path}
`, stderr: "", exitCode: 0 };
    }
    let entries = await ctx.fs.readdir(fullPath);
    if (!showHidden) {
      entries = entries.filter((e) => !e.startsWith("."));
    }
    if (sortBySize) {
      const entriesWithSize = [];
      for (const entry of entries) {
        const entryPath = fullPath === "/" ? `/${entry}` : `${fullPath}/${entry}`;
        try {
          const entryStat = await ctx.fs.stat(entryPath);
          entriesWithSize.push({ name: entry, size: entryStat.size ?? 0 });
        } catch {
          entriesWithSize.push({ name: entry, size: 0 });
        }
      }
      entriesWithSize.sort((a, b) => b.size - a.size);
      entries = entriesWithSize.map((e) => e.name);
    } else {
      entries.sort();
    }
    if (showAll) {
      entries = [".", "..", ...entries];
    }
    if (reverse) {
      entries.reverse();
    }
    let stdout = "";
    if (recursive || showHeader) {
      stdout += `${path}:
`;
    }
    if (longFormat) {
      stdout += `total ${entries.length}
`;
      const specialEntries = entries.filter((e) => e === "." || e === "..");
      const regularEntries = entries.filter((e) => e !== "." && e !== "..");
      for (const entry of specialEntries) {
        stdout += `drwxr-xr-x 1 user user     0 Jan  1 00:00 ${entry}
`;
      }
      const entryStats = [];
      for (let i = 0; i < regularEntries.length; i += DEFAULT_BATCH_SIZE) {
        const batch = regularEntries.slice(i, i + DEFAULT_BATCH_SIZE);
        const batchResults = await Promise.all(batch.map(async (entry) => {
          const entryPath = fullPath === "/" ? `/${entry}` : `${fullPath}/${entry}`;
          try {
            const entryStat = await ctx.fs.stat(entryPath);
            const mode = entryStat.isDirectory ? "drwxr-xr-x" : "-rw-r--r--";
            const suffix = entryStat.isDirectory ? "/" : "";
            const size = entryStat.size ?? 0;
            const sizeStr = humanReadable ? formatHumanSize(size).padStart(5) : String(size).padStart(5);
            const mtime = entryStat.mtime ?? /* @__PURE__ */ new Date(0);
            const dateStr = formatDate(mtime);
            return {
              name: entry,
              line: `${mode} 1 user user ${sizeStr} ${dateStr} ${entry}${suffix}
`
            };
          } catch {
            return {
              name: entry,
              line: `-rw-r--r-- 1 user user     0 Jan  1 00:00 ${entry}
`
            };
          }
        }));
        entryStats.push(...batchResults);
      }
      const entryOrder = new Map(regularEntries.map((e, i) => [e, i]));
      entryStats.sort((a, b) => (entryOrder.get(a.name) ?? 0) - (entryOrder.get(b.name) ?? 0));
      for (const { line } of entryStats) {
        stdout += line;
      }
    } else {
      stdout += entries.join("\n") + (entries.length ? "\n" : "");
    }
    if (recursive) {
      const filteredEntries = entries.filter((e) => e !== "." && e !== "..");
      let dirEntries = [];
      if (ctx.fs.readdirWithFileTypes) {
        const entriesWithTypes = await ctx.fs.readdirWithFileTypes(fullPath);
        dirEntries = entriesWithTypes.filter((e) => e.isDirectory && filteredEntries.includes(e.name)).map((e) => ({ name: e.name, isDirectory: true }));
      } else {
        for (let i = 0; i < filteredEntries.length; i += DEFAULT_BATCH_SIZE) {
          const batch = filteredEntries.slice(i, i + DEFAULT_BATCH_SIZE);
          const results = await Promise.all(batch.map(async (entry) => {
            const entryPath = fullPath === "/" ? `/${entry}` : `${fullPath}/${entry}`;
            try {
              const entryStat = await ctx.fs.stat(entryPath);
              return { name: entry, isDirectory: entryStat.isDirectory };
            } catch {
              return { name: entry, isDirectory: false };
            }
          }));
          dirEntries.push(...results.filter((r) => r.isDirectory));
        }
      }
      dirEntries.sort((a, b) => a.name.localeCompare(b.name));
      if (reverse) {
        dirEntries.reverse();
      }
      const subResults = [];
      for (let i = 0; i < dirEntries.length; i += DEFAULT_BATCH_SIZE) {
        const batch = dirEntries.slice(i, i + DEFAULT_BATCH_SIZE);
        const batchResults = await Promise.all(batch.map(async (dir) => {
          const subPath = path === "." ? `./${dir.name}` : `${path}/${dir.name}`;
          const result = await listPath(subPath, ctx, showAll, showAlmostAll, longFormat, recursive, false, reverse, humanReadable, sortBySize, true);
          return { name: dir.name, result };
        }));
        subResults.push(...batchResults);
      }
      subResults.sort((a, b) => a.name.localeCompare(b.name));
      if (reverse) {
        subResults.reverse();
      }
      for (const { result } of subResults) {
        stdout += "\n";
        stdout += result.stdout;
      }
    }
    return { stdout, stderr: "", exitCode: 0 };
  } catch {
    return {
      stdout: "",
      stderr: `ls: ${path}: No such file or directory
`,
      exitCode: 2
    };
  }
}
__name(listPath, "listPath");
export {
  lsCommand
};
