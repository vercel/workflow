import {
  readAndConcat
} from "./chunk-XTSQ6SVV.js";
import "./chunk-PRIRMCRG.js";
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

// dist/commands/uniq/uniq.js
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
