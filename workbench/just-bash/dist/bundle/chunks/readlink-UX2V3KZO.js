import {
  hasHelpFlag,
  showHelp
} from "./chunk-HAN5425M.js";
import "./chunk-Y7IWVHJ4.js";

// dist/commands/readlink/readlink.js
var readlinkHelp = {
  name: "readlink",
  summary: "print resolved symbolic links or canonical file names",
  usage: "readlink [OPTIONS] FILE...",
  options: [
    "-f      canonicalize by following every symlink in every component of the given name recursively",
    "    --help display this help and exit"
  ]
};
var readlinkCommand = {
  name: "readlink",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(readlinkHelp);
    }
    let canonicalize = false;
    let argIdx = 0;
    while (argIdx < args.length && args[argIdx].startsWith("-")) {
      const arg = args[argIdx];
      if (arg === "-f" || arg === "--canonicalize") {
        canonicalize = true;
        argIdx++;
      } else if (arg === "--") {
        argIdx++;
        break;
      } else {
        return {
          stdout: "",
          stderr: `readlink: invalid option -- '${arg.slice(1)}'
`,
          exitCode: 1
        };
      }
    }
    const files = args.slice(argIdx);
    if (files.length === 0) {
      return { stdout: "", stderr: "readlink: missing operand\n", exitCode: 1 };
    }
    let stdout = "";
    let anyError = false;
    for (const file of files) {
      const filePath = ctx.fs.resolvePath(ctx.cwd, file);
      try {
        if (canonicalize) {
          let currentPath = filePath;
          const seen = /* @__PURE__ */ new Set();
          while (true) {
            if (seen.has(currentPath)) {
              break;
            }
            seen.add(currentPath);
            try {
              const target = await ctx.fs.readlink(currentPath);
              if (target.startsWith("/")) {
                currentPath = target;
              } else {
                const dir = currentPath.substring(0, currentPath.lastIndexOf("/")) || "/";
                currentPath = ctx.fs.resolvePath(dir, target);
              }
            } catch {
              break;
            }
          }
          stdout += `${currentPath}
`;
        } else {
          const target = await ctx.fs.readlink(filePath);
          stdout += `${target}
`;
        }
      } catch {
        if (!canonicalize) {
          anyError = true;
        } else {
          stdout += `${filePath}
`;
        }
      }
    }
    return { stdout, stderr: "", exitCode: anyError ? 1 : 0 };
  }
};
export {
  readlinkCommand
};
