import { h as hasHelpFlag, s as showHelp, u as unknownOption } from "./chunk-HAN5425M.mjs";
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
var revHelp = {
  name: "rev",
  summary: "reverse lines characterwise",
  usage: "rev [file ...]",
  description: "Copies the specified files to standard output, reversing the order of characters in every line. If no files are specified, standard input is read.",
  examples: [
    "echo 'hello' | rev     # Output: olleh",
    "rev file.txt           # Reverse each line in file"
  ]
};
function reverseString(str) {
  return Array.from(str).reverse().join("");
}
__name(reverseString, "reverseString");
var rev = {
  name: "rev",
  execute: /* @__PURE__ */ __name(async (args, ctx) => {
    if (hasHelpFlag(args)) {
      return showHelp(revHelp);
    }
    const files = [];
    for (const arg of args) {
      if (arg === "--") {
        const idx = args.indexOf(arg);
        files.push(...args.slice(idx + 1));
        break;
      } else if (arg.startsWith("-") && arg !== "-") {
        return unknownOption("rev", arg);
      } else {
        files.push(arg);
      }
    }
    let output = "";
    const processContent = /* @__PURE__ */ __name((content) => {
      const lines = content.split("\n");
      const hasTrailingNewline = content.endsWith("\n") && lines[lines.length - 1] === "";
      if (hasTrailingNewline) {
        lines.pop();
      }
      const reversed = lines.map(reverseString);
      return reversed.join("\n") + (hasTrailingNewline ? "\n" : "");
    }, "processContent");
    if (files.length === 0) {
      const input = ctx.stdin ?? "";
      output = processContent(input);
    } else {
      for (const file of files) {
        if (file === "-") {
          const input = ctx.stdin ?? "";
          output += processContent(input);
        } else {
          const filePath = ctx.fs.resolvePath(ctx.cwd, file);
          const content = await ctx.fs.readFile(filePath);
          if (content === null) {
            return {
              exitCode: 1,
              stdout: output,
              stderr: `rev: ${file}: No such file or directory
`
            };
          }
          output += processContent(content);
        }
      }
    }
    return {
      exitCode: 0,
      stdout: output,
      stderr: ""
    };
  }, "execute")
};
export {
  rev
};
