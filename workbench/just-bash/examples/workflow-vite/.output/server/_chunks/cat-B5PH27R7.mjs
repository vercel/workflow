import { r as readFiles } from "./chunk-XTSQ6SVV.mjs";
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
var catHelp = {
  name: "cat",
  summary: "concatenate files and print on the standard output",
  usage: "cat [OPTION]... [FILE]...",
  options: [
    "-n, --number           number all output lines",
    "    --help             display this help and exit"
  ]
};
var argDefs = {
  number: { short: "n", long: "number", type: "boolean" }
};
var catCommand = {
  name: "cat",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(catHelp);
    }
    const parsed = parseArgs("cat", args, argDefs);
    if (!parsed.ok)
      return parsed.error;
    const showLineNumbers = parsed.result.flags.number;
    const files = parsed.result.positional;
    const readResult = await readFiles(ctx, files, {
      cmdName: "cat",
      allowStdinMarker: true,
      stopOnError: false
    });
    let stdout = "";
    let lineNumber = 1;
    for (const { content } of readResult.files) {
      if (showLineNumbers) {
        const result = addLineNumbers(content, lineNumber);
        stdout += result.content;
        lineNumber = result.nextLineNumber;
      } else {
        stdout += content;
      }
    }
    return { stdout, stderr: readResult.stderr, exitCode: readResult.exitCode };
  }
};
function addLineNumbers(content, startLine) {
  const lines = content.split("\n");
  const hasTrailingNewline = content.endsWith("\n");
  const linesToNumber = hasTrailingNewline ? lines.slice(0, -1) : lines;
  const numbered = linesToNumber.map((line, i) => {
    const num = String(startLine + i).padStart(6, " ");
    return `${num}	${line}`;
  });
  return {
    content: numbered.join("\n") + (hasTrailingNewline ? "\n" : ""),
    nextLineNumber: startLine + linesToNumber.length
  };
}
__name(addLineNumbers, "addLineNumbers");
export {
  catCommand
};
