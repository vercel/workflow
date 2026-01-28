import { p as parseArgs } from "./chunk-5NTVBLMJ.mjs";
import { h as hasHelpFlag, s as showHelp } from "./chunk-HAN5425M.mjs";
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
var base64Help = {
  name: "base64",
  summary: "base64 encode/decode data and print to standard output",
  usage: "base64 [OPTION]... [FILE]",
  options: [
    "-d, --decode    decode data",
    "-w, --wrap=COLS wrap encoded lines after COLS character (default 76, 0 to disable)",
    "    --help      display this help and exit"
  ]
};
var argDefs = {
  decode: { short: "d", long: "decode", type: "boolean" },
  wrap: { short: "w", long: "wrap", type: "number", default: 76 }
};
async function readBinary(ctx, files, cmdName) {
  if (files.length === 0 || files.length === 1 && files[0] === "-") {
    return {
      ok: true,
      data: Uint8Array.from(ctx.stdin, (c) => c.charCodeAt(0))
    };
  }
  const chunks = [];
  for (const file of files) {
    if (file === "-") {
      chunks.push(Uint8Array.from(ctx.stdin, (c) => c.charCodeAt(0)));
      continue;
    }
    try {
      const filePath = ctx.fs.resolvePath(ctx.cwd, file);
      const data = await ctx.fs.readFileBuffer(filePath);
      chunks.push(data);
    } catch {
      return {
        ok: false,
        error: {
          stdout: "",
          stderr: `${cmdName}: ${file}: No such file or directory
`,
          exitCode: 1
        }
      };
    }
  }
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return { ok: true, data: result };
}
__name(readBinary, "readBinary");
var base64Command = {
  name: "base64",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(base64Help);
    }
    const parsed = parseArgs("base64", args, argDefs);
    if (!parsed.ok)
      return parsed.error;
    const decode = parsed.result.flags.decode;
    const wrapCols = parsed.result.flags.wrap;
    const files = parsed.result.positional;
    try {
      if (decode) {
        const readResult2 = await readBinary(ctx, files, "base64");
        if (!readResult2.ok)
          return readResult2.error;
        const input = String.fromCharCode(...readResult2.data);
        const cleaned = input.replace(/\s/g, "");
        const decoded = atob(cleaned);
        return { stdout: decoded, stderr: "", exitCode: 0 };
      }
      const readResult = await readBinary(ctx, files, "base64");
      if (!readResult.ok)
        return readResult.error;
      let encoded = btoa(String.fromCharCode(...readResult.data));
      if (wrapCols > 0) {
        const lines = [];
        for (let i = 0; i < encoded.length; i += wrapCols) {
          lines.push(encoded.slice(i, i + wrapCols));
        }
        encoded = lines.join("\n") + (encoded.length > 0 ? "\n" : "");
      }
      return { stdout: encoded, stderr: "", exitCode: 0 };
    } catch {
      return { stdout: "", stderr: "base64: invalid input\n", exitCode: 1 };
    }
  }
};
export {
  base64Command
};
