import {
  parseArgs
} from "./chunk-5NTVBLMJ.js";
import {
  getErrorMessage
} from "./chunk-3EDCHFHY.js";
import "./chunk-HAN5425M.js";
import "./chunk-Y7IWVHJ4.js";

// dist/commands/rm/rm.js
var argDefs = {
  recursive: { short: "r", long: "recursive", type: "boolean" },
  recursiveUpper: { short: "R", type: "boolean" },
  force: { short: "f", long: "force", type: "boolean" },
  verbose: { short: "v", long: "verbose", type: "boolean" }
};
var rmCommand = {
  name: "rm",
  async execute(args, ctx) {
    const parsed = parseArgs("rm", args, argDefs);
    if (!parsed.ok)
      return parsed.error;
    const recursive = parsed.result.flags.recursive || parsed.result.flags.recursiveUpper;
    const force = parsed.result.flags.force;
    const verbose = parsed.result.flags.verbose;
    const paths = parsed.result.positional;
    if (paths.length === 0) {
      if (force) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return {
        stdout: "",
        stderr: "rm: missing operand\n",
        exitCode: 1
      };
    }
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    for (const path of paths) {
      try {
        const fullPath = ctx.fs.resolvePath(ctx.cwd, path);
        const stat = await ctx.fs.stat(fullPath);
        if (stat.isDirectory && !recursive) {
          stderr += `rm: cannot remove '${path}': Is a directory
`;
          exitCode = 1;
          continue;
        }
        await ctx.fs.rm(fullPath, { recursive, force });
        if (verbose) {
          stdout += `removed '${path}'
`;
        }
      } catch (error) {
        if (!force) {
          const message = getErrorMessage(error);
          if (message.includes("ENOENT") || message.includes("no such file")) {
            stderr += `rm: cannot remove '${path}': No such file or directory
`;
          } else if (message.includes("ENOTEMPTY") || message.includes("not empty")) {
            stderr += `rm: cannot remove '${path}': Directory not empty
`;
          } else {
            stderr += `rm: cannot remove '${path}': ${message}
`;
          }
          exitCode = 1;
        }
      }
    }
    return { stdout, stderr, exitCode };
  }
};
export {
  rmCommand
};
