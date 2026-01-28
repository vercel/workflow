import {
  hasHelpFlag,
  showHelp,
  unknownOption
} from "./chunk-HAN5425M.js";
import {
  __name
} from "./chunk-Y7IWVHJ4.js";

// dist/commands/fold/fold.js
var foldHelp = {
  name: "fold",
  summary: "wrap each input line to fit in specified width",
  usage: "fold [OPTION]... [FILE]...",
  description: "Wrap input lines in each FILE, writing to standard output. If no FILE is specified, standard input is read.",
  options: [
    "-w WIDTH    Use WIDTH columns instead of 80",
    "-s          Break at spaces",
    "-b          Count bytes rather than columns"
  ],
  examples: [
    "fold -w 40 file.txt           # Wrap at 40 columns",
    "fold -sw 40 file.txt          # Word wrap at 40 columns",
    "echo 'long line' | fold -w 5  # Force wrap at 5"
  ]
};
function getCharWidth(char, currentColumn, countBytes) {
  if (countBytes) {
    return new TextEncoder().encode(char).length;
  }
  if (char === "	") {
    return 8 - currentColumn % 8;
  }
  if (char === "\b") {
    return -1;
  }
  return 1;
}
__name(getCharWidth, "getCharWidth");
function foldLine(line, options) {
  if (line.length === 0) {
    return line;
  }
  const { width, breakAtSpaces, countBytes } = options;
  const result = [];
  let currentLine = "";
  let currentColumn = 0;
  let lastSpaceIndex = -1;
  let lastSpaceColumn = 0;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const charWidth = getCharWidth(char, currentColumn, countBytes);
    if (currentColumn + charWidth > width && currentLine.length > 0) {
      if (breakAtSpaces && lastSpaceIndex >= 0) {
        result.push(currentLine.slice(0, lastSpaceIndex + 1));
        currentLine = currentLine.slice(lastSpaceIndex + 1) + char;
        currentColumn = currentColumn - lastSpaceColumn - 1 + charWidth;
        lastSpaceIndex = -1;
        lastSpaceColumn = 0;
      } else {
        result.push(currentLine);
        currentLine = char;
        currentColumn = charWidth;
        lastSpaceIndex = -1;
        lastSpaceColumn = 0;
      }
    } else {
      currentLine += char;
      currentColumn += charWidth;
      if (char === " " || char === "	") {
        lastSpaceIndex = currentLine.length - 1;
        lastSpaceColumn = currentColumn - charWidth;
      }
    }
  }
  if (currentLine.length > 0) {
    result.push(currentLine);
  }
  return result.join("\n");
}
__name(foldLine, "foldLine");
function processContent(content, options) {
  if (content === "") {
    return "";
  }
  const lines = content.split("\n");
  const hasTrailingNewline = content.endsWith("\n") && lines[lines.length - 1] === "";
  if (hasTrailingNewline) {
    lines.pop();
  }
  const foldedLines = lines.map((line) => foldLine(line, options));
  return foldedLines.join("\n") + (hasTrailingNewline ? "\n" : "");
}
__name(processContent, "processContent");
var fold = {
  name: "fold",
  execute: /* @__PURE__ */ __name(async (args, ctx) => {
    if (hasHelpFlag(args)) {
      return showHelp(foldHelp);
    }
    const options = {
      width: 80,
      breakAtSpaces: false,
      countBytes: false
    };
    const files = [];
    let i = 0;
    while (i < args.length) {
      const arg = args[i];
      if (arg === "-w" && i + 1 < args.length) {
        const width = parseInt(args[i + 1], 10);
        if (Number.isNaN(width) || width < 1) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `fold: invalid number of columns: '${args[i + 1]}'
`
          };
        }
        options.width = width;
        i += 2;
      } else if (arg.startsWith("-w") && arg.length > 2) {
        const width = parseInt(arg.slice(2), 10);
        if (Number.isNaN(width) || width < 1) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `fold: invalid number of columns: '${arg.slice(2)}'
`
          };
        }
        options.width = width;
        i++;
      } else if (arg === "-s") {
        options.breakAtSpaces = true;
        i++;
      } else if (arg === "-b") {
        options.countBytes = true;
        i++;
      } else if (arg === "-bs" || arg === "-sb") {
        options.breakAtSpaces = true;
        options.countBytes = true;
        i++;
      } else if (arg.match(/^-[sb]+w\d+$/)) {
        if (arg.includes("s"))
          options.breakAtSpaces = true;
        if (arg.includes("b"))
          options.countBytes = true;
        const widthPart = arg.replace(/^-[sb]+w/, "");
        const width = parseInt(widthPart, 10);
        if (Number.isNaN(width) || width < 1) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `fold: invalid number of columns: '${widthPart}'
`
          };
        }
        options.width = width;
        i++;
      } else if (arg.match(/^-[sb]+w$/) && i + 1 < args.length) {
        if (arg.includes("s"))
          options.breakAtSpaces = true;
        if (arg.includes("b"))
          options.countBytes = true;
        const width = parseInt(args[i + 1], 10);
        if (Number.isNaN(width) || width < 1) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `fold: invalid number of columns: '${args[i + 1]}'
`
          };
        }
        options.width = width;
        i += 2;
      } else if (arg === "--") {
        files.push(...args.slice(i + 1));
        break;
      } else if (arg.startsWith("-") && arg !== "-") {
        const flags = arg.slice(1);
        let hasUnknown = false;
        for (const flag of flags) {
          if (flag === "s") {
            options.breakAtSpaces = true;
          } else if (flag === "b") {
            options.countBytes = true;
          } else {
            hasUnknown = true;
            break;
          }
        }
        if (hasUnknown) {
          return unknownOption("fold", arg);
        }
        i++;
      } else {
        files.push(arg);
        i++;
      }
    }
    let output = "";
    if (files.length === 0) {
      const input = ctx.stdin ?? "";
      output = processContent(input, options);
    } else {
      for (const file of files) {
        const filePath = ctx.fs.resolvePath(ctx.cwd, file);
        const content = await ctx.fs.readFile(filePath);
        if (content === null) {
          return {
            exitCode: 1,
            stdout: output,
            stderr: `fold: ${file}: No such file or directory
`
          };
        }
        output += processContent(content, options);
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
  fold
};
