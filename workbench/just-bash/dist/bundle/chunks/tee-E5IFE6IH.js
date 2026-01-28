import {
  parseArgs
} from "./chunk-5NTVBLMJ.js";
import {
  hasHelpFlag,
  showHelp
} from "./chunk-HAN5425M.js";
import "./chunk-Y7IWVHJ4.js";

// dist/commands/tee/tee.js
var teeHelp = {
  name: "tee",
  summary: "read from stdin and write to stdout and files",
  usage: "tee [OPTION]... [FILE]...",
  options: [
    "-a, --append     append to the given FILEs, do not overwrite",
    "    --help       display this help and exit"
  ]
};
var argDefs = {
  append: { short: "a", long: "append", type: "boolean" }
};
var teeCommand = {
  name: "tee",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(teeHelp);
    }
    const parsed = parseArgs("tee", args, argDefs);
    if (!parsed.ok)
      return parsed.error;
    const { append } = parsed.result.flags;
    const files = parsed.result.positional;
    const content = ctx.stdin;
    let stderr = "";
    let exitCode = 0;
    for (const file of files) {
      try {
        const filePath = ctx.fs.resolvePath(ctx.cwd, file);
        if (append) {
          await ctx.fs.appendFile(filePath, content);
        } else {
          await ctx.fs.writeFile(filePath, content);
        }
      } catch (_error) {
        stderr += `tee: ${file}: No such file or directory
`;
        exitCode = 1;
      }
    }
    return {
      stdout: content,
      stderr,
      exitCode
    };
  }
};
export {
  teeCommand
};
