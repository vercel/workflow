import {
  parseArgs
} from "./chunk-5NTVBLMJ.js";
import {
  hasHelpFlag,
  showHelp
} from "./chunk-HAN5425M.js";
import {
  __name
} from "./chunk-Y7IWVHJ4.js";

// dist/commands/column/column.js
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
