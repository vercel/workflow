import {
  parseArgs
} from "./chunk-5NTVBLMJ.js";
import {
  getErrorMessage
} from "./chunk-3EDCHFHY.js";
import "./chunk-HAN5425M.js";
import "./chunk-Y7IWVHJ4.js";

// dist/commands/mkdir/mkdir.js
var argDefs = {
  recursive: { short: "p", long: "parents", type: "boolean" },
  verbose: { short: "v", long: "verbose", type: "boolean" }
};
var mkdirCommand = {
  name: "mkdir",
  async execute(args, ctx) {
    const parsed = parseArgs("mkdir", args, argDefs);
    if (!parsed.ok)
      return parsed.error;
    const recursive = parsed.result.flags.recursive;
    const verbose = parsed.result.flags.verbose;
    const dirs = parsed.result.positional;
    if (dirs.length === 0) {
      return {
        stdout: "",
        stderr: "mkdir: missing operand\n",
        exitCode: 1
      };
    }
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    for (const dir of dirs) {
      try {
        const fullPath = ctx.fs.resolvePath(ctx.cwd, dir);
        await ctx.fs.mkdir(fullPath, { recursive });
        if (verbose) {
          stdout += `mkdir: created directory '${dir}'
`;
        }
      } catch (error) {
        const message = getErrorMessage(error);
        if (message.includes("ENOENT") || message.includes("no such file")) {
          stderr += `mkdir: cannot create directory '${dir}': No such file or directory
`;
        } else if (message.includes("EEXIST") || message.includes("already exists")) {
          stderr += `mkdir: cannot create directory '${dir}': File exists
`;
        } else {
          stderr += `mkdir: cannot create directory '${dir}': ${message}
`;
        }
        exitCode = 1;
      }
    }
    return { stdout, stderr, exitCode };
  }
};
export {
  mkdirCommand
};
