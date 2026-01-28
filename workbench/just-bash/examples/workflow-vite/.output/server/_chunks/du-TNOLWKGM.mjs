import { D as DEFAULT_BATCH_SIZE, _ as __name } from "../index.mjs";
import { p as parseArgs } from "./chunk-5NTVBLMJ.mjs";
import { h as hasHelpFlag, s as showHelp } from "./chunk-HAN5425M.mjs";
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
var duHelp = {
  name: "du",
  summary: "estimate file space usage",
  usage: "du [OPTION]... [FILE]...",
  options: [
    "-a          write counts for all files, not just directories",
    "-h          print sizes in human readable format",
    "-s          display only a total for each argument",
    "-c          produce a grand total",
    "--max-depth=N  print total for directory only if N or fewer levels deep",
    "    --help  display this help and exit"
  ]
};
var argDefs = {
  allFiles: { short: "a", type: "boolean" },
  humanReadable: { short: "h", type: "boolean" },
  summarize: { short: "s", type: "boolean" },
  grandTotal: { short: "c", type: "boolean" },
  maxDepth: { long: "max-depth", type: "number" }
};
var duCommand = {
  name: "du",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(duHelp);
    }
    const parsed = parseArgs("du", args, argDefs);
    if (!parsed.ok)
      return parsed.error;
    const options = {
      allFiles: parsed.result.flags.allFiles,
      humanReadable: parsed.result.flags.humanReadable,
      summarize: parsed.result.flags.summarize,
      grandTotal: parsed.result.flags.grandTotal,
      maxDepth: parsed.result.flags.maxDepth ?? null
    };
    const targets = parsed.result.positional;
    if (targets.length === 0) {
      targets.push(".");
    }
    let stdout = "";
    let stderr = "";
    let grandTotal = 0;
    for (const target of targets) {
      const fullPath = ctx.fs.resolvePath(ctx.cwd, target);
      try {
        await ctx.fs.stat(fullPath);
        const result = await calculateSize(ctx, fullPath, target, options, 0);
        stdout += result.output;
        grandTotal += result.totalSize;
        stderr += result.stderr;
      } catch {
        stderr += `du: cannot access '${target}': No such file or directory
`;
      }
    }
    if (options.grandTotal && targets.length > 0) {
      stdout += `${formatSize(grandTotal, options.humanReadable)}	total
`;
    }
    return { stdout, stderr, exitCode: stderr ? 1 : 0 };
  }
};
async function calculateSize(ctx, fullPath, displayPath, options, depth) {
  const result = {
    output: "",
    totalSize: 0,
    stderr: ""
  };
  try {
    const stat = await ctx.fs.stat(fullPath);
    if (!stat.isDirectory) {
      result.totalSize = stat.size;
      if (options.allFiles || depth === 0) {
        result.output = formatSize(stat.size, options.humanReadable) + "	" + displayPath + "\n";
      }
      return result;
    }
    let dirSize = 0;
    const entryInfos = [];
    if (ctx.fs.readdirWithFileTypes) {
      const entriesWithTypes = await ctx.fs.readdirWithFileTypes(fullPath);
      const fileEntries = entriesWithTypes.filter((e) => e.isFile);
      const dirEntries = entriesWithTypes.filter((e) => e.isDirectory);
      for (let i = 0; i < fileEntries.length; i += DEFAULT_BATCH_SIZE) {
        const batch = fileEntries.slice(i, i + DEFAULT_BATCH_SIZE);
        const stats = await Promise.all(batch.map(async (e) => {
          const entryPath = fullPath === "/" ? `/${e.name}` : `${fullPath}/${e.name}`;
          try {
            const s = await ctx.fs.stat(entryPath);
            return { name: e.name, isDirectory: false, size: s.size };
          } catch {
            return { name: e.name, isDirectory: false, size: 0 };
          }
        }));
        entryInfos.push(...stats);
      }
      entryInfos.push(...dirEntries.map((e) => ({ name: e.name, isDirectory: true })));
    } else {
      const entries = await ctx.fs.readdir(fullPath);
      for (let i = 0; i < entries.length; i += DEFAULT_BATCH_SIZE) {
        const batch = entries.slice(i, i + DEFAULT_BATCH_SIZE);
        const stats = await Promise.all(batch.map(async (entry) => {
          const entryPath = fullPath === "/" ? `/${entry}` : `${fullPath}/${entry}`;
          try {
            const s = await ctx.fs.stat(entryPath);
            return {
              name: entry,
              isDirectory: s.isDirectory,
              size: s.isDirectory ? void 0 : s.size
            };
          } catch {
            return { name: entry, isDirectory: false, size: 0 };
          }
        }));
        entryInfos.push(...stats);
      }
    }
    entryInfos.sort((a, b) => a.name.localeCompare(b.name));
    const fileInfos = entryInfos.filter((e) => !e.isDirectory);
    for (const file of fileInfos) {
      const size = file.size ?? 0;
      dirSize += size;
      if (options.allFiles && !options.summarize) {
        const entryDisplayPath = displayPath === "." ? file.name : `${displayPath}/${file.name}`;
        result.output += formatSize(size, options.humanReadable) + "	" + entryDisplayPath + "\n";
      }
    }
    const dirInfos = entryInfos.filter((e) => e.isDirectory);
    for (let i = 0; i < dirInfos.length; i += DEFAULT_BATCH_SIZE) {
      const batch = dirInfos.slice(i, i + DEFAULT_BATCH_SIZE);
      const subResults = await Promise.all(batch.map(async (dir) => {
        const entryPath = fullPath === "/" ? `/${dir.name}` : `${fullPath}/${dir.name}`;
        const entryDisplayPath = displayPath === "." ? dir.name : `${displayPath}/${dir.name}`;
        return {
          name: dir.name,
          result: await calculateSize(ctx, entryPath, entryDisplayPath, options, depth + 1)
        };
      }));
      subResults.sort((a, b) => a.name.localeCompare(b.name));
      for (const { result: subResult } of subResults) {
        dirSize += subResult.totalSize;
        if (!options.summarize) {
          if (options.maxDepth === null || depth + 1 <= options.maxDepth) {
            result.output += subResult.output;
          }
        }
      }
    }
    result.totalSize = dirSize;
    if (options.summarize || options.maxDepth === null || depth <= options.maxDepth) {
      result.output += `${formatSize(dirSize, options.humanReadable)}	${displayPath}
`;
    }
  } catch (_error) {
    result.stderr = `du: cannot read directory '${displayPath}': Permission denied
`;
  }
  return result;
}
__name(calculateSize, "calculateSize");
function formatSize(bytes, humanReadable) {
  if (!humanReadable) {
    return String(Math.ceil(bytes / 1024) || 1);
  }
  if (bytes < 1024) {
    return `${bytes}`;
  } else if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}K`;
  } else if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  } else {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
  }
}
__name(formatSize, "formatSize");
export {
  duCommand
};
