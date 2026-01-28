import {
  DEFAULT_BATCH_SIZE
} from "./chunk-PRIRMCRG.js";
import {
  parseArgs
} from "./chunk-5NTVBLMJ.js";
import {
  hasHelpFlag,
  showHelp
} from "./chunk-HAN5425M.js";
import {
  __name
} from "./chunk-Y7IWVHJ4.js";

// dist/commands/tree/tree.js
var treeHelp = {
  name: "tree",
  summary: "list contents of directories in a tree-like format",
  usage: "tree [OPTION]... [DIRECTORY]...",
  options: [
    "-a          include hidden files",
    "-d          list directories only",
    "-L LEVEL    limit depth of directory tree",
    "-f          print full path prefix for each file",
    "    --help  display this help and exit"
  ]
};
var argDefs = {
  showHidden: { short: "a", type: "boolean" },
  directoriesOnly: { short: "d", type: "boolean" },
  fullPath: { short: "f", type: "boolean" },
  maxDepth: { short: "L", type: "number" }
};
var treeCommand = {
  name: "tree",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(treeHelp);
    }
    const parsed = parseArgs("tree", args, argDefs);
    if (!parsed.ok)
      return parsed.error;
    const options = {
      showHidden: parsed.result.flags.showHidden,
      directoriesOnly: parsed.result.flags.directoriesOnly,
      maxDepth: parsed.result.flags.maxDepth ?? null,
      fullPath: parsed.result.flags.fullPath
    };
    const directories = parsed.result.positional;
    if (directories.length === 0) {
      directories.push(".");
    }
    let stdout = "";
    let stderr = "";
    let dirCount = 0;
    let fileCount = 0;
    for (const dir of directories) {
      const result = await buildTree(ctx, dir, options, "", 0);
      stdout += result.output;
      stderr += result.stderr;
      dirCount += result.dirCount;
      fileCount += result.fileCount;
    }
    stdout += `
${dirCount} director${dirCount === 1 ? "y" : "ies"}`;
    if (!options.directoriesOnly) {
      stdout += `, ${fileCount} file${fileCount === 1 ? "" : "s"}`;
    }
    stdout += "\n";
    return { stdout, stderr, exitCode: stderr ? 1 : 0 };
  }
};
async function buildTree(ctx, path, options, prefix, depth) {
  const result = {
    output: "",
    stderr: "",
    dirCount: 0,
    fileCount: 0
  };
  const fullPath = ctx.fs.resolvePath(ctx.cwd, path);
  try {
    const stat = await ctx.fs.stat(fullPath);
    if (!stat.isDirectory) {
      result.output = `${path}
`;
      result.fileCount = 1;
      return result;
    }
  } catch {
    result.stderr = `tree: ${path}: No such file or directory
`;
    return result;
  }
  result.output = `${path}
`;
  if (options.maxDepth !== null && depth >= options.maxDepth) {
    return result;
  }
  try {
    let entryInfos = [];
    if (ctx.fs.readdirWithFileTypes) {
      const entriesWithTypes = await ctx.fs.readdirWithFileTypes(fullPath);
      entryInfos = entriesWithTypes.map((e) => ({
        name: e.name,
        isDirectory: e.isDirectory
      }));
    } else {
      const entries = await ctx.fs.readdir(fullPath);
      for (let i = 0; i < entries.length; i += DEFAULT_BATCH_SIZE) {
        const batch = entries.slice(i, i + DEFAULT_BATCH_SIZE);
        const stats = await Promise.all(batch.map(async (entry) => {
          const entryPath = fullPath === "/" ? `/${entry}` : `${fullPath}/${entry}`;
          try {
            const s = await ctx.fs.stat(entryPath);
            return { name: entry, isDirectory: s.isDirectory };
          } catch {
            return null;
          }
        }));
        entryInfos.push(...stats.filter((s) => s !== null));
      }
    }
    const filteredEntries = entryInfos.filter((e) => {
      if (!options.showHidden && e.name.startsWith(".")) {
        return false;
      }
      if (options.directoriesOnly && !e.isDirectory) {
        return false;
      }
      return true;
    });
    filteredEntries.sort((a, b) => a.name.localeCompare(b.name));
    for (let i = 0; i < filteredEntries.length; i++) {
      const entry = filteredEntries[i];
      const entryPath = fullPath === "/" ? `/${entry.name}` : `${fullPath}/${entry.name}`;
      const isLast = i === filteredEntries.length - 1;
      const connector = isLast ? "`-- " : "|-- ";
      const childPrefix = prefix + (isLast ? "    " : "|   ");
      if (entry.isDirectory) {
        result.dirCount++;
        const displayName = options.fullPath ? entryPath : entry.name;
        result.output += `${prefix + connector + displayName}
`;
        if (options.maxDepth === null || depth + 1 < options.maxDepth) {
          const subResult = await buildTreeRecursive(ctx, entryPath, options, childPrefix, depth + 1);
          result.output += subResult.output;
          result.dirCount += subResult.dirCount;
          result.fileCount += subResult.fileCount;
        }
      } else {
        result.fileCount++;
        const displayName = options.fullPath ? entryPath : entry.name;
        result.output += `${prefix + connector + displayName}
`;
      }
    }
  } catch (_error) {
    result.stderr = `tree: ${path}: Permission denied
`;
  }
  return result;
}
__name(buildTree, "buildTree");
async function buildTreeRecursive(ctx, path, options, prefix, depth) {
  const result = {
    output: "",
    stderr: "",
    dirCount: 0,
    fileCount: 0
  };
  if (options.maxDepth !== null && depth >= options.maxDepth) {
    return result;
  }
  try {
    let entryInfos = [];
    if (ctx.fs.readdirWithFileTypes) {
      const entriesWithTypes = await ctx.fs.readdirWithFileTypes(path);
      entryInfos = entriesWithTypes.map((e) => ({
        name: e.name,
        isDirectory: e.isDirectory
      }));
    } else {
      const entries = await ctx.fs.readdir(path);
      for (let i = 0; i < entries.length; i += DEFAULT_BATCH_SIZE) {
        const batch = entries.slice(i, i + DEFAULT_BATCH_SIZE);
        const stats = await Promise.all(batch.map(async (entry) => {
          const entryPath = path === "/" ? `/${entry}` : `${path}/${entry}`;
          try {
            const s = await ctx.fs.stat(entryPath);
            return { name: entry, isDirectory: s.isDirectory };
          } catch {
            return null;
          }
        }));
        entryInfos.push(...stats.filter((s) => s !== null));
      }
    }
    const filteredEntries = entryInfos.filter((e) => {
      if (!options.showHidden && e.name.startsWith(".")) {
        return false;
      }
      if (options.directoriesOnly && !e.isDirectory) {
        return false;
      }
      return true;
    });
    filteredEntries.sort((a, b) => a.name.localeCompare(b.name));
    for (let i = 0; i < filteredEntries.length; i++) {
      const entry = filteredEntries[i];
      const entryPath = path === "/" ? `/${entry.name}` : `${path}/${entry.name}`;
      const isLast = i === filteredEntries.length - 1;
      const connector = isLast ? "`-- " : "|-- ";
      const childPrefix = prefix + (isLast ? "    " : "|   ");
      if (entry.isDirectory) {
        result.dirCount++;
        const displayName = options.fullPath ? entryPath : entry.name;
        result.output += `${prefix + connector + displayName}
`;
        const subResult = await buildTreeRecursive(ctx, entryPath, options, childPrefix, depth + 1);
        result.output += subResult.output;
        result.dirCount += subResult.dirCount;
        result.fileCount += subResult.fileCount;
      } else {
        result.fileCount++;
        const displayName = options.fullPath ? entryPath : entry.name;
        result.output += `${prefix + connector + displayName}
`;
      }
    }
  } catch {
  }
  return result;
}
__name(buildTreeRecursive, "buildTreeRecursive");
export {
  treeCommand
};
