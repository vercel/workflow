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
var historyHelp = {
  name: "history",
  summary: "display command history",
  usage: "history [n]",
  options: [
    "-c      clear the history list",
    "    --help display this help and exit"
  ]
};
var HISTORY_KEY = "BASH_HISTORY";
var historyCommand = {
  name: "history",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(historyHelp);
    }
    const historyStr = ctx.env[HISTORY_KEY] || "[]";
    let history;
    try {
      history = JSON.parse(historyStr);
    } catch {
      history = [];
    }
    if (args[0] === "-c") {
      ctx.env[HISTORY_KEY] = "[]";
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    let count = history.length;
    if (args[0] && /^\d+$/.test(args[0])) {
      count = Math.min(parseInt(args[0], 10), history.length);
    }
    const start = history.length - count;
    let stdout = "";
    for (let i = start; i < history.length; i++) {
      const lineNum = (i + 1).toString().padStart(5, " ");
      stdout += `${lineNum}  ${history[i]}
`;
    }
    return { stdout, stderr: "", exitCode: 0 };
  }
};
export {
  historyCommand
};
