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
var columnHelp = {
  name: "column",
  summary: "columnate lists",
  usage: "column [OPTION]... [FILE]...",
  description: "Format input into multiple columns. By default, fills rows first. Use -t to create a table based on whitespace-delimited input.",
  options: [
    "-t           Create a table (determine columns from input)",
    "-s SEP       Input field delimiter (default: whitespace)",
    "-o SEP       Output field delimiter (default: two spaces)",
    "-c WIDTH     Output width for fill mode (default: 80)",
    "-n           Don't merge multiple adjacent delimiters"
  ],
  examples: [
    "ls | column              # Fill columns with ls output",
    "cat data | column -t     # Format as table",
    "column -t -s ',' file    # Format CSV as table",
    "column -c 40 file        # Fill 40-char wide columns"
  ]
};
var argDefs = {
  table: { short: "t", long: "table", type: "boolean" },
  separator: { short: "s", type: "string" },
  outputSep: { short: "o", type: "string" },
  width: { short: "c", type: "number", default: 80 },
  noMerge: { short: "n", type: "boolean" }
};
function splitFields(line, separator, noMerge) {
  if (separator) {
    if (noMerge) {
      return line.split(separator);
    }
    return line.split(separator).filter((f) => f.length > 0);
  }
  if (noMerge) {
    return line.split(/[ \t]/);
  }
  return line.split(/[ \t]+/).filter((f) => f.length > 0);
}
__name(splitFields, "splitFields");
function calculateColumnWidths(rows) {
  const widths = [];
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      const cellWidth = row[i].length;
      if (widths[i] === void 0 || cellWidth > widths[i]) {
        widths[i] = cellWidth;
      }
    }
  }
  return widths;
}
__name(calculateColumnWidths, "calculateColumnWidths");
function formatTable(rows, outputSep) {
  if (rows.length === 0)
    return "";
  const widths = calculateColumnWidths(rows);
  const lines = [];
  for (const row of rows) {
    const cells = [];
    for (let i = 0; i < row.length; i++) {
      if (i === row.length - 1) {
        cells.push(row[i]);
      } else {
        cells.push(row[i].padEnd(widths[i]));
      }
    }
    lines.push(cells.join(outputSep));
  }
  return lines.join("\n");
}
__name(formatTable, "formatTable");
function formatFill(items, width, outputSep) {
  if (items.length === 0)
    return "";
  const maxItemWidth = Math.max(...items.map((item) => item.length));
  const sepWidth = outputSep.length;
  const columnWidth = maxItemWidth + sepWidth;
  const numColumns = Math.max(1, Math.floor((width + sepWidth) / columnWidth));
  const numRows = Math.ceil(items.length / numColumns);
  const lines = [];
  for (let row = 0; row < numRows; row++) {
    const cells = [];
    for (let col = 0; col < numColumns; col++) {
      const index = col * numRows + row;
      if (index < items.length) {
        const isLastInRow = col === numColumns - 1 || (col + 1) * numRows + row >= items.length;
        if (isLastInRow) {
          cells.push(items[index]);
        } else {
          cells.push(items[index].padEnd(maxItemWidth));
        }
      }
    }
    lines.push(cells.join(outputSep));
  }
  return lines.join("\n");
}
__name(formatFill, "formatFill");
var column = {
  name: "column",
  execute: /* @__PURE__ */ __name(async (args, ctx) => {
    if (hasHelpFlag(args)) {
      return showHelp(columnHelp);
    }
    const parsed = parseArgs("column", args, argDefs);
    if (!parsed.ok)
      return parsed.error;
    const { table, separator, outputSep, width, noMerge } = parsed.result.flags;
    const files = parsed.result.positional;
    const outSep = outputSep ?? "  ";
    let content;
    if (files.length === 0) {
      content = ctx.stdin ?? "";
    } else {
      const parts = [];
      for (const file of files) {
        if (file === "-") {
          parts.push(ctx.stdin ?? "");
        } else {
          const filePath = ctx.fs.resolvePath(ctx.cwd, file);
          const fileContent = await ctx.fs.readFile(filePath);
          if (fileContent === null) {
            return {
              exitCode: 1,
              stdout: "",
              stderr: `column: ${file}: No such file or directory
`
            };
          }
          parts.push(fileContent);
        }
      }
      content = parts.join("");
    }
    if (content === "" || content.trim() === "") {
      return {
        exitCode: 0,
        stdout: "",
        stderr: ""
      };
    }
    const lines = content.split("\n");
    const hasTrailingNewline = content.endsWith("\n") && lines[lines.length - 1] === "";
    if (hasTrailingNewline) {
      lines.pop();
    }
    const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
    let output;
    if (table) {
      const rows = nonEmptyLines.map((line) => splitFields(line, separator, noMerge));
      output = formatTable(rows, outSep);
    } else {
      const items = [];
      for (const line of nonEmptyLines) {
        const fields = splitFields(line, separator, noMerge);
        items.push(...fields);
      }
      output = formatFill(items, width, outSep);
    }
    if (output.length > 0) {
      output += "\n";
    }
    return {
      exitCode: 0,
      stdout: output,
      stderr: ""
    };
  }, "execute")
};
export {
  column
};
