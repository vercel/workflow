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
async function tacExecute(args, ctx) {
  if (args.length > 0 && args[0] !== "-") {
    const filePath = args[0].startsWith("/") ? args[0] : `${ctx.cwd}/${args[0]}`;
    try {
      const content = await ctx.fs.readFile(filePath);
      const lines2 = content.split("\n");
      if (lines2[lines2.length - 1] === "") {
        lines2.pop();
      }
      const reversed2 = lines2.reverse();
      return {
        stdout: reversed2.length > 0 ? `${reversed2.join("\n")}
` : "",
        stderr: "",
        exitCode: 0
      };
    } catch {
      return {
        stdout: "",
        stderr: `tac: ${args[0]}: No such file or directory
`,
        exitCode: 1
      };
    }
  }
  const lines = ctx.stdin.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  const reversed = lines.reverse();
  return {
    stdout: reversed.length > 0 ? `${reversed.join("\n")}
` : "",
    stderr: "",
    exitCode: 0
  };
}
__name(tacExecute, "tacExecute");
var tac = {
  name: "tac",
  execute: tacExecute
};
export {
  tac
};
