import { p as processEscapes, a as applyWidth } from "./chunk-NUDF4AYR.mjs";
import { m as getErrorMessage, _ as __name } from "../index.mjs";
import { h as hasHelpFlag, s as showHelp } from "./chunk-HAN5425M.mjs";
import { s as sprintfExports } from "../_libs/sprintf-js.mjs";
import "./_libs/@vercel/functions.mjs";
import "../_libs/srvx.mjs";
import "node:http";
import "node:stream";
import "node:https";
import "node:http2";
import "../_libs/h3.mjs";
import "../_libs/rou3.mjs";
import "../_libs/ms.mjs";
import "./_libs/@mongodb-js/zstd.mjs";
import "util";
import "util/types";
import "../_libs/ulid.mjs";
import "node:crypto";
import "node:module";
import "node:path";
import "node:child_process";
import "node:fs/promises";
import "node:util";
import "node:url";
import "node:timers/promises";
import "./_libs/@vercel/queue.mjs";
import "../_libs/mixpart.mjs";
import "./_libs/@vercel/oidc.mjs";
import "path";
import "fs";
import "os";
import "./_libs/async-sema.mjs";
import "events";
import "./_libs/undici.mjs";
import "node:assert";
import "node:net";
import "node:buffer";
import "node:querystring";
import "node:events";
import "node:diagnostics_channel";
import "node:tls";
import "node:zlib";
import "node:perf_hooks";
import "node:util/types";
import "node:worker_threads";
import "node:async_hooks";
import "node:console";
import "node:dns";
import "string_decoder";
import "../_libs/zod.mjs";
import "node:fs";
import "node:os";
import "../_libs/cbor-x.mjs";
import "../_libs/devalue.mjs";
import "./_libs/debug.mjs";
import "tty";
import "../_libs/supports-color.mjs";
import "../_libs/has-flag.mjs";
import "./_libs/@jridgewell/trace-mapping.mjs";
import "./_libs/@jridgewell/sourcemap-codec.mjs";
import "./_libs/@jridgewell/resolve-uri.mjs";
import "node:vm";
import "../_libs/nanoid.mjs";
import "../_libs/seedrandom.mjs";
import "../_libs/ufo.mjs";
function formatStrftime(format, timestamp, tz) {
  const date = new Date(timestamp * 1e3);
  let result = "";
  let i = 0;
  while (i < format.length) {
    if (format[i] === "%" && i + 1 < format.length) {
      const directive = format[i + 1];
      const formatted = formatStrftimeDirective(date, directive, tz);
      if (formatted !== null) {
        result += formatted;
        i += 2;
      } else {
        result += format[i];
        i++;
      }
    } else {
      result += format[i];
      i++;
    }
  }
  return result;
}
__name(formatStrftime, "formatStrftime");
function getDatePartsInTimezone(date, tz) {
  const options = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hour12: false,
    timeZone: tz
  };
  try {
    const formatter = new Intl.DateTimeFormat("en-US", options);
    const parts = formatter.formatToParts(date);
    const getValue = /* @__PURE__ */ __name((type) => parts.find((p) => p.type === type)?.value ?? "", "getValue");
    const weekdayMap = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6
    };
    const weekdayStr = getValue("weekday");
    return {
      year: Number.parseInt(getValue("year"), 10) || date.getFullYear(),
      month: Number.parseInt(getValue("month"), 10) || date.getMonth() + 1,
      day: Number.parseInt(getValue("day"), 10) || date.getDate(),
      hour: Number.parseInt(getValue("hour"), 10) || date.getHours(),
      minute: Number.parseInt(getValue("minute"), 10) || date.getMinutes(),
      second: Number.parseInt(getValue("second"), 10) || date.getSeconds(),
      weekday: weekdayMap[weekdayStr] ?? date.getDay()
    };
  } catch {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      second: date.getSeconds(),
      weekday: date.getDay()
    };
  }
}
__name(getDatePartsInTimezone, "getDatePartsInTimezone");
function formatStrftimeDirective(date, directive, tz) {
  const parts = getDatePartsInTimezone(date, tz);
  const pad = /* @__PURE__ */ __name((n, width = 2) => String(n).padStart(width, "0"), "pad");
  const dayOfYear = getDayOfYearForParts(parts.year, parts.month, parts.day);
  const weekNumber = getWeekNumberForParts(parts.year, parts.month, parts.day, parts.weekday, 0);
  const weekNumberMon = getWeekNumberForParts(parts.year, parts.month, parts.day, parts.weekday, 1);
  switch (directive) {
    case "a":
      return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][parts.weekday];
    case "A":
      return [
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday"
      ][parts.weekday];
    case "b":
    case "h":
      return [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec"
      ][parts.month - 1];
    case "B":
      return [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December"
      ][parts.month - 1];
    case "c":
      return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][parts.weekday]} ${[
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec"
      ][parts.month - 1]} ${String(parts.day).padStart(2, " ")} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)} ${parts.year}`;
    case "C":
      return pad(Math.floor(parts.year / 100));
    case "d":
      return pad(parts.day);
    case "D":
      return `${pad(parts.month)}/${pad(parts.day)}/${pad(parts.year % 100)}`;
    case "e":
      return String(parts.day).padStart(2, " ");
    case "F":
      return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
    case "g":
      return pad(getISOWeekYear(parts.year, parts.month, parts.day) % 100);
    case "G":
      return String(getISOWeekYear(parts.year, parts.month, parts.day));
    case "H":
      return pad(parts.hour);
    case "I":
      return pad(parts.hour % 12 || 12);
    case "j":
      return String(dayOfYear).padStart(3, "0");
    case "k":
      return String(parts.hour).padStart(2, " ");
    case "l":
      return String(parts.hour % 12 || 12).padStart(2, " ");
    case "m":
      return pad(parts.month);
    case "M":
      return pad(parts.minute);
    case "n":
      return "\n";
    case "N":
      return "000000000";
    case "p":
      return parts.hour < 12 ? "AM" : "PM";
    case "P":
      return parts.hour < 12 ? "am" : "pm";
    case "r":
      return `${pad(parts.hour % 12 || 12)}:${pad(parts.minute)}:${pad(parts.second)} ${parts.hour < 12 ? "AM" : "PM"}`;
    case "R":
      return `${pad(parts.hour)}:${pad(parts.minute)}`;
    case "s":
      return String(Math.floor(date.getTime() / 1e3));
    case "S":
      return pad(parts.second);
    case "t":
      return "	";
    case "T":
      return `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
    case "u":
      return String(parts.weekday === 0 ? 7 : parts.weekday);
    case "U":
      return pad(weekNumber);
    case "V":
      return pad(getISOWeekNumberForParts(parts.year, parts.month, parts.day));
    case "w":
      return String(parts.weekday);
    case "W":
      return pad(weekNumberMon);
    case "x":
      return `${pad(parts.month)}/${pad(parts.day)}/${pad(parts.year % 100)}`;
    case "X":
      return `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
    case "y":
      return pad(parts.year % 100);
    case "Y":
      return String(parts.year);
    case "z":
      return getTimezoneOffset(date, tz);
    case "Z":
      return getTimezoneName(date, tz);
    case "%":
      return "%";
    default:
      return null;
  }
}
__name(formatStrftimeDirective, "formatStrftimeDirective");
function getTimezoneOffset(date, tz) {
  if (!tz) {
    const offset2 = -date.getTimezoneOffset();
    const sign2 = offset2 >= 0 ? "+" : "-";
    const hours2 = Math.floor(Math.abs(offset2) / 60);
    const mins2 = Math.abs(offset2) % 60;
    return `${sign2}${String(hours2).padStart(2, "0")}${String(mins2).padStart(2, "0")}`;
  }
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "longOffset"
    });
    const parts = formatter.formatToParts(date);
    const tzPart = parts.find((p) => p.type === "timeZoneName");
    if (tzPart) {
      const match = tzPart.value.match(/GMT([+-])(\d{2}):(\d{2})/);
      if (match) {
        return `${match[1]}${match[2]}${match[3]}`;
      }
      if (tzPart.value === "GMT" || tzPart.value === "UTC") {
        return "+0000";
      }
    }
  } catch {
  }
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const hours = Math.floor(Math.abs(offset) / 60);
  const mins = Math.abs(offset) % 60;
  return `${sign}${String(hours).padStart(2, "0")}${String(mins).padStart(2, "0")}`;
}
__name(getTimezoneOffset, "getTimezoneOffset");
function getTimezoneName(date, tz) {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "short"
    });
    const parts = formatter.formatToParts(date);
    const tzPart = parts.find((p) => p.type === "timeZoneName");
    return tzPart?.value ?? "UTC";
  } catch {
    return "UTC";
  }
}
__name(getTimezoneName, "getTimezoneName");
function getDayOfYearForParts(year, month, day) {
  const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const isLeap = year % 4 === 0 && year % 100 !== 0 || year % 400 === 0;
  if (isLeap)
    daysInMonth[1] = 29;
  let dayOfYear = day;
  for (let i = 0; i < month - 1; i++) {
    dayOfYear += daysInMonth[i];
  }
  return dayOfYear;
}
__name(getDayOfYearForParts, "getDayOfYearForParts");
function getWeekNumberForParts(year, month, day, weekday, startDay) {
  const dayOfYear = getDayOfYearForParts(year, month, day);
  const jan1 = new Date(year, 0, 1);
  const jan1Weekday = jan1.getDay();
  const adjustedJan1 = (jan1Weekday - startDay + 7) % 7;
  const adjustedWeekday = (weekday - startDay + 7) % 7;
  const daysIntoYear = dayOfYear - 1 + adjustedJan1;
  const weekNum = Math.floor((daysIntoYear - adjustedWeekday + 7) / 7);
  return weekNum;
}
__name(getWeekNumberForParts, "getWeekNumberForParts");
function getISOWeekNumberForParts(year, month, day) {
  const tempDate = new Date(year, month - 1, day, 12, 0, 0);
  tempDate.setDate(tempDate.getDate() + 3 - (tempDate.getDay() + 6) % 7);
  const firstThursday = new Date(tempDate.getFullYear(), 0, 4);
  firstThursday.setDate(firstThursday.getDate() + 3 - (firstThursday.getDay() + 6) % 7);
  const diff = tempDate.getTime() - firstThursday.getTime();
  return 1 + Math.round(diff / (7 * 24 * 60 * 60 * 1e3));
}
__name(getISOWeekNumberForParts, "getISOWeekNumberForParts");
function getISOWeekYear(year, month, day) {
  const tempDate = new Date(year, month - 1, day, 12, 0, 0);
  tempDate.setDate(tempDate.getDate() + 3 - (tempDate.getDay() + 6) % 7);
  return tempDate.getFullYear();
}
__name(getISOWeekYear, "getISOWeekYear");
function decodeUtf8WithRecovery(bytes) {
  let result = "";
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i];
    if (b0 < 128) {
      result += String.fromCharCode(b0);
      i++;
      continue;
    }
    if ((b0 & 224) === 192) {
      if (i + 1 < bytes.length && (bytes[i + 1] & 192) === 128 && b0 >= 194) {
        const codePoint = (b0 & 31) << 6 | bytes[i + 1] & 63;
        result += String.fromCharCode(codePoint);
        i += 2;
        continue;
      }
      result += String.fromCharCode(b0);
      i++;
      continue;
    }
    if ((b0 & 240) === 224) {
      if (i + 2 < bytes.length && (bytes[i + 1] & 192) === 128 && (bytes[i + 2] & 192) === 128) {
        if (b0 === 224 && bytes[i + 1] < 160) {
          result += String.fromCharCode(b0);
          i++;
          continue;
        }
        const codePoint = (b0 & 15) << 12 | (bytes[i + 1] & 63) << 6 | bytes[i + 2] & 63;
        if (codePoint >= 55296 && codePoint <= 57343) {
          result += String.fromCharCode(b0);
          i++;
          continue;
        }
        result += String.fromCharCode(codePoint);
        i += 3;
        continue;
      }
      result += String.fromCharCode(b0);
      i++;
      continue;
    }
    if ((b0 & 248) === 240 && b0 <= 244) {
      if (i + 3 < bytes.length && (bytes[i + 1] & 192) === 128 && (bytes[i + 2] & 192) === 128 && (bytes[i + 3] & 192) === 128) {
        if (b0 === 240 && bytes[i + 1] < 144) {
          result += String.fromCharCode(b0);
          i++;
          continue;
        }
        const codePoint = (b0 & 7) << 18 | (bytes[i + 1] & 63) << 12 | (bytes[i + 2] & 63) << 6 | bytes[i + 3] & 63;
        if (codePoint > 1114111) {
          result += String.fromCharCode(b0);
          i++;
          continue;
        }
        result += String.fromCodePoint(codePoint);
        i += 4;
        continue;
      }
      result += String.fromCharCode(b0);
      i++;
      continue;
    }
    result += String.fromCharCode(b0);
    i++;
  }
  return result;
}
__name(decodeUtf8WithRecovery, "decodeUtf8WithRecovery");
var printfHelp = {
  name: "printf",
  summary: "format and print data",
  usage: "printf [-v var] FORMAT [ARGUMENT...]",
  options: [
    "    -v var     assign the output to shell variable VAR rather than display it",
    "    --help     display this help and exit"
  ],
  notes: [
    "FORMAT controls the output like in C printf.",
    "Escape sequences: \\n (newline), \\t (tab), \\\\ (backslash)",
    "Format specifiers: %s (string), %d (integer), %f (float), %x (hex), %o (octal), %% (literal %)",
    "Width and precision: %10s (width 10), %.2f (2 decimal places), %010d (zero-padded)",
    "Flags: %- (left-justify), %+ (show sign), %0 (zero-pad)"
  ]
};
var printfCommand = {
  name: "printf",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(printfHelp);
    }
    if (args.length === 0) {
      return {
        stdout: "",
        stderr: "printf: usage: printf format [arguments]\n",
        exitCode: 2
      };
    }
    let targetVar = null;
    let argIndex = 0;
    while (argIndex < args.length) {
      const arg = args[argIndex];
      if (arg === "--") {
        argIndex++;
        break;
      }
      if (arg === "-v") {
        if (argIndex + 1 >= args.length) {
          return {
            stdout: "",
            stderr: "printf: -v: option requires an argument\n",
            exitCode: 1
          };
        }
        targetVar = args[argIndex + 1];
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*(\[[^\]]+\])?$/.test(targetVar)) {
          return {
            stdout: "",
            stderr: `printf: \`${targetVar}': not a valid identifier
`,
            exitCode: 2
          };
        }
        argIndex += 2;
      } else if (arg.startsWith("-") && arg !== "-") {
        break;
      } else {
        break;
      }
    }
    if (argIndex >= args.length) {
      return {
        stdout: "",
        stderr: "printf: usage: printf format [arguments]\n",
        exitCode: 1
      };
    }
    const format = args[argIndex];
    const formatArgs = args.slice(argIndex + 1);
    try {
      const processedFormat = processEscapes(format);
      let output = "";
      let argPos = 0;
      let hadError = false;
      let errorMessage = "";
      const tz = ctx.env.TZ;
      do {
        const { result, argsConsumed, error, errMsg, stopped } = formatOnce(processedFormat, formatArgs, argPos, tz);
        output += result;
        argPos += argsConsumed;
        if (error) {
          hadError = true;
          if (errMsg)
            errorMessage = errMsg;
        }
        if (stopped) {
          break;
        }
      } while (argPos < formatArgs.length && argPos > 0);
      if (argPos === 0 && formatArgs.length > 0) {
      }
      if (targetVar) {
        const arrayMatch = targetVar.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[(['"]?)(.+?)\2\]$/);
        if (arrayMatch) {
          const arrayName = arrayMatch[1];
          let key = arrayMatch[3];
          key = key.replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, varName) => {
            return ctx.env[varName] ?? "";
          });
          ctx.env[`${arrayName}_${key}`] = output;
        } else {
          ctx.env[targetVar] = output;
        }
        return { stdout: "", stderr: errorMessage, exitCode: hadError ? 1 : 0 };
      }
      return {
        stdout: output,
        stderr: errorMessage,
        exitCode: hadError ? 1 : 0
      };
    } catch (error) {
      return {
        stdout: "",
        stderr: `printf: ${getErrorMessage(error)}
`,
        exitCode: 1
      };
    }
  }
};
function formatOnce(format, args, argPos, tz) {
  let result = "";
  let i = 0;
  let argsConsumed = 0;
  let error = false;
  let errMsg = "";
  while (i < format.length) {
    if (format[i] === "%" && i + 1 < format.length) {
      const specStart = i;
      i++;
      if (format[i] === "%") {
        result += "%";
        i++;
        continue;
      }
      const strftimeMatch = format.slice(specStart).match(/^%(-?\d*)(?:\.(\d+))?\(([^)]*)\)T/);
      if (strftimeMatch) {
        const width = strftimeMatch[1] ? parseInt(strftimeMatch[1], 10) : 0;
        const precision = strftimeMatch[2] ? parseInt(strftimeMatch[2], 10) : -1;
        const strftimeFmt = strftimeMatch[3];
        const fullMatch = strftimeMatch[0];
        const arg2 = args[argPos + argsConsumed] || "";
        argsConsumed++;
        let timestamp;
        if (arg2 === "" || arg2 === "-1") {
          timestamp = Math.floor(Date.now() / 1e3);
        } else if (arg2 === "-2") {
          timestamp = Math.floor(Date.now() / 1e3);
        } else {
          timestamp = parseInt(arg2, 10) || 0;
        }
        let formatted = formatStrftime(strftimeFmt, timestamp, tz);
        if (precision >= 0 && formatted.length > precision) {
          formatted = formatted.slice(0, precision);
        }
        if (width !== 0) {
          const absWidth = Math.abs(width);
          if (formatted.length < absWidth) {
            if (width < 0) {
              formatted = formatted.padEnd(absWidth, " ");
            } else {
              formatted = formatted.padStart(absWidth, " ");
            }
          }
        }
        result += formatted;
        i = specStart + fullMatch.length;
        continue;
      }
      while (i < format.length && "+-0 #'".includes(format[i])) {
        i++;
      }
      let widthFromArg = false;
      if (format[i] === "*") {
        widthFromArg = true;
        i++;
      } else {
        while (i < format.length && /\d/.test(format[i])) {
          i++;
        }
      }
      let precisionFromArg = false;
      if (format[i] === ".") {
        i++;
        if (format[i] === "*") {
          precisionFromArg = true;
          i++;
        } else {
          while (i < format.length && /\d/.test(format[i])) {
            i++;
          }
        }
      }
      if (i < format.length && "hlL".includes(format[i])) {
        i++;
      }
      const specifier = format[i] || "";
      i++;
      const fullSpec = format.slice(specStart, i);
      let adjustedSpec = fullSpec;
      if (widthFromArg) {
        const w = parseInt(args[argPos + argsConsumed] || "0", 10);
        argsConsumed++;
        adjustedSpec = adjustedSpec.replace("*", String(w));
      }
      if (precisionFromArg) {
        const p = parseInt(args[argPos + argsConsumed] || "0", 10);
        argsConsumed++;
        adjustedSpec = adjustedSpec.replace(".*", `.${p}`);
      }
      const arg = args[argPos + argsConsumed] || "";
      argsConsumed++;
      const { value, parseError, parseErrMsg, stopped } = formatValue(adjustedSpec, specifier, arg);
      result += value;
      if (parseError) {
        error = true;
        if (parseErrMsg)
          errMsg = parseErrMsg;
      }
      if (stopped) {
        return { result, argsConsumed, error, errMsg, stopped: true };
      }
    } else {
      result += format[i];
      i++;
    }
  }
  return { result, argsConsumed, error, errMsg, stopped: false };
}
__name(formatOnce, "formatOnce");
function formatValue(spec, specifier, arg) {
  let parseError = false;
  let parseErrMsg = "";
  switch (specifier) {
    case "d":
    case "i": {
      const num = parseIntArg(arg);
      parseError = lastParseError;
      if (parseError)
        parseErrMsg = `printf: ${arg}: invalid number
`;
      return { value: formatInteger(spec, num), parseError, parseErrMsg };
    }
    case "o": {
      const num = parseIntArg(arg);
      parseError = lastParseError;
      if (parseError)
        parseErrMsg = `printf: ${arg}: invalid number
`;
      return { value: formatOctal(spec, num), parseError, parseErrMsg };
    }
    case "u": {
      const num = parseIntArg(arg);
      parseError = lastParseError;
      if (parseError)
        parseErrMsg = `printf: ${arg}: invalid number
`;
      const unsignedNum = num < 0 ? num >>> 0 : num;
      return {
        value: formatInteger(spec.replace("u", "d"), unsignedNum),
        parseError,
        parseErrMsg
      };
    }
    case "x":
    case "X": {
      const num = parseIntArg(arg);
      parseError = lastParseError;
      if (parseError)
        parseErrMsg = `printf: ${arg}: invalid number
`;
      return { value: formatHex(spec, num), parseError, parseErrMsg };
    }
    case "e":
    case "E":
    case "f":
    case "F":
    case "g":
    case "G": {
      const num = parseFloat(arg) || 0;
      return {
        value: formatFloat(spec, specifier, num),
        parseError: false,
        parseErrMsg: ""
      };
    }
    case "c": {
      if (arg === "") {
        return { value: "", parseError: false, parseErrMsg: "" };
      }
      const encoder = new TextEncoder();
      const bytes = encoder.encode(arg);
      const firstByte = bytes[0];
      return {
        value: String.fromCharCode(firstByte),
        parseError: false,
        parseErrMsg: ""
      };
    }
    case "s":
      return {
        value: formatString(spec, arg),
        parseError: false,
        parseErrMsg: ""
      };
    case "q":
      return {
        value: formatQuoted(spec, arg),
        parseError: false,
        parseErrMsg: ""
      };
    case "b": {
      const bResult = processBEscapes(arg);
      return {
        value: bResult.value,
        parseError: false,
        parseErrMsg: "",
        stopped: bResult.stopped
      };
    }
    default:
      try {
        return {
          value: sprintfExports.sprintf(spec, arg),
          parseError: false,
          parseErrMsg: ""
        };
      } catch {
        return {
          value: "",
          parseError: true,
          parseErrMsg: `printf: [sprintf] unexpected placeholder
`
        };
      }
  }
}
__name(formatValue, "formatValue");
var lastParseError = false;
function parseIntArg(arg) {
  lastParseError = false;
  const trimmed = arg.trimStart();
  const hasTrailingWhitespace = trimmed !== trimmed.trimEnd();
  arg = trimmed.trimEnd();
  if (arg.startsWith("'") && arg.length >= 2) {
    return arg.charCodeAt(1);
  }
  if (arg.startsWith('"') && arg.length >= 2) {
    return arg.charCodeAt(1);
  }
  if (arg.startsWith("\\'") && arg.length >= 3) {
    return arg.charCodeAt(2);
  }
  if (arg.startsWith('\\"') && arg.length >= 3) {
    return arg.charCodeAt(2);
  }
  if (arg.startsWith("+")) {
    arg = arg.slice(1);
  }
  if (arg.startsWith("0x") || arg.startsWith("0X")) {
    const num = parseInt(arg, 16);
    if (Number.isNaN(num)) {
      lastParseError = true;
      return 0;
    }
    if (hasTrailingWhitespace)
      lastParseError = true;
    return num;
  }
  if (arg.startsWith("0") && arg.length > 1 && /^-?0[0-7]+$/.test(arg)) {
    if (hasTrailingWhitespace)
      lastParseError = true;
    return parseInt(arg, 8) || 0;
  }
  if (/^\d+#/.test(arg)) {
    lastParseError = true;
    const match = arg.match(/^(\d+)#/);
    return match ? parseInt(match[1], 10) : 0;
  }
  if (arg !== "" && !/^-?\d+$/.test(arg)) {
    lastParseError = true;
    const num = parseInt(arg, 10);
    return Number.isNaN(num) ? 0 : num;
  }
  if (hasTrailingWhitespace)
    lastParseError = true;
  return parseInt(arg, 10) || 0;
}
__name(parseIntArg, "parseIntArg");
function formatInteger(spec, num) {
  const match = spec.match(/^%([- +#0']*)(\d*)(\.(\d*))?[diu]$/);
  if (!match) {
    return sprintfExports.sprintf(spec.replace(/\.\d*/, ""), num);
  }
  const flags = match[1] || "";
  const width = match[2] ? parseInt(match[2], 10) : 0;
  const precision = match[3] !== void 0 ? match[4] ? parseInt(match[4], 10) : 0 : -1;
  const negative = num < 0;
  const absNum = Math.abs(num);
  let numStr = String(absNum);
  if (precision >= 0) {
    numStr = numStr.padStart(precision, "0");
  }
  let sign = "";
  if (negative) {
    sign = "-";
  } else if (flags.includes("+")) {
    sign = "+";
  } else if (flags.includes(" ")) {
    sign = " ";
  }
  let result = sign + numStr;
  if (width > result.length) {
    if (flags.includes("-")) {
      result = result.padEnd(width, " ");
    } else if (flags.includes("0") && precision < 0) {
      result = sign + numStr.padStart(width - sign.length, "0");
    } else {
      result = result.padStart(width, " ");
    }
  }
  return result;
}
__name(formatInteger, "formatInteger");
function formatOctal(spec, num) {
  const match = spec.match(/^%([- +#0']*)(\d*)(\.(\d*))?o$/);
  if (!match) {
    return sprintfExports.sprintf(spec, num);
  }
  const flags = match[1] || "";
  const width = match[2] ? parseInt(match[2], 10) : 0;
  const precision = match[3] !== void 0 ? match[4] ? parseInt(match[4], 10) : 0 : -1;
  let numStr = Math.abs(num).toString(8);
  if (precision >= 0) {
    numStr = numStr.padStart(precision, "0");
  }
  if (flags.includes("#") && !numStr.startsWith("0")) {
    numStr = `0${numStr}`;
  }
  let result = numStr;
  if (width > result.length) {
    if (flags.includes("-")) {
      result = result.padEnd(width, " ");
    } else if (flags.includes("0") && precision < 0) {
      result = result.padStart(width, "0");
    } else {
      result = result.padStart(width, " ");
    }
  }
  return result;
}
__name(formatOctal, "formatOctal");
function formatHex(spec, num) {
  const isUpper = spec.includes("X");
  const match = spec.match(/^%([- +#0']*)(\d*)(\.(\d*))?[xX]$/);
  if (!match) {
    return sprintfExports.sprintf(spec, num);
  }
  const flags = match[1] || "";
  const width = match[2] ? parseInt(match[2], 10) : 0;
  const precision = match[3] !== void 0 ? match[4] ? parseInt(match[4], 10) : 0 : -1;
  let numStr = Math.abs(num).toString(16);
  if (isUpper)
    numStr = numStr.toUpperCase();
  if (precision >= 0) {
    numStr = numStr.padStart(precision, "0");
  }
  let prefix = "";
  if (flags.includes("#") && num !== 0) {
    prefix = isUpper ? "0X" : "0x";
  }
  let result = prefix + numStr;
  if (width > result.length) {
    if (flags.includes("-")) {
      result = result.padEnd(width, " ");
    } else if (flags.includes("0") && precision < 0) {
      result = prefix + numStr.padStart(width - prefix.length, "0");
    } else {
      result = result.padStart(width, " ");
    }
  }
  return result;
}
__name(formatHex, "formatHex");
function shellQuote(str) {
  if (str === "") {
    return "''";
  }
  if (/^[a-zA-Z0-9_./-]+$/.test(str)) {
    return str;
  }
  const needsDollarQuote = /[\x00-\x1f\x7f-\xff]/.test(str);
  if (needsDollarQuote) {
    let result2 = "$'";
    for (const char of str) {
      const code = char.charCodeAt(0);
      if (char === "'") {
        result2 += "\\'";
      } else if (char === "\\") {
        result2 += "\\\\";
      } else if (char === "\n") {
        result2 += "\\n";
      } else if (char === "	") {
        result2 += "\\t";
      } else if (char === "\r") {
        result2 += "\\r";
      } else if (char === "\x07") {
        result2 += "\\a";
      } else if (char === "\b") {
        result2 += "\\b";
      } else if (char === "\f") {
        result2 += "\\f";
      } else if (char === "\v") {
        result2 += "\\v";
      } else if (char === "\x1B") {
        result2 += "\\E";
      } else if (code < 32 || code >= 127 && code <= 255) {
        result2 += `\\${code.toString(8).padStart(3, "0")}`;
      } else if (char === '"') {
        result2 += '\\"';
      } else {
        result2 += char;
      }
    }
    result2 += "'";
    return result2;
  }
  let result = "";
  for (const char of str) {
    if (" 	|&;<>()$`\\\"'*?[#~=%!{}".includes(char)) {
      result += `\\${char}`;
    } else {
      result += char;
    }
  }
  return result;
}
__name(shellQuote, "shellQuote");
function formatString(spec, str) {
  const match = spec.match(/^%(-?)(\d*)(\.(\d*))?s$/);
  if (!match) {
    return sprintfExports.sprintf(spec.replace(/0+(?=\d)/, ""), str);
  }
  const leftJustify = match[1] === "-";
  const widthVal = match[2] ? parseInt(match[2], 10) : 0;
  const precision = match[3] !== void 0 ? match[4] ? parseInt(match[4], 10) : 0 : -1;
  const width = leftJustify ? -widthVal : widthVal;
  return applyWidth(str, width, precision);
}
__name(formatString, "formatString");
function formatQuoted(spec, str) {
  const quoted = shellQuote(str);
  const match = spec.match(/^%(-?)(\d*)q$/);
  if (!match) {
    return quoted;
  }
  const leftJustify = match[1] === "-";
  const width = match[2] ? parseInt(match[2], 10) : 0;
  let result = quoted;
  if (width > result.length) {
    if (leftJustify) {
      result = result.padEnd(width, " ");
    } else {
      result = result.padStart(width, " ");
    }
  }
  return result;
}
__name(formatQuoted, "formatQuoted");
function formatFloat(spec, specifier, num) {
  const match = spec.match(/^%([- +#0']*)(\d*)(\.(\d*))?[eEfFgG]$/);
  if (!match) {
    return sprintfExports.sprintf(spec, num);
  }
  const flags = match[1] || "";
  const width = match[2] ? parseInt(match[2], 10) : 0;
  const precision = match[3] !== void 0 ? match[4] ? parseInt(match[4], 10) : 0 : 6;
  let result;
  const lowerSpec = specifier.toLowerCase();
  if (lowerSpec === "e") {
    result = num.toExponential(precision);
    result = result.replace(/e([+-])(\d)$/, "e$10$2");
    if (specifier === "E")
      result = result.toUpperCase();
  } else if (lowerSpec === "f") {
    result = num.toFixed(precision);
    if (flags.includes("#") && precision === 0 && !result.includes(".")) {
      result += ".";
    }
  } else if (lowerSpec === "g") {
    result = num.toPrecision(precision || 1);
    if (!flags.includes("#")) {
      result = result.replace(/\.?0+$/, "");
      result = result.replace(/\.?0+e/, "e");
    }
    result = result.replace(/e([+-])(\d)$/, "e$10$2");
    if (specifier === "G")
      result = result.toUpperCase();
  } else {
    result = num.toString();
  }
  if (num >= 0) {
    if (flags.includes("+")) {
      result = `+${result}`;
    } else if (flags.includes(" ")) {
      result = ` ${result}`;
    }
  }
  if (width > result.length) {
    if (flags.includes("-")) {
      result = result.padEnd(width, " ");
    } else if (flags.includes("0")) {
      const signPrefix = result.match(/^[+ -]/)?.[0] || "";
      const numPart = signPrefix ? result.slice(1) : result;
      result = signPrefix + numPart.padStart(width - signPrefix.length, "0");
    } else {
      result = result.padStart(width, " ");
    }
  }
  return result;
}
__name(formatFloat, "formatFloat");
function processBEscapes(str) {
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
        case "c":
          return { value: result, stopped: true };
        case "x": {
          const bytes = [];
          let j = i;
          while (j + 1 < str.length && str[j] === "\\" && str[j + 1] === "x") {
            let hex = "";
            let k = j + 2;
            while (k < str.length && k < j + 4 && /[0-9a-fA-F]/.test(str[k])) {
              hex += str[k];
              k++;
            }
            if (hex) {
              bytes.push(parseInt(hex, 16));
              j = k;
            } else {
              break;
            }
          }
          if (bytes.length > 0) {
            result += decodeUtf8WithRecovery(bytes);
            i = j;
          } else {
            result += "\\x";
            i += 2;
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
        case "0": {
          let octal = "";
          let j = i + 2;
          while (j < str.length && j < i + 5 && /[0-7]/.test(str[j])) {
            octal += str[j];
            j++;
          }
          if (octal) {
            result += String.fromCharCode(parseInt(octal, 8));
          } else {
            result += "\0";
          }
          i = j;
          break;
        }
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
        default:
          result += str[i];
          i++;
      }
    } else {
      result += str[i];
      i++;
    }
  }
  return { value: result, stopped: false };
}
__name(processBEscapes, "processBEscapes");
export {
  printfCommand
};
