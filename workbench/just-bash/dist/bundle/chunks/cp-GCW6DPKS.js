import {
  parseArgs
} from "./chunk-5NTVBLMJ.js";
import {
  getErrorMessage
} from "./chunk-3EDCHFHY.js";
import {
  hasHelpFlag,
  showHelp
} from "./chunk-HAN5425M.js";
import "./chunk-Y7IWVHJ4.js";

// dist/commands/cp/cp.js
var cpHelp = {
  name: "cp",
  summary: "copy files and directories",
  usage: "cp [OPTION]... SOURCE... DEST",
  options: [
    "-r, -R, --recursive  copy directories recursively",
    "-n, --no-clobber     do not overwrite an existing file",
    "-p, --preserve       preserve file attributes",
    "-v, --verbose        explain what is being done",
    "    --help           display this help and exit"
  ]
};
var argDefs = {
  recursive: { short: "r", long: "recursive", type: "boolean" },
  recursiveUpper: { short: "R", type: "boolean" },
  noClobber: { short: "n", long: "no-clobber", type: "boolean" },
  preserve: { short: "p", long: "preserve", type: "boolean" },
  verbose: { short: "v", long: "verbose", type: "boolean" }
};
var cpCommand = {
  name: "cp",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(cpHelp);
    }
    const parsed = parseArgs("cp", args, argDefs);
    if (!parsed.ok)
      return parsed.error;
    const recursive = parsed.result.flags.recursive || parsed.result.flags.recursiveUpper;
    const noClobber = parsed.result.flags.noClobber;
    const preserve = parsed.result.flags.preserve;
    const verbose = parsed.result.flags.verbose;
    const paths = parsed.result.positional;
    if (paths.length < 2) {
      return {
        stdout: "",
        stderr: "cp: missing destination file operand\n",
        exitCode: 1
      };
    }
    const dest = paths.pop() ?? "";
    const sources = paths;
    const destPath = ctx.fs.resolvePath(ctx.cwd, dest);
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    let destIsDir = false;
    try {
      const stat = await ctx.fs.stat(destPath);
      destIsDir = stat.isDirectory;
    } catch {
    }
    if (sources.length > 1 && !destIsDir) {
      return {
        stdout: "",
        stderr: `cp: target '${dest}' is not a directory
`,
        exitCode: 1
      };
    }
    for (const src of sources) {
      try {
        const srcPath = ctx.fs.resolvePath(ctx.cwd, src);
        const srcStat = await ctx.fs.stat(srcPath);
        let targetPath = destPath;
        if (destIsDir) {
          const basename = src.split("/").pop() || src;
          targetPath = destPath === "/" ? `/${basename}` : `${destPath}/${basename}`;
        }
        if (srcStat.isDirectory && !recursive) {
          stderr += `cp: -r not specified; omitting directory '${src}'
`;
          exitCode = 1;
          continue;
        }
        if (noClobber) {
          try {
            await ctx.fs.stat(targetPath);
            continue;
          } catch {
          }
        }
        await ctx.fs.cp(srcPath, targetPath, { recursive });
        if (preserve) {
        }
        if (verbose) {
          stdout += `'${src}' -> '${targetPath}'
`;
        }
      } catch (error) {
        const message = getErrorMessage(error);
        if (message.includes("ENOENT") || message.includes("no such file")) {
          stderr += `cp: cannot stat '${src}': No such file or directory
`;
        } else {
          stderr += `cp: cannot copy '${src}': ${message}
`;
        }
        exitCode = 1;
      }
    }
    return { stdout, stderr, exitCode };
  }
};
export {
  cpCommand
};
