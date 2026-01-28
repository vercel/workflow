import {
  hasHelpFlag,
  showHelp,
  unknownOption
} from "./chunk-HAN5425M.js";
import {
  __name
} from "./chunk-Y7IWVHJ4.js";

// dist/commands/expand/unexpand.js
var unexpandHelp = {
  name: "unexpand",
  summary: "convert spaces to tabs",
  usage: "unexpand [OPTION]... [FILE]...",
  description: "Convert blanks in each FILE to TABs, writing to standard output. If no FILE is specified, standard input is read.",
  options: [
    "-t N        Use N spaces per tab (default: 8)",
    "-t LIST     Use comma-separated list of tab stops",
    "-a          Convert all sequences of blanks (not just leading)"
  ],
  examples: [
    "unexpand file.txt           # Convert leading spaces to tabs",
    "unexpand -a file.txt        # Convert all space sequences",
    "unexpand -t 4 file.txt      # Use 4-space tabs"
  ]
};
function parseTabStops(spec) {
  const parts = spec.split(",").map((s) => s.trim());
  const stops = [];
  for (const part of parts) {
    const num = parseInt(part, 10);
    if (Number.isNaN(num) || num < 1) {
      return null;
    }
    stops.push(num);
  }
  for (let i = 1; i < stops.length; i++) {
    if (stops[i] <= stops[i - 1]) {
      return null;
    }
  }
  return stops;
}
__name(parseTabStops, "parseTabStops");
function getNextTabStop(column, tabStops) {
  if (tabStops.length === 1) {
    const tabWidth = tabStops[0];
    return column + (tabWidth - column % tabWidth);
  }
  for (const stop of tabStops) {
    if (stop > column) {
      return stop;
    }
  }
  if (tabStops.length >= 2) {
    const lastInterval = tabStops[tabStops.length - 1] - tabStops[tabStops.length - 2];
    const lastStop = tabStops[tabStops.length - 1];
    const stopsAfterLast = Math.floor((column - lastStop) / lastInterval) + 1;
    return lastStop + stopsAfterLast * lastInterval;
  }
  return -1;
}
__name(getNextTabStop, "getNextTabStop");
function unexpandLine(line, options) {
  const { tabStops, allBlanks } = options;
  let result = "";
  let column = 0;
  let spaceRun = "";
  let spaceRunStart = 0;
  let inLeadingBlanks = true;
  const flushSpaces = /* @__PURE__ */ __name(() => {
    if (spaceRun.length === 0)
      return;
    const endColumn = spaceRunStart + spaceRun.length;
    if (!allBlanks && !inLeadingBlanks) {
      result += spaceRun;
      spaceRun = "";
      return;
    }
    let currentPos = spaceRunStart;
    let converted = "";
    while (currentPos < endColumn) {
      const nextStop = getNextTabStop(currentPos, tabStops);
      if (nextStop <= endColumn && nextStop > currentPos) {
        converted += "	";
        currentPos = nextStop;
      } else {
        break;
      }
    }
    const remaining = endColumn - currentPos;
    if (remaining > 0) {
      converted += " ".repeat(remaining);
    }
    result += converted;
    spaceRun = "";
  }, "flushSpaces");
  for (const char of line) {
    if (char === " ") {
      if (spaceRun.length === 0) {
        spaceRunStart = column;
      }
      spaceRun += char;
      column++;
    } else if (char === "	") {
      flushSpaces();
      result += char;
      column = getNextTabStop(column, tabStops);
    } else {
      flushSpaces();
      result += char;
      column++;
      inLeadingBlanks = false;
    }
  }
  flushSpaces();
  return result;
}
__name(unexpandLine, "unexpandLine");
function processContent(content, options) {
  if (content === "") {
    return "";
  }
  const lines = content.split("\n");
  const hasTrailingNewline = content.endsWith("\n") && lines[lines.length - 1] === "";
  if (hasTrailingNewline) {
    lines.pop();
  }
  const unexpandedLines = lines.map((line) => unexpandLine(line, options));
  return unexpandedLines.join("\n") + (hasTrailingNewline ? "\n" : "");
}
__name(processContent, "processContent");
var unexpand = {
  name: "unexpand",
  execute: /* @__PURE__ */ __name(async (args, ctx) => {
    if (hasHelpFlag(args)) {
      return showHelp(unexpandHelp);
    }
    const options = {
      tabStops: [8],
      allBlanks: false
    };
    const files = [];
    let i = 0;
    while (i < args.length) {
      const arg = args[i];
      if (arg === "-t" && i + 1 < args.length) {
        const stops = parseTabStops(args[i + 1]);
        if (!stops) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `unexpand: invalid tab size: '${args[i + 1]}'
`
          };
        }
        options.tabStops = stops;
        i += 2;
      } else if (arg.startsWith("-t") && arg.length > 2) {
        const stops = parseTabStops(arg.slice(2));
        if (!stops) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `unexpand: invalid tab size: '${arg.slice(2)}'
`
          };
        }
        options.tabStops = stops;
        i++;
      } else if (arg === "--tabs" && i + 1 < args.length) {
        const stops = parseTabStops(args[i + 1]);
        if (!stops) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `unexpand: invalid tab size: '${args[i + 1]}'
`
          };
        }
        options.tabStops = stops;
        i += 2;
      } else if (arg.startsWith("--tabs=")) {
        const stops = parseTabStops(arg.slice(7));
        if (!stops) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `unexpand: invalid tab size: '${arg.slice(7)}'
`
          };
        }
        options.tabStops = stops;
        i++;
      } else if (arg === "-a" || arg === "--all") {
        options.allBlanks = true;
        i++;
      } else if (arg === "--") {
        files.push(...args.slice(i + 1));
        break;
      } else if (arg.startsWith("-") && arg !== "-") {
        return unknownOption("unexpand", arg);
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
            stderr: `unexpand: ${file}: No such file or directory
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
  unexpand
};
