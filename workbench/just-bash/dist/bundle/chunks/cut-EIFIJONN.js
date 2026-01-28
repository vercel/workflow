import {
  readAndConcat
} from "./chunk-XTSQ6SVV.js";
import "./chunk-PRIRMCRG.js";
import {
  hasHelpFlag,
  showHelp,
  unknownOption
} from "./chunk-HAN5425M.js";
import {
  __name
} from "./chunk-Y7IWVHJ4.js";

// dist/commands/cut/cut.js
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
