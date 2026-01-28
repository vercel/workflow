import {
  hasHelpFlag,
  showHelp
} from "./chunk-HAN5425M.js";
import "./chunk-Y7IWVHJ4.js";

// dist/commands/ln/ln.js
var lnHelp = {
  name: "ln",
  summary: "make links between files",
  usage: "ln [OPTIONS] TARGET LINK_NAME",
  options: [
    "-s      create a symbolic link instead of a hard link",
    "-f      remove existing destination files",
    "-n      treat LINK_NAME as a normal file if it is a symbolic link to a directory",
    "-v      print name of each linked file",
    "    --help display this help and exit"
  ]
};
var lnCommand = {
  name: "ln",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(lnHelp);
    }
    let symbolic = false;
    let force = false;
    let verbose = false;
    let argIdx = 0;
    while (argIdx < args.length && args[argIdx].startsWith("-")) {
      const arg = args[argIdx];
      if (arg === "-s" || arg === "--symbolic") {
        symbolic = true;
        argIdx++;
      } else if (arg === "-f" || arg === "--force") {
        force = true;
        argIdx++;
      } else if (arg === "-v" || arg === "--verbose") {
        verbose = true;
        argIdx++;
      } else if (arg === "-n" || arg === "--no-dereference") {
        argIdx++;
      } else if (/^-[sfvn]+$/.test(arg)) {
        if (arg.includes("s"))
          symbolic = true;
        if (arg.includes("f"))
          force = true;
        if (arg.includes("v"))
          verbose = true;
        argIdx++;
      } else if (arg === "--") {
        argIdx++;
        break;
      } else {
        return {
          stdout: "",
          stderr: `ln: invalid option -- '${arg.slice(1)}'
`,
          exitCode: 1
        };
      }
    }
    const remaining = args.slice(argIdx);
    if (remaining.length < 2) {
      return { stdout: "", stderr: "ln: missing file operand\n", exitCode: 1 };
    }
    const target = remaining[0];
    const linkName = remaining[1];
    const linkPath = ctx.fs.resolvePath(ctx.cwd, linkName);
    if (await ctx.fs.exists(linkPath)) {
      if (force) {
        try {
          await ctx.fs.rm(linkPath, { force: true });
        } catch {
          return {
            stdout: "",
            stderr: `ln: cannot remove '${linkName}': Permission denied
`,
            exitCode: 1
          };
        }
      } else {
        return {
          stdout: "",
          stderr: `ln: failed to create ${symbolic ? "symbolic " : ""}link '${linkName}': File exists
`,
          exitCode: 1
        };
      }
    }
    try {
      if (symbolic) {
        await ctx.fs.symlink(target, linkPath);
      } else {
        const targetPath = ctx.fs.resolvePath(ctx.cwd, target);
        if (!await ctx.fs.exists(targetPath)) {
          return {
            stdout: "",
            stderr: `ln: failed to access '${target}': No such file or directory
`,
            exitCode: 1
          };
        }
        await ctx.fs.link(targetPath, linkPath);
      }
    } catch (e) {
      const err = e;
      if (err.message.includes("EPERM")) {
        return {
          stdout: "",
          stderr: `ln: '${target}': hard link not allowed for directory
`,
          exitCode: 1
        };
      }
      return { stdout: "", stderr: `ln: ${err.message}
`, exitCode: 1 };
    }
    let stdout = "";
    if (verbose) {
      stdout = `'${linkName}' -> '${target}'
`;
    }
    return { stdout, stderr: "", exitCode: 0 };
  }
};
export {
  lnCommand
};
