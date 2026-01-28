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
async function odExecute(args, ctx) {
  let addressMode = "octal";
  const outputFormats = [];
  const fileArgs = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-c") {
      outputFormats.push("char");
    } else if (arg === "-An" || arg === "-A" && args[i + 1] === "n") {
      addressMode = "none";
      if (arg === "-A")
        i++;
    } else if (arg === "-t" && args[i + 1]) {
      const format = args[++i];
      if (format === "x1") {
        outputFormats.push("hex");
      } else if (format === "c") {
        outputFormats.push("char");
      } else if (format.startsWith("o")) {
        outputFormats.push("octal");
      }
    } else if (!arg.startsWith("-") || arg === "-") {
      fileArgs.push(arg);
    }
  }
  if (outputFormats.length === 0) {
    outputFormats.push("octal");
  }
  let input = ctx.stdin;
  if (fileArgs.length > 0 && fileArgs[0] !== "-") {
    const filePath = fileArgs[0].startsWith("/") ? fileArgs[0] : `${ctx.cwd}/${fileArgs[0]}`;
    try {
      input = await ctx.fs.readFile(filePath);
    } catch {
      return {
        stdout: "",
        stderr: `od: ${fileArgs[0]}: No such file or directory
`,
        exitCode: 1
      };
    }
  }
  const hasCharFormat = outputFormats.includes("char");
  function formatCharByte(code) {
    if (code === 0)
      return "  \\0";
    if (code === 7)
      return "  \\a";
    if (code === 8)
      return "  \\b";
    if (code === 9)
      return "  \\t";
    if (code === 10)
      return "  \\n";
    if (code === 11)
      return "  \\v";
    if (code === 12)
      return "  \\f";
    if (code === 13)
      return "  \\r";
    if (code >= 32 && code < 127) {
      return `   ${String.fromCharCode(code)}`;
    }
    return ` ${code.toString(8).padStart(3, "0")}`;
  }
  __name(formatCharByte, "formatCharByte");
  function formatHexByte(code) {
    if (hasCharFormat) {
      return `  ${code.toString(16).padStart(2, "0")}`;
    }
    return ` ${code.toString(16).padStart(2, "0")}`;
  }
  __name(formatHexByte, "formatHexByte");
  function formatOctalByte(code) {
    return ` ${code.toString(8).padStart(3, "0")}`;
  }
  __name(formatOctalByte, "formatOctalByte");
  const bytes = [];
  for (const char of input) {
    bytes.push(char.charCodeAt(0));
  }
  const bytesPerLine = 16;
  const lines = [];
  for (let offset = 0; offset < bytes.length; offset += bytesPerLine) {
    const chunkBytes = bytes.slice(offset, offset + bytesPerLine);
    for (let formatIdx = 0; formatIdx < outputFormats.length; formatIdx++) {
      const format = outputFormats[formatIdx];
      let formatted;
      if (format === "char") {
        formatted = chunkBytes.map(formatCharByte);
      } else if (format === "hex") {
        formatted = chunkBytes.map(formatHexByte);
      } else {
        formatted = chunkBytes.map(formatOctalByte);
      }
      let prefix = "";
      if (formatIdx === 0 && addressMode !== "none") {
        prefix = `${offset.toString(8).padStart(7, "0")} `;
      } else if (formatIdx > 0 || addressMode === "none") {
        prefix = addressMode === "none" ? "" : "        ";
      }
      lines.push(prefix + formatted.join(""));
    }
  }
  if (addressMode !== "none" && bytes.length > 0) {
    lines.push(bytes.length.toString(8).padStart(7, "0"));
  }
  return {
    stdout: lines.length > 0 ? `${lines.join("\n")}
` : "",
    stderr: "",
    exitCode: 0
  };
}
__name(odExecute, "odExecute");
var od = {
  name: "od",
  execute: odExecute
};
export {
  od
};
