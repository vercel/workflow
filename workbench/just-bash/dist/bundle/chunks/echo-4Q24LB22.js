import {
  __name
} from "./chunk-Y7IWVHJ4.js";

// dist/commands/echo/echo.js
function processEscapes(input) {
  let result = "";
  let i = 0;
  while (i < input.length) {
    if (input[i] === "\\") {
      if (i + 1 >= input.length) {
        result += "\\";
        break;
      }
      const next = input[i + 1];
      switch (next) {
        case "\\":
          result += "\\";
          i += 2;
          break;
        case "n":
          result += "\n";
          i += 2;
          break;
        case "t":
          result += "	";
          i += 2;
          break;
        case "r":
          result += "\r";
          i += 2;
          break;
        case "a":
          result += "\x07";
          i += 2;
          break;
        case "b":
          result += "\b";
          i += 2;
          break;
        case "f":
          result += "\f";
          i += 2;
          break;
        case "v":
          result += "\v";
          i += 2;
          break;
        case "e":
        case "E":
          result += "\x1B";
          i += 2;
          break;
        case "c":
          return { output: result, stop: true };
        case "0": {
          let octal = "";
          let j = i + 2;
          while (j < input.length && j < i + 5 && /[0-7]/.test(input[j])) {
            octal += input[j];
            j++;
          }
          if (octal.length === 0) {
            result += "\0";
          } else {
            const code = parseInt(octal, 8) % 256;
            result += String.fromCharCode(code);
          }
          i = j;
          break;
        }
        case "x": {
          let hex = "";
          let j = i + 2;
          while (j < input.length && j < i + 4 && /[0-9a-fA-F]/.test(input[j])) {
            hex += input[j];
            j++;
          }
          if (hex.length === 0) {
            result += "\\x";
            i += 2;
          } else {
            const code = parseInt(hex, 16);
            result += String.fromCharCode(code);
            i = j;
          }
          break;
        }
        case "u": {
          let hex = "";
          let j = i + 2;
          while (j < input.length && j < i + 6 && /[0-9a-fA-F]/.test(input[j])) {
            hex += input[j];
            j++;
          }
          if (hex.length === 0) {
            result += "\\u";
            i += 2;
          } else {
            const code = parseInt(hex, 16);
            result += String.fromCodePoint(code);
            i = j;
          }
          break;
        }
        case "U": {
          let hex = "";
          let j = i + 2;
          while (j < input.length && j < i + 10 && /[0-9a-fA-F]/.test(input[j])) {
            hex += input[j];
            j++;
          }
          if (hex.length === 0) {
            result += "\\U";
            i += 2;
          } else {
            const code = parseInt(hex, 16);
            try {
              result += String.fromCodePoint(code);
            } catch {
              result += `\\U${hex}`;
            }
            i = j;
          }
          break;
        }
        default:
          result += `\\${next}`;
          i += 2;
      }
    } else {
      result += input[i];
      i++;
    }
  }
  return { output: result, stop: false };
}
__name(processEscapes, "processEscapes");
var echoCommand = {
  name: "echo",
  async execute(args, ctx) {
    let noNewline = false;
    let interpretEscapes = ctx.xpgEcho ?? false;
    let startIndex = 0;
    while (startIndex < args.length) {
      const arg = args[startIndex];
      if (arg === "-n") {
        noNewline = true;
        startIndex++;
      } else if (arg === "-e") {
        interpretEscapes = true;
        startIndex++;
      } else if (arg === "-E") {
        interpretEscapes = false;
        startIndex++;
      } else if (arg === "-ne" || arg === "-en") {
        noNewline = true;
        interpretEscapes = true;
        startIndex++;
      } else {
        break;
      }
    }
    let output = args.slice(startIndex).join(" ");
    if (interpretEscapes) {
      const result = processEscapes(output);
      output = result.output;
      if (result.stop) {
        return {
          stdout: output,
          stderr: "",
          exitCode: 0
        };
      }
    }
    if (!noNewline) {
      output += "\n";
    }
    return {
      stdout: output,
      stderr: "",
      exitCode: 0
    };
  }
};
export {
  echoCommand
};
