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
var basenameHelp = {
  name: "basename",
  summary: "strip directory and suffix from filenames",
  usage: "basename NAME [SUFFIX]\nbasename OPTION... NAME...",
  options: [
    "-a, --multiple   support multiple arguments",
    "-s, --suffix=SUFFIX  remove a trailing SUFFIX",
    "    --help       display this help and exit"
  ]
};
var basenameCommand = {
  name: "basename",
  async execute(args, _ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(basenameHelp);
    }
    let multiple = false;
    let suffix = "";
    const names = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "-a" || arg === "--multiple") {
        multiple = true;
      } else if (arg === "-s" && i + 1 < args.length) {
        suffix = args[++i];
        multiple = true;
      } else if (arg.startsWith("--suffix=")) {
        suffix = arg.slice(9);
        multiple = true;
      } else if (!arg.startsWith("-")) {
        names.push(arg);
      }
    }
    if (names.length === 0) {
      return {
        stdout: "",
        stderr: "basename: missing operand\n",
        exitCode: 1
      };
    }
    if (!multiple && names.length >= 2) {
      suffix = names.pop() ?? "";
    }
    const results = [];
    for (const name of names) {
      const cleanName = name.replace(/\/+$/, "");
      let base = cleanName.split("/").pop() || cleanName;
      if (suffix && base.endsWith(suffix)) {
        base = base.slice(0, -suffix.length);
      }
      results.push(base);
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
  basenameCommand
};
