import { h as hasHelpFlag, s as showHelp } from "./chunk-HAN5425M.mjs";
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
          mode &= -2049;
          mode |= specialBits & 2048;
        }
        if (who.includes("g")) {
          mode &= -1025;
          mode |= specialBits & 1024;
        }
      }
      if (perms.includes("t")) {
        mode &= -513;
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
