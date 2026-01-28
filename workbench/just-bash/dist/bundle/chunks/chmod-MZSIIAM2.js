import {
  hasHelpFlag,
  showHelp
} from "./chunk-HAN5425M.js";
import {
  __name
} from "./chunk-Y7IWVHJ4.js";

// dist/commands/chmod/chmod.js
var chmodHelp = {
  name: "chmod",
  summary: "change file mode bits",
  usage: "chmod [OPTIONS] MODE FILE...",
  options: [
    "-R      change files recursively",
    "-v      output a diagnostic for every file processed",
    "    --help display this help and exit"
  ]
};
var chmodCommand = {
  name: "chmod",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(chmodHelp);
    }
    if (args.length < 2) {
      return { stdout: "", stderr: "chmod: missing operand\n", exitCode: 1 };
    }
    let recursive = false;
    let verbose = false;
    let argIdx = 0;
    while (argIdx < args.length && args[argIdx].startsWith("-")) {
      const arg = args[argIdx];
      if (arg === "-R" || arg === "--recursive") {
        recursive = true;
        argIdx++;
      } else if (arg === "-v" || arg === "--verbose") {
        verbose = true;
        argIdx++;
      } else if (arg === "--") {
        argIdx++;
        break;
      } else {
        if (/^[+-]?[rwxugo]+/.test(arg) || /^\d+$/.test(arg)) {
          break;
        }
        if (/^-[Rv]+$/.test(arg)) {
          if (arg.includes("R"))
            recursive = true;
          if (arg.includes("v"))
            verbose = true;
          argIdx++;
          continue;
        }
        return {
          stdout: "",
          stderr: `chmod: invalid option -- '${arg.slice(1)}'
`,
          exitCode: 1
        };
      }
    }
    if (args.length - argIdx < 2) {
      return { stdout: "", stderr: "chmod: missing operand\n", exitCode: 1 };
    }
    const modeArg = args[argIdx];
    const files = args.slice(argIdx + 1);
    const isNumericMode = /^[0-7]+$/.test(modeArg);
    let numericMode;
    if (isNumericMode) {
      numericMode = parseInt(modeArg, 8);
    } else {
      try {
        parseMode(modeArg, 420);
      } catch {
        return {
          stdout: "",
          stderr: `chmod: invalid mode: '${modeArg}'
`,
          exitCode: 1
        };
      }
    }
    let stdout = "";
    let stderr = "";
    let anyError = false;
    for (const file of files) {
      const filePath = ctx.fs.resolvePath(ctx.cwd, file);
      try {
        let modeValue;
        if (isNumericMode && numericMode !== void 0) {
          modeValue = numericMode;
        } else {
          const stat = await ctx.fs.stat(filePath);
          modeValue = parseMode(modeArg, stat.mode);
        }
        await ctx.fs.chmod(filePath, modeValue);
        if (verbose) {
          stdout += `mode of '${file}' changed to ${modeValue.toString(8).padStart(4, "0")}
`;
        }
        if (recursive) {
          const stat = await ctx.fs.stat(filePath);
          if (stat.isDirectory) {
            const recursiveOutput = await chmodRecursive(ctx, filePath, isNumericMode ? numericMode : void 0, isNumericMode ? void 0 : modeArg, verbose);
            stdout += recursiveOutput;
          }
        }
      } catch {
        stderr += `chmod: cannot access '${file}': No such file or directory
`;
        anyError = true;
      }
    }
    return { stdout, stderr, exitCode: anyError ? 1 : 0 };
  }
};
async function chmodRecursive(ctx, dir, numericMode, symbolicMode, verbose) {
  let output = "";
  const entries = await ctx.fs.readdir(dir);
  for (const entry of entries) {
    const fullPath = dir === "/" ? `/${entry}` : `${dir}/${entry}`;
    let modeValue;
    if (numericMode !== void 0) {
      modeValue = numericMode;
    } else if (symbolicMode !== void 0) {
      const stat2 = await ctx.fs.stat(fullPath);
      modeValue = parseMode(symbolicMode, stat2.mode);
    } else {
      modeValue = 420;
    }
    await ctx.fs.chmod(fullPath, modeValue);
    if (verbose) {
      output += `mode of '${fullPath}' changed to ${modeValue.toString(8).padStart(4, "0")}
`;
    }
    const stat = await ctx.fs.stat(fullPath);
    if (stat.isDirectory) {
      output += await chmodRecursive(ctx, fullPath, numericMode, symbolicMode, verbose);
    }
  }
  return output;
}
__name(chmodRecursive, "chmodRecursive");
function parseMode(modeStr, currentMode = 420) {
  if (/^[0-7]+$/.test(modeStr)) {
    return parseInt(modeStr, 8);
  }
  let mode = currentMode & 4095;
  const parts = modeStr.split(",");
  for (const part of parts) {
    const match = part.match(/^([ugoa]*)([+\-=])([rwxXst]*)$/);
    if (!match) {
      throw new Error(`Invalid mode: ${modeStr}`);
    }
    let who = match[1] || "a";
    const op = match[2];
    const perms = match[3];
    if (who === "a" || who === "") {
      who = "ugo";
    }
    let permBits = 0;
    if (perms.includes("r"))
      permBits |= 4;
    if (perms.includes("w"))
      permBits |= 2;
    if (perms.includes("x") || perms.includes("X"))
      permBits |= 1;
    let specialBits = 0;
    if (perms.includes("s")) {
      if (who.includes("u"))
        specialBits |= 2048;
      if (who.includes("g"))
        specialBits |= 1024;
    }
    if (perms.includes("t")) {
      specialBits |= 512;
    }
    for (const w of who) {
      let shift = 0;
      if (w === "u")
        shift = 6;
      else if (w === "g")
        shift = 3;
      else if (w === "o")
        shift = 0;
      const bits = permBits << shift;
      if (op === "+") {
        mode |= bits;
      } else if (op === "-") {
        mode &= ~bits;
      } else if (op === "=") {
        mode &= ~(7 << shift);
        mode |= bits;
      }
    }
    if (op === "+") {
      mode |= specialBits;
    } else if (op === "-") {
      mode &= ~specialBits;
    } else if (op === "=") {
      if (perms.includes("s")) {
        if (who.includes("u")) {
          mode &= ~2048;
          mode |= specialBits & 2048;
        }
        if (who.includes("g")) {
          mode &= ~1024;
          mode |= specialBits & 1024;
        }
      }
      if (perms.includes("t")) {
        mode &= ~512;
        mode |= specialBits & 512;
      }
    }
  }
  return mode;
}
__name(parseMode, "parseMode");
export {
  chmodCommand
};
