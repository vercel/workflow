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
var dirnameHelp = {
  name: "dirname",
  summary: "strip last component from file name",
  usage: "dirname [OPTION] NAME...",
  options: ["    --help       display this help and exit"]
};
var dirnameCommand = {
  name: "dirname",
  async execute(args, _ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(dirnameHelp);
    }
    const names = args.filter((arg) => !arg.startsWith("-"));
    if (names.length === 0) {
      return {
        stdout: "",
        stderr: "dirname: missing operand\n",
        exitCode: 1
      };
    }
    const results = [];
    for (const name of names) {
      const cleanName = name.replace(/\/+$/, "");
      const lastSlash = cleanName.lastIndexOf("/");
      if (lastSlash === -1) {
        results.push(".");
      } else if (lastSlash === 0) {
        results.push("/");
      } else {
        results.push(cleanName.slice(0, lastSlash));
      }
    }
    return {
      stdout: `${results.join("\n")}
`,
      stderr: "",
      exitCode: 0
    };
  }
};
export {
  dirnameCommand
};
