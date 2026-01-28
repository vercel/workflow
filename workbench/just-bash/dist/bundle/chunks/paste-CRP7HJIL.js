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

// dist/commands/paste/paste.js
var pasteHelp = {
  name: "paste",
  summary: "merge lines of files",
  usage: "paste [OPTION]... [FILE]...",
  description: [
    "Write lines consisting of the sequentially corresponding lines from",
    "each FILE, separated by TABs, to standard output.",
    "",
    "With no FILE, or when FILE is -, read standard input."
  ],
  options: [
    "-d, --delimiters=LIST   reuse characters from LIST instead of TABs",
    "-s, --serial            paste one file at a time instead of in parallel",
    "    --help              display this help and exit"
  ],
  examples: [
    "paste file1 file2       Merge file1 and file2 side by side",
    "paste -d, file1 file2   Use comma as delimiter",
    "paste -s file1          Paste all lines of file1 on one line",
    "paste - - < file        Paste pairs of lines from file"
  ]
};
var argDefs = {
  delimiter: {
    short: "d",
    long: "delimiters",
    type: "string",
    default: "	"
  },
  serial: { short: "s", long: "serial", type: "boolean" }
};
var pasteCommand = {
  name: "paste",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(pasteHelp);
    }
    const parsed = parseArgs("paste", args, argDefs);
    if (!parsed.ok)
      return parsed.error;
    const delimiter = parsed.result.flags.delimiter;
    const serial = parsed.result.flags.serial;
    const files = parsed.result.positional;
    if (files.length === 0) {
      return {
        stdout: "",
        stderr: "usage: paste [-s] [-d delimiters] file ...\n",
        exitCode: 1
      };
    }
    const stdinLines = ctx.stdin ? ctx.stdin.split("\n") : [""];
    if (stdinLines.length > 0 && stdinLines[stdinLines.length - 1] === "") {
      stdinLines.pop();
    }
    const stdinCount = files.filter((f) => f === "-").length;
    const fileContents = [];
    let stdinIndex = 0;
    for (const file of files) {
      if (file === "-") {
        const thisStdinLines = [];
        for (let i = stdinIndex; i < stdinLines.length; i += stdinCount) {
          thisStdinLines.push(stdinLines[i]);
        }
        fileContents.push(thisStdinLines);
        stdinIndex++;
      } else {
        const filePath = ctx.fs.resolvePath(ctx.cwd, file);
        try {
          const content = await ctx.fs.readFile(filePath);
          const lines = content.split("\n");
          if (lines.length > 0 && lines[lines.length - 1] === "") {
            lines.pop();
          }
          fileContents.push(lines);
        } catch {
          return {
            stdout: "",
            stderr: `paste: ${file}: No such file or directory
`,
            exitCode: 1
          };
        }
      }
    }
    let output = "";
    if (serial) {
      for (const lines of fileContents) {
        if (lines) {
          output += `${joinWithDelimiters(lines, delimiter)}
`;
        }
      }
    } else {
      const maxLines = Math.max(...fileContents.map((f) => f?.length ?? 0));
      for (let lineIdx = 0; lineIdx < maxLines; lineIdx++) {
        const lineParts = [];
        for (const lines of fileContents) {
          lineParts.push(lines?.[lineIdx] ?? "");
        }
        output += `${joinWithDelimiters(lineParts, delimiter)}
`;
      }
    }
    return { stdout: output, stderr: "", exitCode: 0 };
  }
};
function joinWithDelimiters(parts, delimiters) {
  if (parts.length === 0)
    return "";
  if (parts.length === 1)
    return parts[0];
  let result = parts[0];
  for (let i = 1; i < parts.length; i++) {
    const delimIdx = (i - 1) % delimiters.length;
    result += delimiters[delimIdx] + parts[i];
  }
  return result;
}
__name(joinWithDelimiters, "joinWithDelimiters");
export {
  pasteCommand
};
