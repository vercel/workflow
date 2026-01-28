import { p as parseArgs } from "./chunk-5NTVBLMJ.mjs";
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
var whichHelp = {
  name: "which",
  summary: "locate a command",
  usage: "which [-as] program ...",
  options: [
    "-a         List all instances of executables found",
    "-s         No output, just return 0 if found, 1 if not",
    "--help     display this help and exit"
  ]
};
var argDefs = {
  showAll: { short: "a", type: "boolean" },
  silent: { short: "s", type: "boolean" }
};
var whichCommand = {
  name: "which",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(whichHelp);
    }
    const parsed = parseArgs("which", args, argDefs);
    if (!parsed.ok)
      return parsed.error;
    const showAll = parsed.result.flags.showAll;
    const silent = parsed.result.flags.silent;
    const names = parsed.result.positional;
    if (names.length === 0) {
      return { stdout: "", stderr: "", exitCode: 1 };
    }
    const pathEnv = ctx.env.PATH || "/usr/bin:/bin";
    const pathDirs = pathEnv.split(":");
    let stdout = "";
    let allFound = true;
    for (const name of names) {
      let found = false;
      for (const dir of pathDirs) {
        if (!dir)
          continue;
        const fullPath = `${dir}/${name}`;
        if (await ctx.fs.exists(fullPath)) {
          found = true;
          if (!silent) {
            stdout += `${fullPath}
`;
          }
          if (!showAll) {
            break;
          }
        }
      }
      if (!found) {
        allFound = false;
      }
    }
    return {
      stdout,
      stderr: "",
      exitCode: allFound ? 0 : 1
    };
  }
};
export {
  whichCommand
};
