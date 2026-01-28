import {
  __name
} from "./chunk-Y7IWVHJ4.js";

// dist/commands/printf/escapes.js
function applyWidth(value, width, precision) {
  let result = value;
  if (precision >= 0 && result.length > precision) {
    result = result.slice(0, precision);
  }
  const absWidth = Math.abs(width);
  if (absWidth > result.length) {
    if (width < 0) {
      result = result.padEnd(absWidth, " ");
    } else {
      result = result.padStart(absWidth, " ");
    }
  }
  return result;
}
__name(applyWidth, "applyWidth");
function parseWidthPrecision(format, startIndex) {
  let i = startIndex;
  let width = 0;
  let precision = -1;
  let leftJustify = false;
  if (i < format.length && format[i] === "-") {
    leftJustify = true;
    i++;
  }
  while (i < format.length && /\d/.test(format[i])) {
    width = width * 10 + parseInt(format[i], 10);
    i++;
  }
  if (i < format.length && format[i] === ".") {
    i++;
    precision = 0;
    while (i < format.length && /\d/.test(format[i])) {
      precision = precision * 10 + parseInt(format[i], 10);
      i++;
    }
  }
  if (leftJustify && width > 0) {
    width = -width;
  }
  return [width, precision, i - startIndex];
}
__name(parseWidthPrecision, "parseWidthPrecision");
function processEscapes(str) {
  let result = "";
  let i = 0;
  while (i < str.length) {
    if (str[i] === "\\" && i + 1 < str.length) {
      const next = str[i + 1];
      switch (next) {
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
        case "\\":
          result += "\\";
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
        case "0":
        case "1":
        case "2":
        case "3":
        case "4":
        case "5":
        case "6":
        case "7": {
          let octal = "";
          let j = i + 1;
          while (j < str.length && j < i + 4 && /[0-7]/.test(str[j])) {
            octal += str[j];
            j++;
          }
          result += String.fromCharCode(parseInt(octal, 8));
          i = j;
          break;
        }
        case "x": {
          const bytes = [];
          let j = i;
          while (j + 3 < str.length && str[j] === "\\" && str[j + 1] === "x" && /[0-9a-fA-F]{2}/.test(str.slice(j + 2, j + 4))) {
            bytes.push(parseInt(str.slice(j + 2, j + 4), 16));
            j += 4;
          }
          if (bytes.length > 0) {
            try {
              const decoder = new TextDecoder("utf-8", { fatal: true });
              result += decoder.decode(new Uint8Array(bytes));
            } catch {
              for (const byte of bytes) {
                result += String.fromCharCode(byte);
              }
            }
            i = j;
          } else {
            result += str[i];
            i++;
          }
          break;
        }
        case "u": {
          let hex = "";
          let j = i + 2;
          while (j < str.length && j < i + 6 && /[0-9a-fA-F]/.test(str[j])) {
            hex += str[j];
            j++;
          }
          if (hex) {
            result += String.fromCodePoint(parseInt(hex, 16));
            i = j;
          } else {
            result += "\\u";
            i += 2;
          }
          break;
        }
        case "U": {
          let hex = "";
          let j = i + 2;
          while (j < str.length && j < i + 10 && /[0-9a-fA-F]/.test(str[j])) {
            hex += str[j];
            j++;
          }
          if (hex) {
            result += String.fromCodePoint(parseInt(hex, 16));
            i = j;
          } else {
            result += "\\U";
            i += 2;
          }
          break;
        }
        default:
          result += str[i];
          i++;
      }
    } else {
      result += str[i];
      i++;
    }
  }
  return result;
}
__name(processEscapes, "processEscapes");

export {
  applyWidth,
  parseWidthPrecision,
  processEscapes
};
