import {
  hasHelpFlag,
  showHelp,
  unknownOption
} from "./chunk-HAN5425M.js";
import {
  __name
} from "./chunk-Y7IWVHJ4.js";

// dist/commands/strings/strings.js
var stringsHelp = {
  name: "strings",
  summary: "print the sequences of printable characters in files",
  usage: "strings [OPTION]... [FILE]...",
  description: "For each FILE, print the printable character sequences that are at least MIN characters long. If no FILE is specified, standard input is read.",
  options: [
    "-n MIN       Print sequences of at least MIN characters (default: 4)",
    "-t FORMAT    Print offset before each string (o=octal, x=hex, d=decimal)",
    "-a           Scan the entire file (default behavior)",
    "-e ENCODING  Select character encoding (s=7-bit, S=8-bit)"
  ],
  examples: [
    "strings file.bin          # Extract strings (min 4 chars)",
    "strings -n 8 file.bin     # Extract strings (min 8 chars)",
    "strings -t x file.bin     # Show hex offset",
    "echo 'hello' | strings    # Read from stdin"
  ]
};
function isPrintable(byte) {
  return byte >= 32 && byte <= 126 || byte === 9;
}
__name(isPrintable, "isPrintable");
function formatOffset(offset, format) {
  if (format === null) {
    return "";
  }
  switch (format) {
    case "o":
      return `${offset.toString(8).padStart(7, " ")} `;
    case "x":
      return `${offset.toString(16).padStart(7, " ")} `;
    case "d":
      return `${offset.toString(10).padStart(7, " ")} `;
    default: {
      const _exhaustive = format;
      return _exhaustive;
    }
  }
}
__name(formatOffset, "formatOffset");
function extractStrings(data, options) {
  const results = [];
  let currentString = "";
  let stringStart = 0;
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (isPrintable(byte)) {
      if (currentString.length === 0) {
        stringStart = i;
      }
      currentString += String.fromCharCode(byte);
    } else {
      if (currentString.length >= options.minLength) {
        const prefix = formatOffset(stringStart, options.offsetFormat);
        results.push(`${prefix}${currentString}`);
      }
      currentString = "";
    }
  }
  if (currentString.length >= options.minLength) {
    const prefix = formatOffset(stringStart, options.offsetFormat);
    results.push(`${prefix}${currentString}`);
  }
  return results;
}
__name(extractStrings, "extractStrings");
var strings = {
  name: "strings",
  execute: /* @__PURE__ */ __name(async (args, ctx) => {
    if (hasHelpFlag(args)) {
      return showHelp(stringsHelp);
    }
    const options = {
      minLength: 4,
      offsetFormat: null
    };
    const files = [];
    let i = 0;
    while (i < args.length) {
      const arg = args[i];
      if (arg === "-n" && i + 1 < args.length) {
        const min = Number.parseInt(args[i + 1], 10);
        if (Number.isNaN(min) || min < 1) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `strings: invalid minimum string length: '${args[i + 1]}'
`
          };
        }
        options.minLength = min;
        i += 2;
      } else if (arg.match(/^-n\d+$/)) {
        const min = Number.parseInt(arg.slice(2), 10);
        if (Number.isNaN(min) || min < 1) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `strings: invalid minimum string length: '${arg.slice(2)}'
`
          };
        }
        options.minLength = min;
        i++;
      } else if (arg.match(/^-\d+$/)) {
        const min = Number.parseInt(arg.slice(1), 10);
        if (Number.isNaN(min) || min < 1) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `strings: invalid minimum string length: '${arg.slice(1)}'
`
          };
        }
        options.minLength = min;
        i++;
      } else if (arg === "-t" && i + 1 < args.length) {
        const format = args[i + 1];
        if (format !== "o" && format !== "x" && format !== "d") {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `strings: invalid radix: '${format}'
`
          };
        }
        options.offsetFormat = format;
        i += 2;
      } else if (arg.startsWith("-t") && arg.length === 3) {
        const format = arg[2];
        if (format !== "o" && format !== "x" && format !== "d") {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `strings: invalid radix: '${format}'
`
          };
        }
        options.offsetFormat = format;
        i++;
      } else if (arg === "-a" || arg === "--all" || arg === "-") {
        if (arg === "-") {
          files.push(arg);
        }
        i++;
      } else if (arg === "-e" && i + 1 < args.length) {
        const encoding = args[i + 1];
        if (encoding !== "s" && encoding !== "S") {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `strings: invalid encoding: '${encoding}'
`
          };
        }
        i += 2;
      } else if (arg.startsWith("-e") && arg.length === 3) {
        const encoding = arg[2];
        if (encoding !== "s" && encoding !== "S") {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `strings: invalid encoding: '${encoding}'
`
          };
        }
        i++;
      } else if (arg === "--") {
        files.push(...args.slice(i + 1));
        break;
      } else if (arg.startsWith("-") && arg !== "-") {
        return unknownOption("strings", arg);
      } else {
        files.push(arg);
        i++;
      }
    }
    let output = "";
    if (files.length === 0) {
      const input = ctx.stdin ?? "";
      const strings2 = extractStrings(input, options);
      output = strings2.length > 0 ? `${strings2.join("\n")}
` : "";
    } else {
      for (const file of files) {
        let content;
        if (file === "-") {
          content = ctx.stdin ?? "";
        } else {
          const filePath = ctx.fs.resolvePath(ctx.cwd, file);
          content = await ctx.fs.readFile(filePath);
          if (content === null) {
            return {
              exitCode: 1,
              stdout: output,
              stderr: `strings: ${file}: No such file or directory
`
            };
          }
        }
        const strings2 = extractStrings(content, options);
        if (strings2.length > 0) {
          output += `${strings2.join("\n")}
`;
        }
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
  strings
};
