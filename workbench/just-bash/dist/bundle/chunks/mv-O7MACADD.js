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

// dist/commands/mv/mv.js
var mvHelp = {
  name: "mv",
  summary: "move (rename) files",
  usage: "mv [OPTION]... SOURCE... DEST",
  options: [
    "-f, --force       do not prompt before overwriting",
    "-n, --no-clobber  do not overwrite an existing file",
    "-v, --verbose     explain what is being done",
    "    --help        display this help and exit"
  ]
};
var argDefs = {
  force: { short: "f", long: "force", type: "boolean" },
  noClobber: { short: "n", long: "no-clobber", type: "boolean" },
  verbose: { short: "v", long: "verbose", type: "boolean" }
};
var mvCommand = {
  name: "mv",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(mvHelp);
    }
    const parsed = parseArgs("mv", args, argDefs);
    if (!parsed.ok)
      return parsed.error;
    let force = parsed.result.flags.force;
    const noClobber = parsed.result.flags.noClobber;
    const verbose = parsed.result.flags.verbose;
    const paths = parsed.result.positional;
    if (noClobber) {
      force = false;
    }
    if (paths.length < 2) {
      return {
        stdout: "",
        stderr: "mv: missing destination file operand\n",
        exitCode: 1
      };
    }
    const dest = paths.pop() ?? "";
    const sources = paths;
    const destPath = ctx.fs.resolvePath(ctx.cwd, dest);
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    void force;
    let destIsDir = false;
    try {
      const stat = await ctx.fs.stat(destPath);
      destIsDir = stat.isDirectory;
    } catch {
    }
    if (sources.length > 1 && !destIsDir) {
      return {
        stdout: "",
        stderr: `mv: target '${dest}' is not a directory
`,
        exitCode: 1
      };
    }
    for (const src of sources) {
      try {
        const srcPath = ctx.fs.resolvePath(ctx.cwd, src);
        let targetPath = destPath;
        if (destIsDir) {
          const basename = src.split("/").pop() || src;
          targetPath = destPath === "/" ? `/${basename}` : `${destPath}/${basename}`;
        }
        if (noClobber) {
          try {
            await ctx.fs.stat(targetPath);
            continue;
          } catch {
          }
        }
        await ctx.fs.mv(srcPath, targetPath);
        if (verbose) {
          const targetName = destIsDir ? `${dest}/${src.split("/").pop() || src}` : dest;
          stdout += `renamed '${src}' -> '${targetName}'
`;
        }
      } catch (error) {
        const message = getErrorMessage(error);
        if (message.includes("ENOENT") || message.includes("no such file")) {
          stderr += `mv: cannot stat '${src}': No such file or directory
`;
        } else {
          stderr += `mv: cannot move '${src}': ${message}
`;
        }
        exitCode = 1;
      }
    }
    return { stdout, stderr, exitCode };
  }
};
export {
  mvCommand
};
