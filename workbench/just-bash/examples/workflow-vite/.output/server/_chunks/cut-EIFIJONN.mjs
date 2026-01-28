import { a as readAndConcat } from "./chunk-XTSQ6SVV.mjs";
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
var cutHelp = {
  name: "cut",
  summary: "remove sections from each line of files",
  usage: "cut [OPTION]... [FILE]...",
  options: [
    "-c LIST              select only these characters",
    "-d DELIM             use DELIM instead of TAB for field delimiter",
    "-f LIST              select only these fields",
    "-s, --only-delimited  do not print lines without delimiters",
    "    --help           display this help and exit"
  ]
};
function parseRange(spec) {
  const ranges = [];
  const parts = spec.split(",");
  for (const part of parts) {
    if (part.includes("-")) {
      const [start, end] = part.split("-");
      ranges.push({
        start: start ? parseInt(start, 10) : 1,
        end: end ? parseInt(end, 10) : null
      });
    } else {
      const num = parseInt(part, 10);
      ranges.push({ start: num, end: num });
    }
  }
  return ranges;
}
__name(parseRange, "parseRange");
function extractByRanges(items, ranges) {
  const result = [];
  for (const range of ranges) {
    const start = range.start - 1;
    const end = range.end === null ? items.length : range.end;
    for (let i = start; i < end && i < items.length; i++) {
      if (i >= 0 && !result.includes(items[i])) {
        result.push(items[i]);
      }
    }
  }
  return result;
}
__name(extractByRanges, "extractByRanges");
var cutCommand = {
  name: "cut",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(cutHelp);
    }
    let delimiter = "	";
    let fieldSpec = null;
    let charSpec = null;
    let suppressNoDelim = false;
    const files = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "-d") {
        delimiter = args[++i] || "	";
      } else if (arg.startsWith("-d")) {
        delimiter = arg.slice(2);
      } else if (arg === "-f") {
        fieldSpec = args[++i];
      } else if (arg.startsWith("-f")) {
        fieldSpec = arg.slice(2);
      } else if (arg === "-c") {
        charSpec = args[++i];
      } else if (arg.startsWith("-c")) {
        charSpec = arg.slice(2);
      } else if (arg === "-s" || arg === "--only-delimited") {
        suppressNoDelim = true;
      } else if (arg.startsWith("--")) {
        return unknownOption("cut", arg);
      } else if (arg.startsWith("-")) {
        let unknown = false;
        for (const c of arg.slice(1)) {
          if (c === "s") {
            suppressNoDelim = true;
          } else if (!"dfc".includes(c)) {
            unknown = true;
            break;
          }
        }
        if (unknown) {
          return unknownOption("cut", arg);
        }
      } else {
        files.push(arg);
      }
    }
    if (!fieldSpec && !charSpec) {
      return {
        stdout: "",
        stderr: "cut: you must specify a list of bytes, characters, or fields\n",
        exitCode: 1
      };
    }
    const readResult = await readAndConcat(ctx, files, { cmdName: "cut" });
    if (!readResult.ok)
      return readResult.error;
    const content = readResult.content;
    const lines = content.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    const ranges = parseRange(fieldSpec || charSpec || "1");
    let output = "";
    for (const line of lines) {
      if (charSpec) {
        const chars = line.split("");
        const selected = [];
        for (const range of ranges) {
          const start = range.start - 1;
          const end = range.end === null ? chars.length : range.end;
          for (let i = start; i < end && i < chars.length; i++) {
            if (i >= 0) {
              selected.push(chars[i]);
            }
          }
        }
        output += `${selected.join("")}
`;
      } else {
        if (suppressNoDelim && !line.includes(delimiter)) {
          continue;
        }
        const fields = line.split(delimiter);
        const selected = extractByRanges(fields, ranges);
        output += `${selected.join(delimiter)}
`;
      }
    }
    return { stdout: output, stderr: "", exitCode: 0 };
  }
};
export {
  cutCommand
};
