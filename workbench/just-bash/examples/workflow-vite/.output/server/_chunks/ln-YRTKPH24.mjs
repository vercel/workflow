import { h as hasHelpFlag, s as showHelp } from "./chunk-HAN5425M.mjs";
import "../index.mjs";
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
