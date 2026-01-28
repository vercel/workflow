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
var nlHelp = {
  name: "nl",
  summary: "number lines of files",
  usage: "nl [OPTION]... [FILE]...",
  description: "Write each FILE to standard output, with line numbers added. If no FILE is specified, standard input is read.",
  options: [
    "-b STYLE     Body numbering style: a (all), t (non-empty), n (none)",
    "-n FORMAT    Number format: ln (left), rn (right), rz (right zeros)",
    "-w WIDTH     Number width (default: 6)",
    "-s SEP       Separator after number (default: TAB)",
    "-v START     Starting line number (default: 1)",
    "-i INCR      Line number increment (default: 1)"
  ],
  examples: [
    "nl file.txt              # Number non-empty lines",
    "nl -ba file.txt          # Number all lines",
    "nl -n rz -w 3 file.txt   # Right-justified with zeros",
    "nl -s ': ' file.txt      # Use ': ' as separator"
  ]
};
function formatLineNumber(num, format, width) {
  const numStr = String(num);
  switch (format) {
    case "ln":
      return numStr.padEnd(width);
    case "rn":
      return numStr.padStart(width);
    case "rz":
      return numStr.padStart(width, "0");
    default: {
      const _exhaustive = format;
      return _exhaustive;
    }
  }
}
__name(formatLineNumber, "formatLineNumber");
function shouldNumber(line, style) {
  switch (style) {
    case "a":
      return true;
    case "t":
      return line.trim().length > 0;
    case "n":
      return false;
    default: {
      const _exhaustive = style;
      return _exhaustive;
    }
  }
}
__name(shouldNumber, "shouldNumber");
function processContent(content, options, currentNumber) {
  if (content === "") {
    return { output: "", nextNumber: currentNumber };
  }
  const lines = content.split("\n");
  const resultLines = [];
  let lineNumber = currentNumber;
  const hasTrailingNewline = content.endsWith("\n") && lines[lines.length - 1] === "";
  if (hasTrailingNewline) {
    lines.pop();
  }
  for (const line of lines) {
    if (shouldNumber(line, options.bodyStyle)) {
      const formattedNum = formatLineNumber(lineNumber, options.numberFormat, options.width);
      resultLines.push(`${formattedNum}${options.separator}${line}`);
      lineNumber += options.increment;
    } else {
      const padding = " ".repeat(options.width);
      resultLines.push(`${padding}${options.separator}${line}`);
    }
  }
  return {
    output: resultLines.join("\n") + (hasTrailingNewline ? "\n" : ""),
    nextNumber: lineNumber
  };
}
__name(processContent, "processContent");
var nl = {
  name: "nl",
  execute: /* @__PURE__ */ __name(async (args, ctx) => {
    if (hasHelpFlag(args)) {
      return showHelp(nlHelp);
    }
    const options = {
      bodyStyle: "t",
      numberFormat: "rn",
      width: 6,
      separator: "	",
      startNumber: 1,
      increment: 1
    };
    const files = [];
    let i = 0;
    while (i < args.length) {
      const arg = args[i];
      if (arg === "-b" && i + 1 < args.length) {
        const style = args[i + 1];
        if (style !== "a" && style !== "t" && style !== "n") {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `nl: invalid body numbering style: '${style}'
`
          };
        }
        options.bodyStyle = style;
        i += 2;
      } else if (arg.startsWith("-b")) {
        const style = arg.slice(2);
        if (style !== "a" && style !== "t" && style !== "n") {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `nl: invalid body numbering style: '${style}'
`
          };
        }
        options.bodyStyle = style;
        i++;
      } else if (arg === "-n" && i + 1 < args.length) {
        const format = args[i + 1];
        if (format !== "ln" && format !== "rn" && format !== "rz") {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `nl: invalid line numbering format: '${format}'
`
          };
        }
        options.numberFormat = format;
        i += 2;
      } else if (arg.startsWith("-n")) {
        const format = arg.slice(2);
        if (format !== "ln" && format !== "rn" && format !== "rz") {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `nl: invalid line numbering format: '${format}'
`
          };
        }
        options.numberFormat = format;
        i++;
      } else if (arg === "-w" && i + 1 < args.length) {
        const width = parseInt(args[i + 1], 10);
        if (Number.isNaN(width) || width < 1) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `nl: invalid line number field width: '${args[i + 1]}'
`
          };
        }
        options.width = width;
        i += 2;
      } else if (arg.startsWith("-w")) {
        const width = parseInt(arg.slice(2), 10);
        if (Number.isNaN(width) || width < 1) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `nl: invalid line number field width: '${arg.slice(2)}'
`
          };
        }
        options.width = width;
        i++;
      } else if (arg === "-s" && i + 1 < args.length) {
        options.separator = args[i + 1];
        i += 2;
      } else if (arg.startsWith("-s")) {
        options.separator = arg.slice(2);
        i++;
      } else if (arg === "-v" && i + 1 < args.length) {
        const start = parseInt(args[i + 1], 10);
        if (Number.isNaN(start)) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `nl: invalid starting line number: '${args[i + 1]}'
`
          };
        }
        options.startNumber = start;
        i += 2;
      } else if (arg.startsWith("-v")) {
        const start = parseInt(arg.slice(2), 10);
        if (Number.isNaN(start)) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `nl: invalid starting line number: '${arg.slice(2)}'
`
          };
        }
        options.startNumber = start;
        i++;
      } else if (arg === "-i" && i + 1 < args.length) {
        const incr = parseInt(args[i + 1], 10);
        if (Number.isNaN(incr)) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `nl: invalid line number increment: '${args[i + 1]}'
`
          };
        }
        options.increment = incr;
        i += 2;
      } else if (arg.startsWith("-i")) {
        const incr = parseInt(arg.slice(2), 10);
        if (Number.isNaN(incr)) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `nl: invalid line number increment: '${arg.slice(2)}'
`
          };
        }
        options.increment = incr;
        i++;
      } else if (arg === "--") {
        files.push(...args.slice(i + 1));
        break;
      } else if (arg.startsWith("-") && arg !== "-") {
        return unknownOption("nl", arg);
      } else {
        files.push(arg);
        i++;
      }
    }
    let output = "";
    let lineNumber = options.startNumber;
    if (files.length === 0) {
      const input = ctx.stdin ?? "";
      const result = processContent(input, options, lineNumber);
      output = result.output;
    } else {
      for (const file of files) {
        const filePath = ctx.fs.resolvePath(ctx.cwd, file);
        const content = await ctx.fs.readFile(filePath);
        if (content === null) {
          return {
            exitCode: 1,
            stdout: output,
            stderr: `nl: ${file}: No such file or directory
`
          };
        }
        const result = processContent(content, options, lineNumber);
        output += result.output;
        lineNumber = result.nextNumber;
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
  nl
};
