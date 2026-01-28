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
var joinHelp = {
  name: "join",
  summary: "join lines of two files on a common field",
  usage: "join [OPTION]... FILE1 FILE2",
  description: "For each pair of input lines with identical join fields, write a line to standard output. The default join field is the first, delimited by blanks.",
  options: [
    "-1 FIELD     Join on this FIELD of file 1 (default: 1)",
    "-2 FIELD     Join on this FIELD of file 2 (default: 1)",
    "-t CHAR      Use CHAR as input and output field separator",
    "-a FILENUM   Also print unpairable lines from file FILENUM (1 or 2)",
    "-v FILENUM   Like -a but only output unpairable lines",
    "-e STRING    Replace missing fields with STRING",
    "-o FORMAT    Output format (comma-separated list of FILENUM.FIELD)",
    "-i           Ignore case when comparing fields"
  ],
  examples: [
    "join file1 file2               # Join on first field",
    "join -1 2 -2 1 file1 file2     # Join file1 col 2 with file2 col 1",
    "join -t ',' file1.csv file2.csv  # Join CSV files",
    "join -a 1 file1 file2          # Left outer join"
  ]
};
function splitLine(line, separator) {
  if (separator) {
    return line.split(separator);
  }
  return line.split(/[ \t]+/).filter((f) => f.length > 0);
}
__name(splitLine, "splitLine");
function parseLine(line, separator, joinField, ignoreCase) {
  const fields = splitLine(line, separator);
  let joinKey = fields[joinField - 1] ?? "";
  if (ignoreCase) {
    joinKey = joinKey.toLowerCase();
  }
  return { fields, joinKey, original: line };
}
__name(parseLine, "parseLine");
function formatOutputLine(line1, line2, options) {
  const sep = options.separator ?? " ";
  if (options.outputFormat) {
    const parts2 = [];
    for (const { file, field } of options.outputFormat) {
      const line = file === 1 ? line1 : line2;
      if (line && field === 0) {
        parts2.push(line.joinKey);
      } else if (line && line.fields[field - 1] !== void 0) {
        parts2.push(line.fields[field - 1]);
      } else {
        parts2.push(options.emptyString);
      }
    }
    return parts2.join(sep);
  }
  const parts = [];
  const joinField = line1?.joinKey ?? line2?.joinKey ?? "";
  parts.push(joinField);
  if (line1) {
    for (let i = 0; i < line1.fields.length; i++) {
      if (i !== options.field1 - 1) {
        parts.push(line1.fields[i]);
      }
    }
  }
  if (line2) {
    for (let i = 0; i < line2.fields.length; i++) {
      if (i !== options.field2 - 1) {
        parts.push(line2.fields[i]);
      }
    }
  }
  return parts.join(sep);
}
__name(formatOutputLine, "formatOutputLine");
function parseOutputFormat(format) {
  const parts = format.split(",");
  const result = [];
  for (const part of parts) {
    const match = part.trim().match(/^(\d+)\.(\d+)$/);
    if (!match) {
      return null;
    }
    const file = Number.parseInt(match[1], 10);
    const field = Number.parseInt(match[2], 10);
    if (file !== 1 && file !== 2) {
      return null;
    }
    result.push({ file, field });
  }
  return result;
}
__name(parseOutputFormat, "parseOutputFormat");
var join = {
  name: "join",
  execute: /* @__PURE__ */ __name(async (args, ctx) => {
    if (hasHelpFlag(args)) {
      return showHelp(joinHelp);
    }
    const options = {
      field1: 1,
      field2: 1,
      separator: null,
      printUnpairable: /* @__PURE__ */ new Set(),
      onlyUnpairable: /* @__PURE__ */ new Set(),
      emptyString: "",
      outputFormat: null,
      ignoreCase: false
    };
    const files = [];
    let i = 0;
    while (i < args.length) {
      const arg = args[i];
      if (arg === "-1" && i + 1 < args.length) {
        const field = Number.parseInt(args[i + 1], 10);
        if (Number.isNaN(field) || field < 1) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `join: invalid field number: '${args[i + 1]}'
`
          };
        }
        options.field1 = field;
        i += 2;
      } else if (arg === "-2" && i + 1 < args.length) {
        const field = Number.parseInt(args[i + 1], 10);
        if (Number.isNaN(field) || field < 1) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `join: invalid field number: '${args[i + 1]}'
`
          };
        }
        options.field2 = field;
        i += 2;
      } else if ((arg === "-t" || arg === "--field-separator") && i + 1 < args.length) {
        options.separator = args[i + 1];
        i += 2;
      } else if (arg.startsWith("-t") && arg.length > 2) {
        options.separator = arg.slice(2);
        i++;
      } else if (arg === "-a" && i + 1 < args.length) {
        const fileNum = Number.parseInt(args[i + 1], 10);
        if (fileNum !== 1 && fileNum !== 2) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `join: invalid file number: '${args[i + 1]}'
`
          };
        }
        options.printUnpairable.add(fileNum);
        i += 2;
      } else if (arg.match(/^-a[12]$/)) {
        options.printUnpairable.add(Number.parseInt(arg[2], 10));
        i++;
      } else if (arg === "-v" && i + 1 < args.length) {
        const fileNum = Number.parseInt(args[i + 1], 10);
        if (fileNum !== 1 && fileNum !== 2) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `join: invalid file number: '${args[i + 1]}'
`
          };
        }
        options.onlyUnpairable.add(fileNum);
        i += 2;
      } else if (arg.match(/^-v[12]$/)) {
        options.onlyUnpairable.add(Number.parseInt(arg[2], 10));
        i++;
      } else if (arg === "-e" && i + 1 < args.length) {
        options.emptyString = args[i + 1];
        i += 2;
      } else if (arg === "-o" && i + 1 < args.length) {
        const format = parseOutputFormat(args[i + 1]);
        if (!format) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `join: invalid field spec: '${args[i + 1]}'
`
          };
        }
        options.outputFormat = format;
        i += 2;
      } else if (arg === "-i" || arg === "--ignore-case") {
        options.ignoreCase = true;
        i++;
      } else if (arg === "--") {
        files.push(...args.slice(i + 1));
        break;
      } else if (arg.startsWith("-") && arg !== "-") {
        return unknownOption("join", arg);
      } else {
        files.push(arg);
        i++;
      }
    }
    if (files.length !== 2) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: files.length < 2 ? "join: missing file operand\n" : "join: extra operand\n"
      };
    }
    const contents = [];
    for (const file of files) {
      if (file === "-") {
        contents.push(ctx.stdin ?? "");
      } else {
        const filePath = ctx.fs.resolvePath(ctx.cwd, file);
        const content = await ctx.fs.readFile(filePath);
        if (content === null) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `join: ${file}: No such file or directory
`
          };
        }
        contents.push(content);
      }
    }
    const parseLines = /* @__PURE__ */ __name((content, joinField) => {
      const lines = content.split("\n");
      if (content.endsWith("\n") && lines[lines.length - 1] === "") {
        lines.pop();
      }
      return lines.filter((line) => line.length > 0).map((line) => parseLine(line, options.separator, joinField, options.ignoreCase));
    }, "parseLines");
    const lines1 = parseLines(contents[0], options.field1);
    const lines2 = parseLines(contents[1], options.field2);
    const index2 = /* @__PURE__ */ new Map();
    for (const line of lines2) {
      const existing = index2.get(line.joinKey);
      if (existing) {
        existing.push(line);
      } else {
        index2.set(line.joinKey, [line]);
      }
    }
    const output = [];
    const matchedKeys2 = /* @__PURE__ */ new Set();
    for (const line1 of lines1) {
      const matches = index2.get(line1.joinKey);
      if (matches && matches.length > 0) {
        matchedKeys2.add(line1.joinKey);
        if (options.onlyUnpairable.size === 0) {
          for (const line2 of matches) {
            output.push(formatOutputLine(line1, line2, options));
          }
        }
      } else {
        if (options.printUnpairable.has(1) || options.onlyUnpairable.has(1)) {
          output.push(formatOutputLine(line1, null, options));
        }
      }
    }
    if (options.printUnpairable.has(2) || options.onlyUnpairable.has(2)) {
      for (const line2 of lines2) {
        if (!matchedKeys2.has(line2.joinKey)) {
          output.push(formatOutputLine(null, line2, options));
        }
      }
    }
    return {
      exitCode: 0,
      stdout: output.length > 0 ? `${output.join("\n")}
` : "",
      stderr: ""
    };
  }, "execute")
};
export {
  join
};
