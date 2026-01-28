import { p as parseHeadTailArgs, a as processHeadTailFiles, b as getTail } from "./chunk-ZLSOC547.mjs";
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
var tailHelp = {
  name: "tail",
  summary: "output the last part of files",
  usage: "tail [OPTION]... [FILE]...",
  options: [
    "-c, --bytes=NUM    print the last NUM bytes",
    "-n, --lines=NUM    print the last NUM lines (default 10)",
    "-n +NUM            print starting from line NUM",
    "-q, --quiet        never print headers giving file names",
    "-v, --verbose      always print headers giving file names",
    "    --help         display this help and exit"
  ]
};
var tailCommand = {
  name: "tail",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(tailHelp);
    }
    const parsed = parseHeadTailArgs(args, "tail");
    if (!parsed.ok) {
      return parsed.error;
    }
    const { lines, bytes, fromLine } = parsed.options;
    return processHeadTailFiles(ctx, parsed.options, "tail", (content) => getTail(content, lines, bytes, fromLine ?? false));
  }
};
export {
  tailCommand
};
