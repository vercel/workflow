import { p as parseArgs } from "./chunk-5NTVBLMJ.mjs";
import { m as getErrorMessage } from "../index.mjs";
import "./chunk-HAN5425M.mjs";
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
