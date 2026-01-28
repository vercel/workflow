import { m as matchGlob } from "./chunk-YPYB6VZC.mjs";
import { b as buildRegex, s as searchContent } from "./chunk-FTAGPMQM.mjs";
import { h as hasHelpFlag, s as showHelp, u as unknownOption } from "./chunk-HAN5425M.mjs";
import { _ as __name } from "../index.mjs";
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
var grepHelp = {
  name: "grep",
  summary: "print lines that match patterns",
  usage: "grep [OPTION]... PATTERN [FILE]...",
  options: [
    "-E, --extended-regexp    PATTERN is an extended regular expression",
    "-P, --perl-regexp        PATTERN is a Perl regular expression",
    "-F, --fixed-strings      PATTERN is a set of newline-separated strings",
    "-i, --ignore-case        ignore case distinctions",
    "-v, --invert-match       select non-matching lines",
    "-w, --word-regexp        match only whole words",
    "-x, --line-regexp        match only whole lines",
    "-c, --count              print only a count of matching lines",
    "-l, --files-with-matches print only names of files with matches",
    "-L, --files-without-match print names of files with no matches",
    "-m NUM, --max-count=NUM  stop after NUM matches",
    "-n, --line-number        print line number with output lines",
    "-h, --no-filename        suppress the file name prefix on output",
    "-o, --only-matching      show only nonempty parts of lines that match",
    "-q, --quiet, --silent    suppress all normal output",
    "-r, -R, --recursive      search directories recursively",
    "-A NUM                   print NUM lines of trailing context",
    "-B NUM                   print NUM lines of leading context",
    "-C NUM                   print NUM lines of context",
    "-e PATTERN               use PATTERN for matching",
    "    --include=GLOB       search only files matching GLOB",
    "    --exclude=GLOB       skip files matching GLOB",
    "    --exclude-dir=DIR    skip directories matching DIR",
    "    --help               display this help and exit"
  ]
};
var grepCommand = {
  name: "grep",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(grepHelp);
    }
    let ignoreCase = false;
    let showLineNumbers = false;
    let invertMatch = false;
    let countOnly = false;
    let filesWithMatches = false;
    let filesWithoutMatch = false;
    let recursive = false;
    let wholeWord = false;
    let lineRegexp = false;
    let extendedRegex = false;
    let perlRegex = false;
    let fixedStrings = false;
    let onlyMatching = false;
    let noFilename = false;
    let quietMode = false;
    let maxCount = 0;
    let beforeContext = 0;
    let afterContext = 0;
    const includePatterns = [];
    const excludePatterns = [];
    const excludeDirPatterns = [];
    let pattern = null;
    const files = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg.startsWith("-") && arg !== "-") {
        if (arg === "-e" && i + 1 < args.length) {
          pattern = args[++i];
          continue;
        }
        if (arg.startsWith("--include=")) {
          includePatterns.push(arg.slice("--include=".length));
          continue;
        }
        if (arg.startsWith("--exclude=")) {
          excludePatterns.push(arg.slice("--exclude=".length));
          continue;
        }
        if (arg.startsWith("--exclude-dir=")) {
          excludeDirPatterns.push(arg.slice("--exclude-dir=".length));
          continue;
        }
        if (arg.startsWith("--max-count=")) {
          maxCount = parseInt(arg.slice("--max-count=".length), 10);
          continue;
        }
        const maxCountMatch = arg.match(/^-m(\d+)$/);
        if (maxCountMatch) {
          maxCount = parseInt(maxCountMatch[1], 10);
          continue;
        }
        if (arg === "-m" && i + 1 < args.length) {
          maxCount = parseInt(args[++i], 10);
          continue;
        }
        const contextMatch = arg.match(/^-([ABC])(\d+)$/);
        if (contextMatch) {
          const num = parseInt(contextMatch[2], 10);
          if (contextMatch[1] === "A")
            afterContext = num;
          else if (contextMatch[1] === "B")
            beforeContext = num;
          else if (contextMatch[1] === "C") {
            beforeContext = num;
            afterContext = num;
          }
          continue;
        }
        if ((arg === "-A" || arg === "-B" || arg === "-C") && i + 1 < args.length) {
          const num = parseInt(args[++i], 10);
          if (arg === "-A")
            afterContext = num;
          else if (arg === "-B")
            beforeContext = num;
          else {
            beforeContext = num;
            afterContext = num;
          }
          continue;
        }
        const flags = arg.startsWith("--") ? [arg] : arg.slice(1).split("");
        for (const flag of flags) {
          if (flag === "i" || flag === "--ignore-case")
            ignoreCase = true;
          else if (flag === "n" || flag === "--line-number")
            showLineNumbers = true;
          else if (flag === "v" || flag === "--invert-match")
            invertMatch = true;
          else if (flag === "c" || flag === "--count")
            countOnly = true;
          else if (flag === "l" || flag === "--files-with-matches")
            filesWithMatches = true;
          else if (flag === "L" || flag === "--files-without-match")
            filesWithoutMatch = true;
          else if (flag === "r" || flag === "R" || flag === "--recursive")
            recursive = true;
          else if (flag === "w" || flag === "--word-regexp")
            wholeWord = true;
          else if (flag === "x" || flag === "--line-regexp")
            lineRegexp = true;
          else if (flag === "E" || flag === "--extended-regexp")
            extendedRegex = true;
          else if (flag === "P" || flag === "--perl-regexp")
            perlRegex = true;
          else if (flag === "F" || flag === "--fixed-strings")
            fixedStrings = true;
          else if (flag === "o" || flag === "--only-matching")
            onlyMatching = true;
          else if (flag === "h" || flag === "--no-filename")
            noFilename = true;
          else if (flag === "q" || flag === "--quiet" || flag === "--silent")
            quietMode = true;
          else if (flag.startsWith("--")) {
            return unknownOption("grep", flag);
          } else if (flag.length === 1) {
            return unknownOption("grep", `-${flag}`);
          }
        }
      } else if (pattern === null) {
        pattern = arg;
      } else {
        files.push(arg);
      }
    }
    if (pattern === null) {
      return {
        stdout: "",
        stderr: "grep: missing pattern\n",
        exitCode: 2
      };
    }
    const regexMode = fixedStrings ? "fixed" : extendedRegex ? "extended" : perlRegex ? "perl" : "basic";
    let regex;
    let kResetGroup;
    try {
      const regexResult = buildRegex(pattern, {
        mode: regexMode,
        ignoreCase,
        wholeWord,
        lineRegexp
      });
      regex = regexResult.regex;
      kResetGroup = regexResult.kResetGroup;
    } catch {
      return {
        stdout: "",
        stderr: `grep: invalid regular expression: ${pattern}
`,
        exitCode: 2
      };
    }
    if (files.length === 0 && ctx.stdin !== void 0) {
      const result = searchContent(ctx.stdin, regex, {
        invertMatch,
        showLineNumbers,
        countOnly,
        filename: "",
        onlyMatching,
        beforeContext,
        afterContext,
        maxCount,
        kResetGroup
      });
      if (quietMode) {
        return { stdout: "", stderr: "", exitCode: result.matched ? 0 : 1 };
      }
      return {
        stdout: result.output,
        stderr: "",
        exitCode: result.matched ? 0 : 1
      };
    }
    if (files.length === 0) {
      return {
        stdout: "",
        stderr: "grep: no input files\n",
        exitCode: 2
      };
    }
    let stdout = "";
    let stderr = "";
    let anyMatch = false;
    let anyError = false;
    const filesToSearch = [];
    for (const file of files) {
      if (file.includes("*") || file.includes("?") || file.includes("[")) {
        const expanded = await expandGlobPatternWithTypes(file, ctx);
        if (recursive) {
          for (const f of expanded) {
            const recursiveExpanded = await expandRecursiveWithTypes(f.path, ctx, includePatterns, excludePatterns, excludeDirPatterns, f.isFile);
            filesToSearch.push(...recursiveExpanded);
          }
        } else {
          filesToSearch.push(...expanded);
        }
      } else if (recursive) {
        const expanded = await expandRecursiveWithTypes(file, ctx, includePatterns, excludePatterns, excludeDirPatterns);
        filesToSearch.push(...expanded);
      } else {
        filesToSearch.push({ path: file });
      }
    }
    const showFilename = (filesToSearch.length > 1 || recursive) && !noFilename;
    const BATCH_SIZE = 50;
    for (let i = 0; i < filesToSearch.length; i += BATCH_SIZE) {
      const batch = filesToSearch.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map(async (fileEntry) => {
        const file = fileEntry.path;
        const basename = file.split("/").pop() || file;
        if (excludePatterns.length > 0 && !recursive) {
          if (excludePatterns.some((p) => matchGlob(basename, p, { stripQuotes: true }))) {
            return null;
          }
        }
        if (includePatterns.length > 0 && !recursive) {
          if (!includePatterns.some((p) => matchGlob(basename, p, { stripQuotes: true }))) {
            return null;
          }
        }
        try {
          const filePath = ctx.fs.resolvePath(ctx.cwd, file);
          let isDirectory = false;
          if (fileEntry.isFile === void 0) {
            const stat = await ctx.fs.stat(filePath);
            isDirectory = stat.isDirectory;
          } else {
            isDirectory = !fileEntry.isFile;
          }
          if (isDirectory) {
            if (!recursive) {
              return { error: `grep: ${file}: Is a directory
` };
            }
            return null;
          }
          const content = await ctx.fs.readFile(filePath);
          const result = searchContent(content, regex, {
            invertMatch,
            showLineNumbers,
            countOnly,
            filename: showFilename ? file : "",
            onlyMatching,
            beforeContext,
            afterContext,
            maxCount,
            kResetGroup
          });
          return { file, result };
        } catch {
          return { error: `grep: ${file}: No such file or directory
` };
        }
      }));
      for (const res of results) {
        if (res === null)
          continue;
        if ("error" in res && res.error) {
          stderr += res.error;
          if (!res.error.includes("Is a directory")) {
            anyError = true;
          }
          continue;
        }
        if (!("file" in res) || !res.result)
          continue;
        const { file, result } = res;
        if (result.matched) {
          anyMatch = true;
          if (quietMode) {
            return { stdout: "", stderr: "", exitCode: 0 };
          }
          if (filesWithMatches) {
            stdout += `${file}
`;
          } else if (!filesWithoutMatch) {
            stdout += result.output;
          }
        } else {
          if (filesWithoutMatch) {
            stdout += `${file}
`;
          } else if (countOnly && !filesWithMatches) {
            stdout += result.output;
          }
        }
      }
    }
    let exitCode;
    if (anyError) {
      exitCode = 2;
    } else if (filesWithoutMatch) {
      exitCode = stdout.length > 0 ? 0 : 1;
    } else {
      exitCode = anyMatch ? 0 : 1;
    }
    if (quietMode) {
      return { stdout: "", stderr: "", exitCode };
    }
    return {
      stdout,
      stderr,
      exitCode
    };
  }
};
async function expandRecursiveGlob(baseDir, afterGlob, ctx, result) {
  const fullBasePath = ctx.fs.resolvePath(ctx.cwd, baseDir);
  try {
    const stat = await ctx.fs.stat(fullBasePath);
    if (!stat.isDirectory) {
      const filename = baseDir.split("/").pop() || "";
      if (afterGlob) {
        const pattern = afterGlob.replace(/^\//, "");
        if (matchGlob(filename, pattern, { stripQuotes: true })) {
          result.push(baseDir);
        }
      }
      return;
    }
    const entries = await ctx.fs.readdir(fullBasePath);
    for (const entry of entries) {
      const entryPath = baseDir === "." ? entry : `${baseDir}/${entry}`;
      const fullEntryPath = ctx.fs.resolvePath(ctx.cwd, entryPath);
      const entryStat = await ctx.fs.stat(fullEntryPath);
      if (entryStat.isDirectory) {
        await expandRecursiveGlob(entryPath, afterGlob, ctx, result);
      } else if (afterGlob) {
        const pattern = afterGlob.replace(/^\//, "");
        if (matchGlob(entry, pattern, { stripQuotes: true })) {
          result.push(entryPath);
        }
      }
    }
  } catch {
  }
}
__name(expandRecursiveGlob, "expandRecursiveGlob");
async function expandGlobPatternWithTypes(pattern, ctx) {
  const result = [];
  const lastSlash = pattern.lastIndexOf("/");
  let dirPath;
  let globPart;
  if (lastSlash === -1) {
    dirPath = ctx.cwd;
    globPart = pattern;
  } else {
    dirPath = pattern.slice(0, lastSlash) || "/";
    globPart = pattern.slice(lastSlash + 1);
  }
  if (pattern.includes("**")) {
    const oldResult = [];
    const parts = pattern.split("**");
    const baseDir = parts[0].replace(/\/$/, "") || ".";
    const afterGlob = parts[1] || "";
    await expandRecursiveGlob(baseDir, afterGlob, ctx, oldResult);
    return oldResult.map((p) => ({ path: p }));
  }
  const fullDirPath = ctx.fs.resolvePath(ctx.cwd, dirPath);
  try {
    if (ctx.fs.readdirWithFileTypes) {
      const entries = await ctx.fs.readdirWithFileTypes(fullDirPath);
      for (const entry of entries) {
        if (matchGlob(entry.name, globPart, { stripQuotes: true })) {
          const fullPath = lastSlash === -1 ? entry.name : `${dirPath}/${entry.name}`;
          result.push({
            path: fullPath,
            isFile: entry.isFile
          });
        }
      }
    } else {
      const entries = await ctx.fs.readdir(fullDirPath);
      for (const entry of entries) {
        if (matchGlob(entry, globPart, { stripQuotes: true })) {
          const fullPath = lastSlash === -1 ? entry : `${dirPath}/${entry}`;
          result.push({ path: fullPath });
        }
      }
    }
  } catch {
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
__name(expandGlobPatternWithTypes, "expandGlobPatternWithTypes");
async function expandRecursiveWithTypes(path, ctx, includePatterns = [], excludePatterns = [], excludeDirPatterns = [], knownIsFile) {
  const fullPath = ctx.fs.resolvePath(ctx.cwd, path);
  const result = [];
  try {
    let isFile;
    let isDirectory;
    if (knownIsFile !== void 0) {
      isFile = knownIsFile;
      isDirectory = !knownIsFile;
    } else {
      const stat = await ctx.fs.stat(fullPath);
      isFile = stat.isFile;
      isDirectory = stat.isDirectory;
    }
    if (isFile) {
      const basename = path.split("/").pop() || path;
      if (excludePatterns.length > 0) {
        if (excludePatterns.some((p) => matchGlob(basename, p, { stripQuotes: true }))) {
          return [];
        }
      }
      if (includePatterns.length > 0) {
        if (!includePatterns.some((p) => matchGlob(basename, p, { stripQuotes: true }))) {
          return [];
        }
      }
      return [{ path, isFile: true }];
    }
    if (!isDirectory) {
      return [];
    }
    const dirName = path.split("/").pop() || path;
    if (excludeDirPatterns.length > 0) {
      if (excludeDirPatterns.some((p) => matchGlob(dirName, p, { stripQuotes: true }))) {
        return [];
      }
    }
    if (ctx.fs.readdirWithFileTypes) {
      const entries = await ctx.fs.readdirWithFileTypes(fullPath);
      for (const entry of entries) {
        if (entry.name.startsWith("."))
          continue;
        const entryPath = path === "." ? entry.name : `${path}/${entry.name}`;
        const expanded = await expandRecursiveWithTypes(entryPath, ctx, includePatterns, excludePatterns, excludeDirPatterns, entry.isFile);
        result.push(...expanded);
      }
    } else {
      const entries = await ctx.fs.readdir(fullPath);
      for (const entry of entries) {
        if (entry.startsWith("."))
          continue;
        const entryPath = path === "." ? entry : `${path}/${entry}`;
        const expanded = await expandRecursiveWithTypes(entryPath, ctx, includePatterns, excludePatterns, excludeDirPatterns);
        result.push(...expanded);
      }
    }
  } catch {
  }
  return result;
}
__name(expandRecursiveWithTypes, "expandRecursiveWithTypes");
var fgrepCommand = {
  name: "fgrep",
  async execute(args, ctx) {
    return grepCommand.execute(["-F", ...args], ctx);
  }
};
var egrepCommand = {
  name: "egrep",
  async execute(args, ctx) {
    return grepCommand.execute(["-E", ...args], ctx);
  }
};
export {
  egrepCommand,
  fgrepCommand,
  grepCommand
};
