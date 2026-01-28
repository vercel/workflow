import { p as parseArgs } from "./chunk-5NTVBLMJ.mjs";
import { m as getErrorMessage } from "../index.mjs";
import { h as hasHelpFlag, s as showHelp } from "./chunk-HAN5425M.mjs";
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
