import {
  hasHelpFlag,
  showHelp,
  unknownOption
} from "./chunk-HAN5425M.js";
import {
  __name
} from "./chunk-Y7IWVHJ4.js";

// dist/commands/rev/rev.js
var revHelp = {
  name: "rev",
  summary: "reverse lines characterwise",
  usage: "rev [file ...]",
  description: "Copies the specified files to standard output, reversing the order of characters in every line. If no files are specified, standard input is read.",
  examples: [
    "echo 'hello' | rev     # Output: olleh",
    "rev file.txt           # Reverse each line in file"
  ]
};
function reverseString(str) {
  return Array.from(str).reverse().join("");
}
__name(reverseString, "reverseString");
var rev = {
  name: "rev",
  execute: /* @__PURE__ */ __name(async (args, ctx) => {
    if (hasHelpFlag(args)) {
      return showHelp(revHelp);
    }
    const files = [];
    for (const arg of args) {
      if (arg === "--") {
        const idx = args.indexOf(arg);
        files.push(...args.slice(idx + 1));
        break;
      } else if (arg.startsWith("-") && arg !== "-") {
        return unknownOption("rev", arg);
      } else {
        files.push(arg);
      }
    }
    let output = "";
    const processContent = /* @__PURE__ */ __name((content) => {
      const lines = content.split("\n");
      const hasTrailingNewline = content.endsWith("\n") && lines[lines.length - 1] === "";
      if (hasTrailingNewline) {
        lines.pop();
      }
      const reversed = lines.map(reverseString);
      return reversed.join("\n") + (hasTrailingNewline ? "\n" : "");
    }, "processContent");
    if (files.length === 0) {
      const input = ctx.stdin ?? "";
      output = processContent(input);
    } else {
      for (const file of files) {
        if (file === "-") {
          const input = ctx.stdin ?? "";
          output += processContent(input);
        } else {
          const filePath = ctx.fs.resolvePath(ctx.cwd, file);
          const content = await ctx.fs.readFile(filePath);
          if (content === null) {
            return {
              exitCode: 1,
              stdout: output,
              stderr: `rev: ${file}: No such file or directory
`
            };
          }
          output += processContent(content);
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
  rev
};
