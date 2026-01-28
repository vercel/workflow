import { a as readAndConcat } from "./chunk-XTSQ6SVV.mjs";
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
var uniqHelp = {
  name: "uniq",
  summary: "report or omit repeated lines",
  usage: "uniq [OPTION]... [INPUT [OUTPUT]]",
  options: [
    "-c, --count        prefix lines by the number of occurrences",
    "-d, --repeated     only print duplicate lines",
    "-i, --ignore-case  ignore case when comparing",
    "-u, --unique       only print unique lines",
    "    --help         display this help and exit"
  ]
};
var argDefs = {
  count: { short: "c", long: "count", type: "boolean" },
  duplicatesOnly: { short: "d", long: "repeated", type: "boolean" },
  uniqueOnly: { short: "u", long: "unique", type: "boolean" },
  ignoreCase: { short: "i", long: "ignore-case", type: "boolean" }
};
var uniqCommand = {
  name: "uniq",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(uniqHelp);
    }
    const parsed = parseArgs("uniq", args, argDefs);
    if (!parsed.ok)
      return parsed.error;
    const { count, duplicatesOnly, uniqueOnly, ignoreCase } = parsed.result.flags;
    const files = parsed.result.positional;
    const readResult = await readAndConcat(ctx, files, { cmdName: "uniq" });
    if (!readResult.ok)
      return readResult.error;
    const content = readResult.content;
    const lines = content.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    if (lines.length === 0) {
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    const result = [];
    let currentLine = lines[0];
    let currentCount = 1;
    const compareLines = /* @__PURE__ */ __name((a, b) => {
      if (ignoreCase) {
        return a.toLowerCase() === b.toLowerCase();
      }
      return a === b;
    }, "compareLines");
    for (let i = 1; i < lines.length; i++) {
      if (compareLines(lines[i], currentLine)) {
        currentCount++;
      } else {
        result.push({ line: currentLine, count: currentCount });
        currentLine = lines[i];
        currentCount = 1;
      }
    }
    result.push({ line: currentLine, count: currentCount });
    let filtered = result;
    if (duplicatesOnly) {
      filtered = result.filter((r) => r.count > 1);
    } else if (uniqueOnly) {
      filtered = result.filter((r) => r.count === 1);
    }
    let output = "";
    for (const { line, count: c } of filtered) {
      if (count) {
        output += `${String(c).padStart(4)} ${line}
`;
      } else {
        output += `${line}
`;
      }
    }
    return { stdout: output, stderr: "", exitCode: 0 };
  }
};
export {
  uniqCommand
};
