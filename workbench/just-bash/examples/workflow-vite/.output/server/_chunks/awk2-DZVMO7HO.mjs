var _a, _b, _c;
import { E as ExecutionLimitError, _ as __name } from "../index.mjs";
import { h as hasHelpFlag, s as showHelp, u as unknownOption } from "./chunk-HAN5425M.mjs";
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
var DEFAULT_MAX_ITERATIONS = 1e4;
var DEFAULT_MAX_RECURSION_DEPTH = 100;
function createRuntimeContext(options = {}) {
  const { fieldSep = /\s+/, maxIterations = DEFAULT_MAX_ITERATIONS, maxRecursionDepth = DEFAULT_MAX_RECURSION_DEPTH, fs, cwd, exec } = options;
  return {
    FS: " ",
    OFS: " ",
    ORS: "\n",
    OFMT: "%.6g",
    NR: 0,
    NF: 0,
    FNR: 0,
    FILENAME: "",
    RSTART: 0,
    RLENGTH: -1,
    SUBSEP: "",
    fields: [],
    line: "",
    vars: {},
    arrays: {},
    arrayAliases: /* @__PURE__ */ new Map(),
    ARGC: 0,
    ARGV: {},
    ENVIRON: {},
    functions: /* @__PURE__ */ new Map(),
    fieldSep,
    maxIterations,
    maxRecursionDepth,
    currentRecursionDepth: 0,
    exitCode: 0,
    shouldExit: false,
    shouldNext: false,
    shouldNextFile: false,
    loopBreak: false,
    loopContinue: false,
    hasReturn: false,
    inEndBlock: false,
    output: "",
    openedFiles: /* @__PURE__ */ new Set(),
    fs,
    cwd,
    exec
  };
}
__name(createRuntimeContext, "createRuntimeContext");
function applyNumericBinaryOp(left, right, operator) {
  switch (operator) {
    case "+":
      return left + right;
    case "-":
      return left - right;
    case "*":
      return left * right;
    case "/":
      return right !== 0 ? left / right : 0;
    case "%":
      return right !== 0 ? left % right : 0;
    case "^":
    case "**":
      return left ** right;
    default:
      return 0;
  }
}
__name(applyNumericBinaryOp, "applyNumericBinaryOp");
function toNumber(val) {
  if (typeof val === "number")
    return val;
  const n = parseFloat(val);
  return Number.isNaN(n) ? 0 : n;
}
__name(toNumber, "toNumber");
function toAwkString(val) {
  if (typeof val === "string")
    return val;
  if (Number.isInteger(val))
    return String(val);
  return String(val);
}
__name(toAwkString, "toAwkString");
async function extractPatternArg(arg, evaluator) {
  if (arg.type === "regex") {
    return arg.pattern;
  }
  let pattern = toAwkString(await evaluator.evalExpr(arg));
  if (pattern.startsWith("/") && pattern.endsWith("/")) {
    pattern = pattern.slice(1, -1);
  }
  return pattern;
}
__name(extractPatternArg, "extractPatternArg");
async function resolveTargetName(targetExpr, evaluator) {
  if (!targetExpr)
    return "$0";
  if (targetExpr.type === "variable") {
    return targetExpr.name;
  }
  if (targetExpr.type === "field") {
    const idx = Math.floor(toNumber(await evaluator.evalExpr(targetExpr.index)));
    return `$${idx}`;
  }
  return "$0";
}
__name(resolveTargetName, "resolveTargetName");
function getTargetValue(targetName, ctx) {
  if (targetName === "$0") {
    return ctx.line;
  }
  if (targetName.startsWith("$")) {
    const idx = parseInt(targetName.slice(1), 10) - 1;
    return ctx.fields[idx] || "";
  }
  return toAwkString(ctx.vars[targetName] ?? "");
}
__name(getTargetValue, "getTargetValue");
function applyTargetValue(targetName, newValue, ctx) {
  if (targetName === "$0") {
    ctx.line = newValue;
    ctx.fields = ctx.FS === " " ? newValue.trim().split(/\s+/).filter(Boolean) : newValue.split(ctx.fieldSep);
    ctx.NF = ctx.fields.length;
  } else if (targetName.startsWith("$")) {
    const idx = parseInt(targetName.slice(1), 10) - 1;
    while (ctx.fields.length <= idx)
      ctx.fields.push("");
    ctx.fields[idx] = newValue;
    ctx.NF = ctx.fields.length;
    ctx.line = ctx.fields.join(ctx.OFS);
  } else {
    ctx.vars[targetName] = newValue;
  }
}
__name(applyTargetValue, "applyTargetValue");
async function awkLength(args, ctx, evaluator) {
  if (args.length === 0) {
    return ctx.line.length;
  }
  const str = toAwkString(await evaluator.evalExpr(args[0]));
  return str.length;
}
__name(awkLength, "awkLength");
async function awkSubstr(args, _ctx, evaluator) {
  if (args.length < 2)
    return "";
  const str = toAwkString(await evaluator.evalExpr(args[0]));
  const start = Math.floor(toNumber(await evaluator.evalExpr(args[1]))) - 1;
  if (args.length >= 3) {
    const len = Math.floor(toNumber(await evaluator.evalExpr(args[2])));
    return str.substr(Math.max(0, start), len);
  }
  return str.substr(Math.max(0, start));
}
__name(awkSubstr, "awkSubstr");
async function awkIndex(args, _ctx, evaluator) {
  if (args.length < 2)
    return 0;
  const str = toAwkString(await evaluator.evalExpr(args[0]));
  const target = toAwkString(await evaluator.evalExpr(args[1]));
  const idx = str.indexOf(target);
  return idx === -1 ? 0 : idx + 1;
}
__name(awkIndex, "awkIndex");
async function awkSplit(args, ctx, evaluator) {
  if (args.length < 2)
    return 0;
  const str = toAwkString(await evaluator.evalExpr(args[0]));
  const arrayExpr = args[1];
  if (arrayExpr.type !== "variable") {
    return 0;
  }
  const arrayName = arrayExpr.name;
  let sep = ctx.FS;
  if (args.length >= 3) {
    const sepExpr = args[2];
    if (sepExpr.type === "regex") {
      sep = new RegExp(sepExpr.pattern);
    } else {
      const sepVal = toAwkString(await evaluator.evalExpr(sepExpr));
      sep = sepVal === " " ? /\s+/ : sepVal;
    }
  } else if (ctx.FS === " ") {
    sep = /\s+/;
  }
  const parts = str.split(sep);
  ctx.arrays[arrayName] = {};
  for (let i = 0; i < parts.length; i++) {
    ctx.arrays[arrayName][String(i + 1)] = parts[i];
  }
  return parts.length;
}
__name(awkSplit, "awkSplit");
async function awkSub(args, ctx, evaluator) {
  if (args.length < 2)
    return 0;
  const pattern = await extractPatternArg(args[0], evaluator);
  const replacement = toAwkString(await evaluator.evalExpr(args[1]));
  const targetName = await resolveTargetName(args[2], evaluator);
  const target = getTargetValue(targetName, ctx);
  try {
    const regex = new RegExp(pattern);
    const newTarget = target.replace(regex, createSubReplacer(replacement));
    const changed = newTarget !== target ? 1 : 0;
    applyTargetValue(targetName, newTarget, ctx);
    return changed;
  } catch {
    return 0;
  }
}
__name(awkSub, "awkSub");
async function awkGsub(args, ctx, evaluator) {
  if (args.length < 2)
    return 0;
  const pattern = await extractPatternArg(args[0], evaluator);
  const replacement = toAwkString(await evaluator.evalExpr(args[1]));
  const targetName = await resolveTargetName(args[2], evaluator);
  const target = getTargetValue(targetName, ctx);
  try {
    const regex = new RegExp(pattern, "g");
    const matches = target.match(regex);
    const count = matches ? matches.length : 0;
    const newTarget = target.replace(regex, createSubReplacer(replacement));
    applyTargetValue(targetName, newTarget, ctx);
    return count;
  } catch {
    return 0;
  }
}
__name(awkGsub, "awkGsub");
function createSubReplacer(replacement) {
  return (match) => {
    let result = "";
    let i = 0;
    while (i < replacement.length) {
      if (replacement[i] === "\\" && i + 1 < replacement.length) {
        const next = replacement[i + 1];
        if (next === "&") {
          result += "&";
          i += 2;
        } else if (next === "\\") {
          result += "\\";
          i += 2;
        } else {
          result += replacement[i + 1];
          i += 2;
        }
      } else if (replacement[i] === "&") {
        result += match;
        i++;
      } else {
        result += replacement[i];
        i++;
      }
    }
    return result;
  };
}
__name(createSubReplacer, "createSubReplacer");
async function awkMatch(args, ctx, evaluator) {
  if (args.length < 2) {
    ctx.RSTART = 0;
    ctx.RLENGTH = -1;
    return 0;
  }
  const str = toAwkString(await evaluator.evalExpr(args[0]));
  const pattern = await extractPatternArg(args[1], evaluator);
  try {
    const regex = new RegExp(pattern);
    const match = regex.exec(str);
    if (match) {
      ctx.RSTART = match.index + 1;
      ctx.RLENGTH = match[0].length;
      return ctx.RSTART;
    }
  } catch {
  }
  ctx.RSTART = 0;
  ctx.RLENGTH = -1;
  return 0;
}
__name(awkMatch, "awkMatch");
async function awkGensub(args, ctx, evaluator) {
  if (args.length < 3)
    return "";
  const pattern = await extractPatternArg(args[0], evaluator);
  const replacement = toAwkString(await evaluator.evalExpr(args[1]));
  const how = toAwkString(await evaluator.evalExpr(args[2]));
  const target = args.length >= 4 ? toAwkString(await evaluator.evalExpr(args[3])) : ctx.line;
  try {
    const isGlobal = how.toLowerCase() === "g";
    const occurrenceNum = isGlobal ? 0 : parseInt(how, 10) || 1;
    if (isGlobal) {
      const regex = new RegExp(pattern, "g");
      return target.replace(regex, (match, ...groups) => processGensub(replacement, match, groups.slice(0, -2)));
    } else {
      let count = 0;
      const regex = new RegExp(pattern, "g");
      return target.replace(regex, (match, ...groups) => {
        count++;
        if (count === occurrenceNum) {
          return processGensub(replacement, match, groups.slice(0, -2));
        }
        return match;
      });
    }
  } catch {
    return target;
  }
}
__name(awkGensub, "awkGensub");
function processGensub(replacement, match, groups) {
  let result = "";
  let i = 0;
  while (i < replacement.length) {
    if (replacement[i] === "\\" && i + 1 < replacement.length) {
      const next = replacement[i + 1];
      if (next === "&") {
        result += "&";
        i += 2;
      } else if (next === "0") {
        result += match;
        i += 2;
      } else if (next >= "1" && next <= "9") {
        const idx = parseInt(next, 10) - 1;
        result += groups[idx] || "";
        i += 2;
      } else if (next === "n") {
        result += "\n";
        i += 2;
      } else if (next === "t") {
        result += "	";
        i += 2;
      } else {
        result += next;
        i += 2;
      }
    } else if (replacement[i] === "&") {
      result += match;
      i++;
    } else {
      result += replacement[i];
      i++;
    }
  }
  return result;
}
__name(processGensub, "processGensub");
async function awkTolower(args, _ctx, evaluator) {
  if (args.length === 0)
    return "";
  return toAwkString(await evaluator.evalExpr(args[0])).toLowerCase();
}
__name(awkTolower, "awkTolower");
async function awkToupper(args, _ctx, evaluator) {
  if (args.length === 0)
    return "";
  return toAwkString(await evaluator.evalExpr(args[0])).toUpperCase();
}
__name(awkToupper, "awkToupper");
async function awkSprintf(args, _ctx, evaluator) {
  if (args.length === 0)
    return "";
  const format = toAwkString(await evaluator.evalExpr(args[0]));
  const values = [];
  for (let i = 1; i < args.length; i++) {
    values.push(await evaluator.evalExpr(args[i]));
  }
  return formatPrintf(format, values);
}
__name(awkSprintf, "awkSprintf");
async function awkInt(args, _ctx, evaluator) {
  if (args.length === 0)
    return 0;
  return Math.floor(toNumber(await evaluator.evalExpr(args[0])));
}
__name(awkInt, "awkInt");
async function awkSqrt(args, _ctx, evaluator) {
  if (args.length === 0)
    return 0;
  return Math.sqrt(toNumber(await evaluator.evalExpr(args[0])));
}
__name(awkSqrt, "awkSqrt");
async function awkSin(args, _ctx, evaluator) {
  if (args.length === 0)
    return 0;
  return Math.sin(toNumber(await evaluator.evalExpr(args[0])));
}
__name(awkSin, "awkSin");
async function awkCos(args, _ctx, evaluator) {
  if (args.length === 0)
    return 0;
  return Math.cos(toNumber(await evaluator.evalExpr(args[0])));
}
__name(awkCos, "awkCos");
async function awkAtan2(args, _ctx, evaluator) {
  const y = args.length > 0 ? toNumber(await evaluator.evalExpr(args[0])) : 0;
  const x = args.length > 1 ? toNumber(await evaluator.evalExpr(args[1])) : 0;
  return Math.atan2(y, x);
}
__name(awkAtan2, "awkAtan2");
async function awkLog(args, _ctx, evaluator) {
  if (args.length === 0)
    return 0;
  return Math.log(toNumber(await evaluator.evalExpr(args[0])));
}
__name(awkLog, "awkLog");
async function awkExp(args, _ctx, evaluator) {
  if (args.length === 0)
    return 1;
  return Math.exp(toNumber(await evaluator.evalExpr(args[0])));
}
__name(awkExp, "awkExp");
function awkRand(_args, ctx, _evaluator) {
  return ctx.random ? ctx.random() : Math.random();
}
__name(awkRand, "awkRand");
async function awkSrand(args, ctx, evaluator) {
  const seed = args.length > 0 ? toNumber(await evaluator.evalExpr(args[0])) : Date.now();
  ctx.vars._srand_seed = seed;
  return seed;
}
__name(awkSrand, "awkSrand");
function unsupported(name, reason) {
  return () => {
    throw new Error(`${name}() is not supported - ${reason}`);
  };
}
__name(unsupported, "unsupported");
function unimplemented(name) {
  return () => {
    throw new Error(`function '${name}()' is not implemented`);
  };
}
__name(unimplemented, "unimplemented");
function formatPrintf(format, values) {
  let valueIdx = 0;
  let result = "";
  let i = 0;
  while (i < format.length) {
    if (format[i] === "%" && i + 1 < format.length) {
      let j = i + 1;
      let flags = "";
      let width = "";
      let precision = "";
      let positionalIdx;
      const posStart = j;
      while (j < format.length && /\d/.test(format[j])) {
        j++;
      }
      if (j > posStart && format[j] === "$") {
        positionalIdx = parseInt(format.substring(posStart, j), 10) - 1;
        j++;
      } else {
        j = posStart;
      }
      const skipLengthMods = /* @__PURE__ */ __name(() => {
        if (j < format.length) {
          if (j + 1 < format.length && (format[j] === "h" && format[j + 1] === "h" || format[j] === "l" && format[j + 1] === "l")) {
            j += 2;
            return;
          }
          if (/[lzjh]/.test(format[j])) {
            j++;
          }
        }
      }, "skipLengthMods");
      while (j < format.length && /[-+ #0]/.test(format[j])) {
        flags += format[j++];
      }
      if (format[j] === "*") {
        const widthVal = values[valueIdx++];
        const w = widthVal !== void 0 ? Math.floor(Number(widthVal)) : 0;
        if (w < 0) {
          flags += "-";
          width = String(-w);
        } else {
          width = String(w);
        }
        j++;
      } else {
        while (j < format.length && /\d/.test(format[j])) {
          width += format[j++];
        }
      }
      if (format[j] === ".") {
        j++;
        if (format[j] === "*") {
          const precVal = values[valueIdx++];
          precision = String(precVal !== void 0 ? Math.floor(Number(precVal)) : 0);
          j++;
        } else {
          while (j < format.length && /\d/.test(format[j])) {
            precision += format[j++];
          }
        }
      }
      skipLengthMods();
      const spec = format[j];
      const valIdx = positionalIdx !== void 0 ? positionalIdx : valueIdx;
      const val = values[valIdx];
      switch (spec) {
        case "s": {
          let str = val !== void 0 ? String(val) : "";
          if (precision) {
            str = str.substring(0, parseInt(precision, 10));
          }
          if (width) {
            const w = parseInt(width, 10);
            if (flags.includes("-")) {
              str = str.padEnd(w);
            } else {
              str = str.padStart(w);
            }
          }
          result += str;
          if (positionalIdx === void 0)
            valueIdx++;
          break;
        }
        case "d":
        case "i": {
          let num = val !== void 0 ? Math.floor(Number(val)) : 0;
          if (Number.isNaN(num))
            num = 0;
          const isNegative = num < 0;
          let digits = Math.abs(num).toString();
          if (precision) {
            const prec = parseInt(precision, 10);
            digits = digits.padStart(prec, "0");
          }
          let sign = "";
          if (isNegative) {
            sign = "-";
          } else if (flags.includes("+")) {
            sign = "+";
          } else if (flags.includes(" ")) {
            sign = " ";
          }
          let str = sign + digits;
          if (width) {
            const w = parseInt(width, 10);
            if (flags.includes("-")) {
              str = str.padEnd(w);
            } else if (flags.includes("0") && !precision) {
              str = sign + digits.padStart(w - sign.length, "0");
            } else {
              str = str.padStart(w);
            }
          }
          result += str;
          if (positionalIdx === void 0)
            valueIdx++;
          break;
        }
        case "f": {
          let num = val !== void 0 ? Number(val) : 0;
          if (Number.isNaN(num))
            num = 0;
          const prec = precision ? parseInt(precision, 10) : 6;
          let str = num.toFixed(prec);
          if (width) {
            const w = parseInt(width, 10);
            if (flags.includes("-")) {
              str = str.padEnd(w);
            } else {
              str = str.padStart(w);
            }
          }
          result += str;
          if (positionalIdx === void 0)
            valueIdx++;
          break;
        }
        case "e":
        case "E": {
          let num = val !== void 0 ? Number(val) : 0;
          if (Number.isNaN(num))
            num = 0;
          const prec = precision ? parseInt(precision, 10) : 6;
          let str = num.toExponential(prec);
          if (spec === "E")
            str = str.toUpperCase();
          if (width) {
            const w = parseInt(width, 10);
            if (flags.includes("-")) {
              str = str.padEnd(w);
            } else {
              str = str.padStart(w);
            }
          }
          result += str;
          if (positionalIdx === void 0)
            valueIdx++;
          break;
        }
        case "g":
        case "G": {
          let num = val !== void 0 ? Number(val) : 0;
          if (Number.isNaN(num))
            num = 0;
          const prec = precision ? parseInt(precision, 10) : 6;
          const exp = num !== 0 ? Math.floor(Math.log10(Math.abs(num))) : 0;
          let str;
          if (num === 0) {
            str = "0";
          } else if (exp < -4 || exp >= prec) {
            str = num.toExponential(prec - 1);
            if (spec === "G")
              str = str.toUpperCase();
          } else {
            str = num.toPrecision(prec);
          }
          if (str.includes(".")) {
            str = str.replace(/\.?0+$/, "").replace(/\.?0+e/, "e");
          }
          if (str.includes("e")) {
            str = str.replace(/\.?0+e/, "e");
          }
          if (width) {
            const w = parseInt(width, 10);
            if (flags.includes("-")) {
              str = str.padEnd(w);
            } else {
              str = str.padStart(w);
            }
          }
          result += str;
          if (positionalIdx === void 0)
            valueIdx++;
          break;
        }
        case "x":
        case "X": {
          let num = val !== void 0 ? Math.floor(Number(val)) : 0;
          if (Number.isNaN(num))
            num = 0;
          let digits = Math.abs(num).toString(16);
          if (spec === "X")
            digits = digits.toUpperCase();
          if (precision) {
            const prec = parseInt(precision, 10);
            digits = digits.padStart(prec, "0");
          }
          const sign = num < 0 ? "-" : "";
          let str = sign + digits;
          if (width) {
            const w = parseInt(width, 10);
            if (flags.includes("-")) {
              str = str.padEnd(w);
            } else if (flags.includes("0") && !precision) {
              str = sign + digits.padStart(w - sign.length, "0");
            } else {
              str = str.padStart(w);
            }
          }
          result += str;
          if (positionalIdx === void 0)
            valueIdx++;
          break;
        }
        case "o": {
          let num = val !== void 0 ? Math.floor(Number(val)) : 0;
          if (Number.isNaN(num))
            num = 0;
          let digits = Math.abs(num).toString(8);
          if (precision) {
            const prec = parseInt(precision, 10);
            digits = digits.padStart(prec, "0");
          }
          const sign = num < 0 ? "-" : "";
          let str = sign + digits;
          if (width) {
            const w = parseInt(width, 10);
            if (flags.includes("-")) {
              str = str.padEnd(w);
            } else if (flags.includes("0") && !precision) {
              str = sign + digits.padStart(w - sign.length, "0");
            } else {
              str = str.padStart(w);
            }
          }
          result += str;
          if (positionalIdx === void 0)
            valueIdx++;
          break;
        }
        case "c": {
          if (typeof val === "number") {
            result += String.fromCharCode(val);
          } else {
            result += String(val ?? "").charAt(0) || "";
          }
          if (positionalIdx === void 0)
            valueIdx++;
          break;
        }
        case "%":
          result += "%";
          break;
        default:
          result += format.substring(i, j + 1);
      }
      i = j + 1;
    } else if (format[i] === "\\" && i + 1 < format.length) {
      const esc = format[i + 1];
      switch (esc) {
        case "n":
          result += "\n";
          break;
        case "t":
          result += "	";
          break;
        case "r":
          result += "\r";
          break;
        case "\\":
          result += "\\";
          break;
        default:
          result += esc;
      }
      i += 2;
    } else {
      result += format[i++];
    }
  }
  return result;
}
__name(formatPrintf, "formatPrintf");
var awkBuiltins = {
  // String functions
  length: awkLength,
  substr: awkSubstr,
  index: awkIndex,
  split: awkSplit,
  sub: awkSub,
  gsub: awkGsub,
  match: awkMatch,
  gensub: awkGensub,
  tolower: awkTolower,
  toupper: awkToupper,
  sprintf: awkSprintf,
  // Math functions
  int: awkInt,
  sqrt: awkSqrt,
  sin: awkSin,
  cos: awkCos,
  atan2: awkAtan2,
  log: awkLog,
  exp: awkExp,
  rand: awkRand,
  srand: awkSrand,
  // Unsupported functions (security/sandboxing)
  system: unsupported("system", "shell execution not allowed in sandboxed environment"),
  // close() and fflush() are no-ops in our environment (no real file handles)
  // Return 0 for success to allow programs that use them to work
  close: /* @__PURE__ */ __name(() => 0, "close"),
  fflush: /* @__PURE__ */ __name(() => 0, "fflush"),
  // Unimplemented functions
  systime: unimplemented("systime"),
  mktime: unimplemented("mktime"),
  strftime: unimplemented("strftime")
};
function isTruthy(val) {
  if (typeof val === "number") {
    return val !== 0;
  }
  if (val === "") {
    return false;
  }
  if (val === "0") {
    return false;
  }
  return true;
}
__name(isTruthy, "isTruthy");
function toNumber2(val) {
  if (typeof val === "number")
    return val;
  const n = parseFloat(val);
  return Number.isNaN(n) ? 0 : n;
}
__name(toNumber2, "toNumber");
function toAwkString2(val) {
  if (typeof val === "string")
    return val;
  if (Number.isInteger(val))
    return String(val);
  return String(val);
}
__name(toAwkString2, "toAwkString");
function looksLikeNumber(val) {
  if (typeof val === "number")
    return true;
  const s = String(val).trim();
  if (s === "")
    return false;
  return !Number.isNaN(Number(s));
}
__name(looksLikeNumber, "looksLikeNumber");
function matchRegex(pattern, text) {
  try {
    return new RegExp(pattern).test(text);
  } catch {
    return false;
  }
}
__name(matchRegex, "matchRegex");
function splitFields(ctx, line) {
  if (line === "") {
    return [];
  }
  if (ctx.FS === " ") {
    return line.trim().split(/\s+/).filter(Boolean);
  }
  return line.split(ctx.fieldSep);
}
__name(splitFields, "splitFields");
function getField(ctx, index) {
  if (index === 0) {
    return ctx.line;
  }
  if (index < 0 || index > ctx.fields.length) {
    return "";
  }
  return ctx.fields[index - 1] ?? "";
}
__name(getField, "getField");
function setField(ctx, index, value) {
  if (index === 0) {
    ctx.line = toAwkString2(value);
    ctx.fields = splitFields(ctx, ctx.line);
    ctx.NF = ctx.fields.length;
  } else if (index > 0) {
    while (ctx.fields.length < index) {
      ctx.fields.push("");
    }
    ctx.fields[index - 1] = toAwkString2(value);
    ctx.NF = ctx.fields.length;
    ctx.line = ctx.fields.join(ctx.OFS);
  }
}
__name(setField, "setField");
function setCurrentLine(ctx, line) {
  ctx.line = line;
  ctx.fields = splitFields(ctx, line);
  ctx.NF = ctx.fields.length;
}
__name(setCurrentLine, "setCurrentLine");
function setFieldSeparator(ctx, fs) {
  ctx.FS = fs;
  if (fs === " ") {
    ctx.fieldSep = /\s+/;
  } else {
    try {
      ctx.fieldSep = new RegExp(fs);
    } catch {
      ctx.fieldSep = new RegExp(fs.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    }
  }
}
__name(setFieldSeparator, "setFieldSeparator");
function getVariable(ctx, name) {
  switch (name) {
    case "FS":
      return ctx.FS;
    case "OFS":
      return ctx.OFS;
    case "ORS":
      return ctx.ORS;
    case "OFMT":
      return ctx.OFMT;
    case "NR":
      return ctx.NR;
    case "NF":
      return ctx.NF;
    case "FNR":
      return ctx.FNR;
    case "FILENAME":
      return ctx.FILENAME;
    case "RSTART":
      return ctx.RSTART;
    case "RLENGTH":
      return ctx.RLENGTH;
    case "SUBSEP":
      return ctx.SUBSEP;
    case "ARGC":
      return ctx.ARGC;
  }
  return ctx.vars[name] ?? "";
}
__name(getVariable, "getVariable");
function setVariable(ctx, name, value) {
  switch (name) {
    case "FS":
      setFieldSeparator(ctx, toAwkString2(value));
      return;
    case "OFS":
      ctx.OFS = toAwkString2(value);
      return;
    case "ORS":
      ctx.ORS = toAwkString2(value);
      return;
    case "OFMT":
      ctx.OFMT = toAwkString2(value);
      return;
    case "NR":
      ctx.NR = Math.floor(toNumber2(value));
      return;
    case "NF": {
      const newNF = Math.floor(toNumber2(value));
      if (newNF < ctx.NF) {
        ctx.fields = ctx.fields.slice(0, newNF);
        ctx.line = ctx.fields.join(ctx.OFS);
      } else if (newNF > ctx.NF) {
        while (ctx.fields.length < newNF) {
          ctx.fields.push("");
        }
        ctx.line = ctx.fields.join(ctx.OFS);
      }
      ctx.NF = newNF;
      return;
    }
    case "FNR":
      ctx.FNR = Math.floor(toNumber2(value));
      return;
    case "FILENAME":
      ctx.FILENAME = toAwkString2(value);
      return;
    case "RSTART":
      ctx.RSTART = Math.floor(toNumber2(value));
      return;
    case "RLENGTH":
      ctx.RLENGTH = Math.floor(toNumber2(value));
      return;
    case "SUBSEP":
      ctx.SUBSEP = toAwkString2(value);
      return;
  }
  ctx.vars[name] = value;
}
__name(setVariable, "setVariable");
function resolveArrayName(ctx, array) {
  let resolved = array;
  const seen = /* @__PURE__ */ new Set();
  let alias = ctx.arrayAliases.get(resolved);
  while (alias !== void 0 && !seen.has(resolved)) {
    seen.add(resolved);
    resolved = alias;
    alias = ctx.arrayAliases.get(resolved);
  }
  return resolved;
}
__name(resolveArrayName, "resolveArrayName");
function getArrayElement(ctx, array, key) {
  if (array === "ARGV") {
    return ctx.ARGV[key] ?? "";
  }
  if (array === "ENVIRON") {
    return ctx.ENVIRON[key] ?? "";
  }
  const resolvedArray = resolveArrayName(ctx, array);
  return ctx.arrays[resolvedArray]?.[key] ?? "";
}
__name(getArrayElement, "getArrayElement");
function setArrayElement(ctx, array, key, value) {
  const resolvedArray = resolveArrayName(ctx, array);
  if (!ctx.arrays[resolvedArray]) {
    ctx.arrays[resolvedArray] = {};
  }
  ctx.arrays[resolvedArray][key] = value;
}
__name(setArrayElement, "setArrayElement");
function hasArrayElement(ctx, array, key) {
  if (array === "ARGV") {
    return ctx.ARGV[key] !== void 0;
  }
  if (array === "ENVIRON") {
    return ctx.ENVIRON[key] !== void 0;
  }
  const resolvedArray = resolveArrayName(ctx, array);
  return ctx.arrays[resolvedArray]?.[key] !== void 0;
}
__name(hasArrayElement, "hasArrayElement");
function deleteArrayElement(ctx, array, key) {
  const resolvedArray = resolveArrayName(ctx, array);
  if (ctx.arrays[resolvedArray]) {
    delete ctx.arrays[resolvedArray][key];
  }
}
__name(deleteArrayElement, "deleteArrayElement");
function deleteArray(ctx, array) {
  const resolvedArray = resolveArrayName(ctx, array);
  delete ctx.arrays[resolvedArray];
}
__name(deleteArray, "deleteArray");
var executeBlockFn = null;
function setBlockExecutor(fn) {
  executeBlockFn = fn;
}
__name(setBlockExecutor, "setBlockExecutor");
async function evalExpr(ctx, expr) {
  switch (expr.type) {
    case "number":
      return expr.value;
    case "string":
      return expr.value;
    case "regex":
      return matchRegex(expr.pattern, ctx.line) ? 1 : 0;
    case "field":
      return evalFieldRef(ctx, expr);
    case "variable":
      return getVariable(ctx, expr.name);
    case "array_access":
      return evalArrayAccess(ctx, expr);
    case "binary":
      return evalBinaryOp(ctx, expr);
    case "unary":
      return evalUnaryOp(ctx, expr);
    case "ternary":
      return isTruthy(await evalExpr(ctx, expr.condition)) ? await evalExpr(ctx, expr.consequent) : await evalExpr(ctx, expr.alternate);
    case "call":
      return evalFunctionCall(ctx, expr.name, expr.args);
    case "assignment":
      return evalAssignment(ctx, expr);
    case "pre_increment":
      return evalPreIncrement(ctx, expr.operand);
    case "pre_decrement":
      return evalPreDecrement(ctx, expr.operand);
    case "post_increment":
      return evalPostIncrement(ctx, expr.operand);
    case "post_decrement":
      return evalPostDecrement(ctx, expr.operand);
    case "in":
      return evalInExpr(ctx, expr.key, expr.array);
    case "getline":
      return evalGetline(ctx, expr.variable, expr.file, expr.command);
    case "tuple":
      return evalTuple(ctx, expr.elements);
    default:
      return "";
  }
}
__name(evalExpr, "evalExpr");
async function evalFieldRef(ctx, expr) {
  const index = Math.floor(toNumber2(await evalExpr(ctx, expr.index)));
  return getField(ctx, index);
}
__name(evalFieldRef, "evalFieldRef");
async function evalArrayAccess(ctx, expr) {
  const key = toAwkString2(await evalExpr(ctx, expr.key));
  return getArrayElement(ctx, expr.array, key);
}
__name(evalArrayAccess, "evalArrayAccess");
async function evalBinaryOp(ctx, expr) {
  const op = expr.operator;
  if (op === "||") {
    return isTruthy(await evalExpr(ctx, expr.left)) || isTruthy(await evalExpr(ctx, expr.right)) ? 1 : 0;
  }
  if (op === "&&") {
    return isTruthy(await evalExpr(ctx, expr.left)) && isTruthy(await evalExpr(ctx, expr.right)) ? 1 : 0;
  }
  if (op === "~") {
    const left2 = await evalExpr(ctx, expr.left);
    const pattern = expr.right.type === "regex" ? expr.right.pattern : toAwkString2(await evalExpr(ctx, expr.right));
    try {
      return new RegExp(pattern).test(toAwkString2(left2)) ? 1 : 0;
    } catch {
      return 0;
    }
  }
  if (op === "!~") {
    const left2 = await evalExpr(ctx, expr.left);
    const pattern = expr.right.type === "regex" ? expr.right.pattern : toAwkString2(await evalExpr(ctx, expr.right));
    try {
      return new RegExp(pattern).test(toAwkString2(left2)) ? 0 : 1;
    } catch {
      return 1;
    }
  }
  const left = await evalExpr(ctx, expr.left);
  const right = await evalExpr(ctx, expr.right);
  if (op === " ") {
    return toAwkString2(left) + toAwkString2(right);
  }
  if (isComparisonOp(op)) {
    return evalComparison(left, right, op);
  }
  const leftNum = toNumber2(left);
  const rightNum = toNumber2(right);
  return applyNumericBinaryOp(leftNum, rightNum, op);
}
__name(evalBinaryOp, "evalBinaryOp");
function isComparisonOp(op) {
  return ["<", "<=", ">", ">=", "==", "!="].includes(op);
}
__name(isComparisonOp, "isComparisonOp");
function evalComparison(left, right, op) {
  const leftIsNum = looksLikeNumber(left);
  const rightIsNum = looksLikeNumber(right);
  if (leftIsNum && rightIsNum) {
    const l2 = toNumber2(left);
    const r2 = toNumber2(right);
    switch (op) {
      case "<":
        return l2 < r2 ? 1 : 0;
      case "<=":
        return l2 <= r2 ? 1 : 0;
      case ">":
        return l2 > r2 ? 1 : 0;
      case ">=":
        return l2 >= r2 ? 1 : 0;
      case "==":
        return l2 === r2 ? 1 : 0;
      case "!=":
        return l2 !== r2 ? 1 : 0;
    }
  }
  const l = toAwkString2(left);
  const r = toAwkString2(right);
  switch (op) {
    case "<":
      return l < r ? 1 : 0;
    case "<=":
      return l <= r ? 1 : 0;
    case ">":
      return l > r ? 1 : 0;
    case ">=":
      return l >= r ? 1 : 0;
    case "==":
      return l === r ? 1 : 0;
    case "!=":
      return l !== r ? 1 : 0;
  }
  return 0;
}
__name(evalComparison, "evalComparison");
async function evalUnaryOp(ctx, expr) {
  const val = await evalExpr(ctx, expr.operand);
  switch (expr.operator) {
    case "!":
      return isTruthy(val) ? 0 : 1;
    case "-":
      return -toNumber2(val);
    case "+":
      return +toNumber2(val);
    default:
      return val;
  }
}
__name(evalUnaryOp, "evalUnaryOp");
async function evalFunctionCall(ctx, name, args) {
  const builtin = awkBuiltins[name];
  if (builtin) {
    return builtin(args, ctx, { evalExpr: /* @__PURE__ */ __name((e) => evalExpr(ctx, e), "evalExpr") });
  }
  const userFunc = ctx.functions.get(name);
  if (userFunc) {
    return callUserFunction(ctx, userFunc, args);
  }
  return "";
}
__name(evalFunctionCall, "evalFunctionCall");
async function callUserFunction(ctx, func, args) {
  ctx.currentRecursionDepth++;
  if (ctx.currentRecursionDepth > ctx.maxRecursionDepth) {
    ctx.currentRecursionDepth--;
    throw new ExecutionLimitError(`awk: recursion depth exceeded maximum (${ctx.maxRecursionDepth})`, "recursion", ctx.output);
  }
  const savedParams = {};
  for (const param of func.params) {
    savedParams[param] = ctx.vars[param];
  }
  const createdAliases = [];
  for (let i = 0; i < func.params.length; i++) {
    const param = func.params[i];
    if (i < args.length) {
      const arg = args[i];
      if (arg.type === "variable") {
        ctx.arrayAliases.set(param, arg.name);
        createdAliases.push(param);
      }
      const value = await evalExpr(ctx, arg);
      ctx.vars[param] = value;
    } else {
      ctx.vars[param] = "";
    }
  }
  ctx.hasReturn = false;
  ctx.returnValue = void 0;
  if (executeBlockFn) {
    await executeBlockFn(ctx, func.body.statements);
  }
  const result = ctx.returnValue ?? "";
  for (const param of func.params) {
    if (savedParams[param] !== void 0) {
      ctx.vars[param] = savedParams[param];
    } else {
      delete ctx.vars[param];
    }
  }
  for (const alias of createdAliases) {
    ctx.arrayAliases.delete(alias);
  }
  ctx.hasReturn = false;
  ctx.returnValue = void 0;
  ctx.currentRecursionDepth--;
  return result;
}
__name(callUserFunction, "callUserFunction");
async function evalAssignment(ctx, expr) {
  const value = await evalExpr(ctx, expr.value);
  const target = expr.target;
  const op = expr.operator;
  let finalValue;
  if (op === "=") {
    finalValue = value;
  } else {
    let current;
    if (target.type === "field") {
      const index = Math.floor(toNumber2(await evalExpr(ctx, target.index)));
      current = getField(ctx, index);
    } else if (target.type === "variable") {
      current = getVariable(ctx, target.name);
    } else {
      const key = toAwkString2(await evalExpr(ctx, target.key));
      current = getArrayElement(ctx, target.array, key);
    }
    const currentNum = toNumber2(current);
    const valueNum = toNumber2(value);
    switch (op) {
      case "+=":
        finalValue = currentNum + valueNum;
        break;
      case "-=":
        finalValue = currentNum - valueNum;
        break;
      case "*=":
        finalValue = currentNum * valueNum;
        break;
      case "/=":
        finalValue = valueNum !== 0 ? currentNum / valueNum : 0;
        break;
      case "%=":
        finalValue = valueNum !== 0 ? currentNum % valueNum : 0;
        break;
      case "^=":
        finalValue = currentNum ** valueNum;
        break;
      default:
        finalValue = value;
    }
  }
  if (target.type === "field") {
    const index = Math.floor(toNumber2(await evalExpr(ctx, target.index)));
    setField(ctx, index, finalValue);
  } else if (target.type === "variable") {
    setVariable(ctx, target.name, finalValue);
  } else {
    const key = toAwkString2(await evalExpr(ctx, target.key));
    setArrayElement(ctx, target.array, key, finalValue);
  }
  return finalValue;
}
__name(evalAssignment, "evalAssignment");
async function applyIncDec(ctx, operand, delta, returnNew) {
  let oldVal;
  if (operand.type === "field") {
    const index = Math.floor(toNumber2(await evalExpr(ctx, operand.index)));
    oldVal = toNumber2(getField(ctx, index));
    setField(ctx, index, oldVal + delta);
  } else if (operand.type === "variable") {
    oldVal = toNumber2(getVariable(ctx, operand.name));
    setVariable(ctx, operand.name, oldVal + delta);
  } else {
    const key = toAwkString2(await evalExpr(ctx, operand.key));
    oldVal = toNumber2(getArrayElement(ctx, operand.array, key));
    setArrayElement(ctx, operand.array, key, oldVal + delta);
  }
  return returnNew ? oldVal + delta : oldVal;
}
__name(applyIncDec, "applyIncDec");
async function evalPreIncrement(ctx, operand) {
  return applyIncDec(ctx, operand, 1, true);
}
__name(evalPreIncrement, "evalPreIncrement");
async function evalPreDecrement(ctx, operand) {
  return applyIncDec(ctx, operand, -1, true);
}
__name(evalPreDecrement, "evalPreDecrement");
async function evalPostIncrement(ctx, operand) {
  return applyIncDec(ctx, operand, 1, false);
}
__name(evalPostIncrement, "evalPostIncrement");
async function evalPostDecrement(ctx, operand) {
  return applyIncDec(ctx, operand, -1, false);
}
__name(evalPostDecrement, "evalPostDecrement");
async function evalInExpr(ctx, key, array) {
  let keyStr;
  if (key.type === "tuple") {
    const parts = [];
    for (const e of key.elements) {
      parts.push(toAwkString2(await evalExpr(ctx, e)));
    }
    keyStr = parts.join(ctx.SUBSEP);
  } else {
    keyStr = toAwkString2(await evalExpr(ctx, key));
  }
  return hasArrayElement(ctx, array, keyStr) ? 1 : 0;
}
__name(evalInExpr, "evalInExpr");
async function evalGetline(ctx, variable, file, command) {
  if (command) {
    return evalGetlineFromCommand(ctx, variable, command);
  }
  if (file) {
    return evalGetlineFromFile(ctx, variable, file);
  }
  if (!ctx.lines || ctx.lineIndex === void 0) {
    return -1;
  }
  const nextLineIndex = ctx.lineIndex + 1;
  if (nextLineIndex >= ctx.lines.length) {
    return 0;
  }
  const nextLine = ctx.lines[nextLineIndex];
  if (variable) {
    setVariable(ctx, variable, nextLine);
  } else {
    setCurrentLine(ctx, nextLine);
  }
  ctx.NR++;
  ctx.lineIndex = nextLineIndex;
  return 1;
}
__name(evalGetline, "evalGetline");
async function evalGetlineFromCommand(ctx, variable, cmdExpr) {
  if (!ctx.exec) {
    return -1;
  }
  const cmd = toAwkString2(await evalExpr(ctx, cmdExpr));
  const cacheKey = `__cmd_${cmd}`;
  const indexKey = `__cmdi_${cmd}`;
  let lines;
  let lineIndex;
  if (ctx.vars[cacheKey] === void 0) {
    try {
      const result = await ctx.exec(cmd);
      const output = result.stdout;
      lines = output.split("\n");
      if (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
      }
      ctx.vars[cacheKey] = JSON.stringify(lines);
      ctx.vars[indexKey] = -1;
      lineIndex = -1;
    } catch {
      return -1;
    }
  } else {
    lines = JSON.parse(ctx.vars[cacheKey]);
    lineIndex = ctx.vars[indexKey];
  }
  const nextIndex = lineIndex + 1;
  if (nextIndex >= lines.length) {
    return 0;
  }
  const line = lines[nextIndex];
  ctx.vars[indexKey] = nextIndex;
  if (variable) {
    setVariable(ctx, variable, line);
  } else {
    setCurrentLine(ctx, line);
  }
  return 1;
}
__name(evalGetlineFromCommand, "evalGetlineFromCommand");
async function evalGetlineFromFile(ctx, variable, fileExpr) {
  if (!ctx.fs || !ctx.cwd) {
    return -1;
  }
  const filename = toAwkString2(await evalExpr(ctx, fileExpr));
  if (filename === "/dev/null") {
    return 0;
  }
  const filePath = ctx.fs.resolvePath(ctx.cwd, filename);
  const cacheKey = `__fc_${filePath}`;
  const indexKey = `__fi_${filePath}`;
  let lines;
  let lineIndex;
  if (ctx.vars[cacheKey] === void 0) {
    try {
      const content = await ctx.fs.readFile(filePath);
      lines = content.split("\n");
      if (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
      }
      ctx.vars[cacheKey] = JSON.stringify(lines);
      ctx.vars[indexKey] = -1;
      lineIndex = -1;
    } catch {
      return -1;
    }
  } else {
    lines = JSON.parse(ctx.vars[cacheKey]);
    lineIndex = ctx.vars[indexKey];
  }
  const nextIndex = lineIndex + 1;
  if (nextIndex >= lines.length) {
    return 0;
  }
  const line = lines[nextIndex];
  ctx.vars[indexKey] = nextIndex;
  if (variable) {
    setVariable(ctx, variable, line);
  } else {
    setCurrentLine(ctx, line);
  }
  return 1;
}
__name(evalGetlineFromFile, "evalGetlineFromFile");
async function evalTuple(ctx, elements) {
  if (elements.length === 0)
    return "";
  for (let i = 0; i < elements.length - 1; i++) {
    await evalExpr(ctx, elements[i]);
  }
  return evalExpr(ctx, elements[elements.length - 1]);
}
__name(evalTuple, "evalTuple");
setBlockExecutor(executeBlock);
async function executeBlock(ctx, statements) {
  for (const stmt of statements) {
    await executeStmt(ctx, stmt);
    if (shouldBreakExecution(ctx)) {
      break;
    }
  }
}
__name(executeBlock, "executeBlock");
function shouldBreakExecution(ctx) {
  return ctx.shouldExit || ctx.shouldNext || ctx.shouldNextFile || ctx.loopBreak || ctx.loopContinue || ctx.hasReturn;
}
__name(shouldBreakExecution, "shouldBreakExecution");
async function executeStmt(ctx, stmt) {
  switch (stmt.type) {
    case "block":
      await executeBlock(ctx, stmt.statements);
      break;
    case "expr_stmt":
      await evalExpr(ctx, stmt.expression);
      break;
    case "print":
      await executePrint(ctx, stmt.args, stmt.output);
      break;
    case "printf":
      await executePrintf(ctx, stmt.format, stmt.args, stmt.output);
      break;
    case "if":
      await executeIf(ctx, stmt);
      break;
    case "while":
      await executeWhile(ctx, stmt);
      break;
    case "do_while":
      await executeDoWhile(ctx, stmt);
      break;
    case "for":
      await executeFor(ctx, stmt);
      break;
    case "for_in":
      await executeForIn(ctx, stmt);
      break;
    case "break":
      ctx.loopBreak = true;
      break;
    case "continue":
      ctx.loopContinue = true;
      break;
    case "next":
      ctx.shouldNext = true;
      break;
    case "nextfile":
      ctx.shouldNextFile = true;
      break;
    case "exit":
      ctx.shouldExit = true;
      ctx.exitCode = stmt.code ? Math.floor(toNumber2(await evalExpr(ctx, stmt.code))) : 0;
      break;
    case "return":
      ctx.hasReturn = true;
      ctx.returnValue = stmt.value ? await evalExpr(ctx, stmt.value) : "";
      break;
    case "delete":
      await executeDelete(ctx, stmt.target);
      break;
  }
}
__name(executeStmt, "executeStmt");
async function executePrint(ctx, args, output) {
  const values = [];
  for (const arg of args) {
    const val = await evalExpr(ctx, arg);
    if (typeof val === "number") {
      if (Number.isInteger(val) && Math.abs(val) < Number.MAX_SAFE_INTEGER) {
        values.push(String(val));
      } else {
        values.push(formatPrintf(ctx.OFMT, [val]));
      }
    } else {
      values.push(toAwkString2(val));
    }
  }
  const text = values.join(ctx.OFS) + ctx.ORS;
  if (output) {
    await writeToFile(ctx, output.redirect, output.file, text);
  } else {
    ctx.output += text;
  }
}
__name(executePrint, "executePrint");
async function executePrintf(ctx, format, args, output) {
  const formatStr = toAwkString2(await evalExpr(ctx, format));
  const values = [];
  for (const arg of args) {
    values.push(await evalExpr(ctx, arg));
  }
  const text = formatPrintf(formatStr, values);
  if (output) {
    await writeToFile(ctx, output.redirect, output.file, text);
  } else {
    ctx.output += text;
  }
}
__name(executePrintf, "executePrintf");
async function writeToFile(ctx, redirect, fileExpr, text) {
  if (!ctx.fs || !ctx.cwd) {
    ctx.output += text;
    return;
  }
  const filename = toAwkString2(await evalExpr(ctx, fileExpr));
  const filePath = ctx.fs.resolvePath(ctx.cwd, filename);
  if (redirect === ">") {
    if (!ctx.openedFiles.has(filePath)) {
      await ctx.fs.writeFile(filePath, text);
      ctx.openedFiles.add(filePath);
    } else {
      await ctx.fs.appendFile(filePath, text);
    }
  } else {
    if (!ctx.openedFiles.has(filePath)) {
      ctx.openedFiles.add(filePath);
    }
    await ctx.fs.appendFile(filePath, text);
  }
}
__name(writeToFile, "writeToFile");
async function executeIf(ctx, stmt) {
  if (isTruthy(await evalExpr(ctx, stmt.condition))) {
    await executeStmt(ctx, stmt.consequent);
  } else if (stmt.alternate) {
    await executeStmt(ctx, stmt.alternate);
  }
}
__name(executeIf, "executeIf");
async function executeWhile(ctx, stmt) {
  let iterations = 0;
  while (isTruthy(await evalExpr(ctx, stmt.condition))) {
    iterations++;
    if (iterations > ctx.maxIterations) {
      throw new ExecutionLimitError(`awk: while loop exceeded maximum iterations (${ctx.maxIterations})`, "iterations", ctx.output);
    }
    ctx.loopContinue = false;
    await executeStmt(ctx, stmt.body);
    if (ctx.loopBreak) {
      ctx.loopBreak = false;
      break;
    }
    if (ctx.shouldExit || ctx.shouldNext || ctx.hasReturn) {
      break;
    }
  }
}
__name(executeWhile, "executeWhile");
async function executeDoWhile(ctx, stmt) {
  let iterations = 0;
  do {
    iterations++;
    if (iterations > ctx.maxIterations) {
      throw new ExecutionLimitError(`awk: do-while loop exceeded maximum iterations (${ctx.maxIterations})`, "iterations", ctx.output);
    }
    ctx.loopContinue = false;
    await executeStmt(ctx, stmt.body);
    if (ctx.loopBreak) {
      ctx.loopBreak = false;
      break;
    }
    if (ctx.shouldExit || ctx.shouldNext || ctx.hasReturn) {
      break;
    }
  } while (isTruthy(await evalExpr(ctx, stmt.condition)));
}
__name(executeDoWhile, "executeDoWhile");
async function executeFor(ctx, stmt) {
  if (stmt.init) {
    await evalExpr(ctx, stmt.init);
  }
  let iterations = 0;
  while (!stmt.condition || isTruthy(await evalExpr(ctx, stmt.condition))) {
    iterations++;
    if (iterations > ctx.maxIterations) {
      throw new ExecutionLimitError(`awk: for loop exceeded maximum iterations (${ctx.maxIterations})`, "iterations", ctx.output);
    }
    ctx.loopContinue = false;
    await executeStmt(ctx, stmt.body);
    if (ctx.loopBreak) {
      ctx.loopBreak = false;
      break;
    }
    if (ctx.shouldExit || ctx.shouldNext || ctx.hasReturn) {
      break;
    }
    if (stmt.update) {
      await evalExpr(ctx, stmt.update);
    }
  }
}
__name(executeFor, "executeFor");
async function executeForIn(ctx, stmt) {
  const array = ctx.arrays[stmt.array];
  if (!array)
    return;
  for (const key of Object.keys(array)) {
    ctx.vars[stmt.variable] = key;
    ctx.loopContinue = false;
    await executeStmt(ctx, stmt.body);
    if (ctx.loopBreak) {
      ctx.loopBreak = false;
      break;
    }
    if (ctx.shouldExit || ctx.shouldNext || ctx.hasReturn) {
      break;
    }
  }
}
__name(executeForIn, "executeForIn");
async function executeDelete(ctx, target) {
  if (target.type === "array_access") {
    const key = toAwkString2(await evalExpr(ctx, target.key));
    deleteArrayElement(ctx, target.array, key);
  } else if (target.type === "variable") {
    deleteArray(ctx, target.name);
  }
}
__name(executeDelete, "executeDelete");
var AwkInterpreter = (_a = class {
  ctx;
  program = null;
  rangeStates = [];
  constructor(ctx) {
    this.ctx = ctx;
  }
  /**
   * Initialize the interpreter with a program.
   * Must be called before executeBegin/executeLine/executeEnd.
   */
  execute(program) {
    this.program = program;
    this.ctx.output = "";
    for (const func of program.functions) {
      this.ctx.functions.set(func.name, func);
    }
    this.rangeStates = program.rules.map(() => false);
  }
  /**
   * Execute all BEGIN blocks.
   */
  async executeBegin() {
    if (!this.program)
      return;
    for (const rule of this.program.rules) {
      if (rule.pattern?.type === "begin") {
        await executeBlock(this.ctx, rule.action.statements);
        if (this.ctx.shouldExit)
          break;
      }
    }
  }
  /**
   * Execute rules for a single input line.
   */
  async executeLine(line) {
    if (!this.program || this.ctx.shouldExit)
      return;
    setCurrentLine(this.ctx, line);
    this.ctx.NR++;
    this.ctx.FNR++;
    this.ctx.shouldNext = false;
    for (let i = 0; i < this.program.rules.length; i++) {
      if (this.ctx.shouldExit || this.ctx.shouldNext || this.ctx.shouldNextFile)
        break;
      const rule = this.program.rules[i];
      if (rule.pattern?.type === "begin" || rule.pattern?.type === "end") {
        continue;
      }
      if (await this.matchesRule(rule, i)) {
        await executeBlock(this.ctx, rule.action.statements);
      }
    }
  }
  /**
   * Execute all END blocks.
   * END blocks run even after exit is called, but exit from within
   * an END block stops further END block execution.
   */
  async executeEnd() {
    if (!this.program)
      return;
    if (this.ctx.inEndBlock)
      return;
    this.ctx.inEndBlock = true;
    this.ctx.shouldExit = false;
    for (const rule of this.program.rules) {
      if (rule.pattern?.type === "end") {
        await executeBlock(this.ctx, rule.action.statements);
        if (this.ctx.shouldExit)
          break;
      }
    }
    this.ctx.inEndBlock = false;
  }
  /**
   * Get the accumulated output.
   */
  getOutput() {
    return this.ctx.output;
  }
  /**
   * Get the exit code.
   */
  getExitCode() {
    return this.ctx.exitCode;
  }
  /**
   * Get the runtime context (for access to control flow flags, etc.)
   */
  getContext() {
    return this.ctx;
  }
  /**
   * Check if a rule matches the current line.
   */
  async matchesRule(rule, ruleIndex) {
    const pattern = rule.pattern;
    if (!pattern)
      return true;
    switch (pattern.type) {
      case "begin":
      case "end":
        return false;
      case "regex_pattern":
        return matchRegex(pattern.pattern, this.ctx.line);
      case "expr_pattern":
        return isTruthy(await evalExpr(this.ctx, pattern.expression));
      case "range": {
        const startMatches = await this.matchPattern(pattern.start);
        const endMatches = await this.matchPattern(pattern.end);
        if (!this.rangeStates[ruleIndex]) {
          if (startMatches) {
            this.rangeStates[ruleIndex] = true;
            if (endMatches) {
              this.rangeStates[ruleIndex] = false;
            }
            return true;
          }
          return false;
        } else {
          if (endMatches) {
            this.rangeStates[ruleIndex] = false;
          }
          return true;
        }
      }
      default:
        return false;
    }
  }
  /**
   * Check if a pattern matches.
   */
  async matchPattern(pattern) {
    switch (pattern.type) {
      case "regex_pattern":
        return matchRegex(pattern.pattern, this.ctx.line);
      case "expr_pattern":
        return isTruthy(await evalExpr(this.ctx, pattern.expression));
      default:
        return false;
    }
  }
}, __name(_a, "AwkInterpreter"), _a);
var TokenType;
(function(TokenType2) {
  TokenType2["NUMBER"] = "NUMBER";
  TokenType2["STRING"] = "STRING";
  TokenType2["REGEX"] = "REGEX";
  TokenType2["IDENT"] = "IDENT";
  TokenType2["BEGIN"] = "BEGIN";
  TokenType2["END"] = "END";
  TokenType2["IF"] = "IF";
  TokenType2["ELSE"] = "ELSE";
  TokenType2["WHILE"] = "WHILE";
  TokenType2["DO"] = "DO";
  TokenType2["FOR"] = "FOR";
  TokenType2["IN"] = "IN";
  TokenType2["BREAK"] = "BREAK";
  TokenType2["CONTINUE"] = "CONTINUE";
  TokenType2["NEXT"] = "NEXT";
  TokenType2["NEXTFILE"] = "NEXTFILE";
  TokenType2["EXIT"] = "EXIT";
  TokenType2["RETURN"] = "RETURN";
  TokenType2["DELETE"] = "DELETE";
  TokenType2["FUNCTION"] = "FUNCTION";
  TokenType2["PRINT"] = "PRINT";
  TokenType2["PRINTF"] = "PRINTF";
  TokenType2["GETLINE"] = "GETLINE";
  TokenType2["PLUS"] = "PLUS";
  TokenType2["MINUS"] = "MINUS";
  TokenType2["STAR"] = "STAR";
  TokenType2["SLASH"] = "SLASH";
  TokenType2["PERCENT"] = "PERCENT";
  TokenType2["CARET"] = "CARET";
  TokenType2["EQ"] = "EQ";
  TokenType2["NE"] = "NE";
  TokenType2["LT"] = "LT";
  TokenType2["GT"] = "GT";
  TokenType2["LE"] = "LE";
  TokenType2["GE"] = "GE";
  TokenType2["MATCH"] = "MATCH";
  TokenType2["NOT_MATCH"] = "NOT_MATCH";
  TokenType2["AND"] = "AND";
  TokenType2["OR"] = "OR";
  TokenType2["NOT"] = "NOT";
  TokenType2["ASSIGN"] = "ASSIGN";
  TokenType2["PLUS_ASSIGN"] = "PLUS_ASSIGN";
  TokenType2["MINUS_ASSIGN"] = "MINUS_ASSIGN";
  TokenType2["STAR_ASSIGN"] = "STAR_ASSIGN";
  TokenType2["SLASH_ASSIGN"] = "SLASH_ASSIGN";
  TokenType2["PERCENT_ASSIGN"] = "PERCENT_ASSIGN";
  TokenType2["CARET_ASSIGN"] = "CARET_ASSIGN";
  TokenType2["INCREMENT"] = "INCREMENT";
  TokenType2["DECREMENT"] = "DECREMENT";
  TokenType2["QUESTION"] = "QUESTION";
  TokenType2["COLON"] = "COLON";
  TokenType2["COMMA"] = "COMMA";
  TokenType2["SEMICOLON"] = "SEMICOLON";
  TokenType2["NEWLINE"] = "NEWLINE";
  TokenType2["LPAREN"] = "LPAREN";
  TokenType2["RPAREN"] = "RPAREN";
  TokenType2["LBRACE"] = "LBRACE";
  TokenType2["RBRACE"] = "RBRACE";
  TokenType2["LBRACKET"] = "LBRACKET";
  TokenType2["RBRACKET"] = "RBRACKET";
  TokenType2["DOLLAR"] = "DOLLAR";
  TokenType2["APPEND"] = "APPEND";
  TokenType2["PIPE"] = "PIPE";
  TokenType2["EOF"] = "EOF";
})(TokenType || (TokenType = {}));
var KEYWORDS = {
  BEGIN: TokenType.BEGIN,
  END: TokenType.END,
  if: TokenType.IF,
  else: TokenType.ELSE,
  while: TokenType.WHILE,
  do: TokenType.DO,
  for: TokenType.FOR,
  in: TokenType.IN,
  break: TokenType.BREAK,
  continue: TokenType.CONTINUE,
  next: TokenType.NEXT,
  nextfile: TokenType.NEXTFILE,
  exit: TokenType.EXIT,
  return: TokenType.RETURN,
  delete: TokenType.DELETE,
  function: TokenType.FUNCTION,
  print: TokenType.PRINT,
  printf: TokenType.PRINTF,
  getline: TokenType.GETLINE
};
function expandPosixClasses(pattern) {
  return pattern.replace(/\[\[:space:\]\]/g, "[ \\t\\n\\r\\f\\v]").replace(/\[\[:blank:\]\]/g, "[ \\t]").replace(/\[\[:alpha:\]\]/g, "[a-zA-Z]").replace(/\[\[:digit:\]\]/g, "[0-9]").replace(/\[\[:alnum:\]\]/g, "[a-zA-Z0-9]").replace(/\[\[:upper:\]\]/g, "[A-Z]").replace(/\[\[:lower:\]\]/g, "[a-z]").replace(/\[\[:punct:\]\]/g, "[!\"#$%&'()*+,\\-./:;<=>?@\\[\\]\\\\^_`{|}~]").replace(/\[\[:xdigit:\]\]/g, "[0-9A-Fa-f]").replace(/\[\[:graph:\]\]/g, "[!-~]").replace(/\[\[:print:\]\]/g, "[ -~]").replace(/\[\[:cntrl:\]\]/g, "[\\x00-\\x1f\\x7f]");
}
__name(expandPosixClasses, "expandPosixClasses");
var AwkLexer = (_b = class {
  input;
  pos = 0;
  line = 1;
  column = 1;
  lastTokenType = null;
  constructor(input) {
    this.input = input;
  }
  tokenize() {
    const tokens = [];
    while (this.pos < this.input.length) {
      const token = this.nextToken();
      if (token) {
        tokens.push(token);
        this.lastTokenType = token.type;
      }
    }
    tokens.push(this.makeToken(TokenType.EOF, ""));
    return tokens;
  }
  makeToken(type, value) {
    return { type, value, line: this.line, column: this.column };
  }
  peek(offset = 0) {
    return this.input[this.pos + offset] || "";
  }
  advance() {
    const ch = this.input[this.pos++] || "";
    if (ch === "\n") {
      this.line++;
      this.column = 1;
    } else {
      this.column++;
    }
    return ch;
  }
  skipWhitespace() {
    while (this.pos < this.input.length) {
      const ch = this.peek();
      if (ch === " " || ch === "	" || ch === "\r") {
        this.advance();
      } else if (ch === "\\") {
        if (this.peek(1) === "\n") {
          this.advance();
          this.advance();
        } else {
          break;
        }
      } else if (ch === "#") {
        while (this.pos < this.input.length && this.peek() !== "\n") {
          this.advance();
        }
      } else {
        break;
      }
    }
  }
  nextToken() {
    this.skipWhitespace();
    if (this.pos >= this.input.length) {
      return null;
    }
    const startLine = this.line;
    const startColumn = this.column;
    const ch = this.peek();
    if (ch === "\n") {
      this.advance();
      return {
        type: TokenType.NEWLINE,
        value: "\n",
        line: startLine,
        column: startColumn
      };
    }
    if (ch === '"') {
      return this.readString();
    }
    if (ch === "/" && this.canBeRegex()) {
      return this.readRegex();
    }
    if (this.isDigit(ch) || ch === "." && this.isDigit(this.peek(1))) {
      return this.readNumber();
    }
    if (this.isAlpha(ch) || ch === "_") {
      return this.readIdentifier();
    }
    return this.readOperator();
  }
  canBeRegex() {
    const regexPreceders = /* @__PURE__ */ new Set([
      null,
      TokenType.NEWLINE,
      TokenType.SEMICOLON,
      TokenType.LBRACE,
      TokenType.RBRACE,
      // After closing action block, a new rule may start with regex
      TokenType.LPAREN,
      TokenType.LBRACKET,
      TokenType.COMMA,
      TokenType.ASSIGN,
      TokenType.PLUS_ASSIGN,
      TokenType.MINUS_ASSIGN,
      TokenType.STAR_ASSIGN,
      TokenType.SLASH_ASSIGN,
      TokenType.PERCENT_ASSIGN,
      TokenType.CARET_ASSIGN,
      TokenType.AND,
      TokenType.OR,
      TokenType.NOT,
      TokenType.MATCH,
      TokenType.NOT_MATCH,
      TokenType.QUESTION,
      TokenType.COLON,
      TokenType.LT,
      TokenType.GT,
      TokenType.LE,
      TokenType.GE,
      TokenType.EQ,
      TokenType.NE,
      TokenType.PLUS,
      TokenType.MINUS,
      TokenType.STAR,
      TokenType.PERCENT,
      TokenType.CARET,
      TokenType.PRINT,
      TokenType.PRINTF,
      TokenType.IF,
      TokenType.WHILE,
      TokenType.DO,
      TokenType.FOR,
      TokenType.RETURN
    ]);
    return regexPreceders.has(this.lastTokenType);
  }
  readString() {
    const startLine = this.line;
    const startColumn = this.column;
    this.advance();
    let value = "";
    while (this.pos < this.input.length && this.peek() !== '"') {
      if (this.peek() === "\\") {
        this.advance();
        const escaped = this.advance();
        switch (escaped) {
          case "n":
            value += "\n";
            break;
          case "t":
            value += "	";
            break;
          case "r":
            value += "\r";
            break;
          case "f":
            value += "\f";
            break;
          case "b":
            value += "\b";
            break;
          case "v":
            value += "\v";
            break;
          case "a":
            value += "\x07";
            break;
          case "\\":
            value += "\\";
            break;
          case '"':
            value += '"';
            break;
          case "/":
            value += "/";
            break;
          case "x": {
            let hex = "";
            while (hex.length < 2 && /[0-9a-fA-F]/.test(this.peek())) {
              hex += this.advance();
            }
            if (hex.length > 0) {
              value += String.fromCharCode(parseInt(hex, 16));
            } else {
              value += "x";
            }
            break;
          }
          default:
            if (/[0-7]/.test(escaped)) {
              let octal = escaped;
              while (octal.length < 3 && /[0-7]/.test(this.peek())) {
                octal += this.advance();
              }
              value += String.fromCharCode(parseInt(octal, 8));
            } else {
              value += escaped;
            }
        }
      } else {
        value += this.advance();
      }
    }
    if (this.peek() === '"') {
      this.advance();
    }
    return {
      type: TokenType.STRING,
      value,
      line: startLine,
      column: startColumn
    };
  }
  readRegex() {
    const startLine = this.line;
    const startColumn = this.column;
    this.advance();
    let pattern = "";
    while (this.pos < this.input.length && this.peek() !== "/") {
      if (this.peek() === "\\") {
        pattern += this.advance();
        if (this.pos < this.input.length) {
          pattern += this.advance();
        }
      } else if (this.peek() === "\n") {
        break;
      } else {
        pattern += this.advance();
      }
    }
    if (this.peek() === "/") {
      this.advance();
    }
    pattern = expandPosixClasses(pattern);
    return {
      type: TokenType.REGEX,
      value: pattern,
      line: startLine,
      column: startColumn
    };
  }
  readNumber() {
    const startLine = this.line;
    const startColumn = this.column;
    let numStr = "";
    while (this.isDigit(this.peek())) {
      numStr += this.advance();
    }
    if (this.peek() === "." && this.isDigit(this.peek(1))) {
      numStr += this.advance();
      while (this.isDigit(this.peek())) {
        numStr += this.advance();
      }
    }
    if (this.peek() === "e" || this.peek() === "E") {
      numStr += this.advance();
      if (this.peek() === "+" || this.peek() === "-") {
        numStr += this.advance();
      }
      while (this.isDigit(this.peek())) {
        numStr += this.advance();
      }
    }
    return {
      type: TokenType.NUMBER,
      value: parseFloat(numStr),
      line: startLine,
      column: startColumn
    };
  }
  readIdentifier() {
    const startLine = this.line;
    const startColumn = this.column;
    let name = "";
    while (this.isAlphaNumeric(this.peek()) || this.peek() === "_") {
      name += this.advance();
    }
    const keywordType = KEYWORDS[name];
    if (keywordType) {
      return {
        type: keywordType,
        value: name,
        line: startLine,
        column: startColumn
      };
    }
    return {
      type: TokenType.IDENT,
      value: name,
      line: startLine,
      column: startColumn
    };
  }
  readOperator() {
    const startLine = this.line;
    const startColumn = this.column;
    const ch = this.advance();
    const next = this.peek();
    switch (ch) {
      case "+":
        if (next === "+") {
          this.advance();
          return {
            type: TokenType.INCREMENT,
            value: "++",
            line: startLine,
            column: startColumn
          };
        }
        if (next === "=") {
          this.advance();
          return {
            type: TokenType.PLUS_ASSIGN,
            value: "+=",
            line: startLine,
            column: startColumn
          };
        }
        return {
          type: TokenType.PLUS,
          value: "+",
          line: startLine,
          column: startColumn
        };
      case "-":
        if (next === "-") {
          this.advance();
          return {
            type: TokenType.DECREMENT,
            value: "--",
            line: startLine,
            column: startColumn
          };
        }
        if (next === "=") {
          this.advance();
          return {
            type: TokenType.MINUS_ASSIGN,
            value: "-=",
            line: startLine,
            column: startColumn
          };
        }
        return {
          type: TokenType.MINUS,
          value: "-",
          line: startLine,
          column: startColumn
        };
      case "*":
        if (next === "*") {
          this.advance();
          return {
            type: TokenType.CARET,
            value: "**",
            line: startLine,
            column: startColumn
          };
        }
        if (next === "=") {
          this.advance();
          return {
            type: TokenType.STAR_ASSIGN,
            value: "*=",
            line: startLine,
            column: startColumn
          };
        }
        return {
          type: TokenType.STAR,
          value: "*",
          line: startLine,
          column: startColumn
        };
      case "/":
        if (next === "=") {
          this.advance();
          return {
            type: TokenType.SLASH_ASSIGN,
            value: "/=",
            line: startLine,
            column: startColumn
          };
        }
        return {
          type: TokenType.SLASH,
          value: "/",
          line: startLine,
          column: startColumn
        };
      case "%":
        if (next === "=") {
          this.advance();
          return {
            type: TokenType.PERCENT_ASSIGN,
            value: "%=",
            line: startLine,
            column: startColumn
          };
        }
        return {
          type: TokenType.PERCENT,
          value: "%",
          line: startLine,
          column: startColumn
        };
      case "^":
        if (next === "=") {
          this.advance();
          return {
            type: TokenType.CARET_ASSIGN,
            value: "^=",
            line: startLine,
            column: startColumn
          };
        }
        return {
          type: TokenType.CARET,
          value: "^",
          line: startLine,
          column: startColumn
        };
      case "=":
        if (next === "=") {
          this.advance();
          return {
            type: TokenType.EQ,
            value: "==",
            line: startLine,
            column: startColumn
          };
        }
        return {
          type: TokenType.ASSIGN,
          value: "=",
          line: startLine,
          column: startColumn
        };
      case "!":
        if (next === "=") {
          this.advance();
          return {
            type: TokenType.NE,
            value: "!=",
            line: startLine,
            column: startColumn
          };
        }
        if (next === "~") {
          this.advance();
          return {
            type: TokenType.NOT_MATCH,
            value: "!~",
            line: startLine,
            column: startColumn
          };
        }
        return {
          type: TokenType.NOT,
          value: "!",
          line: startLine,
          column: startColumn
        };
      case "<":
        if (next === "=") {
          this.advance();
          return {
            type: TokenType.LE,
            value: "<=",
            line: startLine,
            column: startColumn
          };
        }
        return {
          type: TokenType.LT,
          value: "<",
          line: startLine,
          column: startColumn
        };
      case ">":
        if (next === "=") {
          this.advance();
          return {
            type: TokenType.GE,
            value: ">=",
            line: startLine,
            column: startColumn
          };
        }
        if (next === ">") {
          this.advance();
          return {
            type: TokenType.APPEND,
            value: ">>",
            line: startLine,
            column: startColumn
          };
        }
        return {
          type: TokenType.GT,
          value: ">",
          line: startLine,
          column: startColumn
        };
      case "&":
        if (next === "&") {
          this.advance();
          return {
            type: TokenType.AND,
            value: "&&",
            line: startLine,
            column: startColumn
          };
        }
        return {
          type: TokenType.IDENT,
          value: "&",
          line: startLine,
          column: startColumn
        };
      case "|":
        if (next === "|") {
          this.advance();
          return {
            type: TokenType.OR,
            value: "||",
            line: startLine,
            column: startColumn
          };
        }
        return {
          type: TokenType.PIPE,
          value: "|",
          line: startLine,
          column: startColumn
        };
      case "~":
        return {
          type: TokenType.MATCH,
          value: "~",
          line: startLine,
          column: startColumn
        };
      case "?":
        return {
          type: TokenType.QUESTION,
          value: "?",
          line: startLine,
          column: startColumn
        };
      case ":":
        return {
          type: TokenType.COLON,
          value: ":",
          line: startLine,
          column: startColumn
        };
      case ",":
        return {
          type: TokenType.COMMA,
          value: ",",
          line: startLine,
          column: startColumn
        };
      case ";":
        return {
          type: TokenType.SEMICOLON,
          value: ";",
          line: startLine,
          column: startColumn
        };
      case "(":
        return {
          type: TokenType.LPAREN,
          value: "(",
          line: startLine,
          column: startColumn
        };
      case ")":
        return {
          type: TokenType.RPAREN,
          value: ")",
          line: startLine,
          column: startColumn
        };
      case "{":
        return {
          type: TokenType.LBRACE,
          value: "{",
          line: startLine,
          column: startColumn
        };
      case "}":
        return {
          type: TokenType.RBRACE,
          value: "}",
          line: startLine,
          column: startColumn
        };
      case "[":
        return {
          type: TokenType.LBRACKET,
          value: "[",
          line: startLine,
          column: startColumn
        };
      case "]":
        return {
          type: TokenType.RBRACKET,
          value: "]",
          line: startLine,
          column: startColumn
        };
      case "$":
        return {
          type: TokenType.DOLLAR,
          value: "$",
          line: startLine,
          column: startColumn
        };
      default:
        return {
          type: TokenType.IDENT,
          value: ch,
          line: startLine,
          column: startColumn
        };
    }
  }
  isDigit(ch) {
    return ch >= "0" && ch <= "9";
  }
  isAlpha(ch) {
    return ch >= "a" && ch <= "z" || ch >= "A" && ch <= "Z";
  }
  isAlphaNumeric(ch) {
    return this.isDigit(ch) || this.isAlpha(ch);
  }
}, __name(_b, "AwkLexer"), _b);
var TokenTypes = {
  LPAREN: "LPAREN",
  RPAREN: "RPAREN",
  QUESTION: "QUESTION",
  NEWLINE: "NEWLINE",
  SEMICOLON: "SEMICOLON",
  RBRACE: "RBRACE",
  COMMA: "COMMA",
  PIPE: "PIPE",
  GT: "GT",
  APPEND: "APPEND",
  AND: "AND",
  OR: "OR",
  ASSIGN: "ASSIGN",
  PLUS_ASSIGN: "PLUS_ASSIGN",
  MINUS_ASSIGN: "MINUS_ASSIGN",
  STAR_ASSIGN: "STAR_ASSIGN",
  SLASH_ASSIGN: "SLASH_ASSIGN",
  PERCENT_ASSIGN: "PERCENT_ASSIGN",
  CARET_ASSIGN: "CARET_ASSIGN",
  RBRACKET: "RBRACKET",
  COLON: "COLON",
  IN: "IN",
  PRINT: "PRINT",
  PRINTF: "PRINTF",
  IDENT: "IDENT",
  LT: "LT",
  LE: "LE",
  GE: "GE",
  EQ: "EQ",
  NE: "NE",
  MATCH: "MATCH",
  NOT_MATCH: "NOT_MATCH",
  NUMBER: "NUMBER",
  STRING: "STRING",
  DOLLAR: "DOLLAR",
  NOT: "NOT",
  MINUS: "MINUS",
  PLUS: "PLUS",
  INCREMENT: "INCREMENT",
  DECREMENT: "DECREMENT"
};
function parsePrintStatement(p) {
  p.expect(TokenTypes.PRINT);
  const args = [];
  if (p.check(TokenTypes.NEWLINE) || p.check(TokenTypes.SEMICOLON) || p.check(TokenTypes.RBRACE) || p.check(TokenTypes.PIPE) || p.check(TokenTypes.GT) || p.check(TokenTypes.APPEND)) {
    args.push({ type: "field", index: { type: "number", value: 0 } });
  } else {
    args.push(parsePrintArg(p));
    while (p.check(TokenTypes.COMMA)) {
      p.advance();
      args.push(parsePrintArg(p));
    }
  }
  let output;
  if (p.check(TokenTypes.GT)) {
    p.advance();
    output = { redirect: ">", file: p.parsePrimary() };
  } else if (p.check(TokenTypes.APPEND)) {
    p.advance();
    output = { redirect: ">>", file: p.parsePrimary() };
  }
  return { type: "print", args, output };
}
__name(parsePrintStatement, "parsePrintStatement");
function parsePrintArg(p) {
  const hasTernary = lookAheadForTernary(p);
  if (hasTernary) {
    return parsePrintAssignment(p, true);
  }
  return parsePrintAssignment(p, false);
}
__name(parsePrintArg, "parsePrintArg");
function parsePrintAssignment(p, allowGt) {
  const expr = allowGt ? p.parseTernary() : parsePrintOr(p);
  if (p.match(TokenTypes.ASSIGN, TokenTypes.PLUS_ASSIGN, TokenTypes.MINUS_ASSIGN, TokenTypes.STAR_ASSIGN, TokenTypes.SLASH_ASSIGN, TokenTypes.PERCENT_ASSIGN, TokenTypes.CARET_ASSIGN)) {
    const opToken = p.advance();
    const value = parsePrintAssignment(p, allowGt);
    if (expr.type !== "variable" && expr.type !== "field" && expr.type !== "array_access") {
      throw new Error("Invalid assignment target");
    }
    const opMap = {
      "=": "=",
      "+=": "+=",
      "-=": "-=",
      "*=": "*=",
      "/=": "/=",
      "%=": "%=",
      "^=": "^="
    };
    return {
      type: "assignment",
      operator: opMap[opToken.value],
      target: expr,
      value
    };
  }
  return expr;
}
__name(parsePrintAssignment, "parsePrintAssignment");
function lookAheadForTernary(p) {
  let depth = 0;
  let i = p.pos;
  while (i < p.tokens.length) {
    const token = p.tokens[i];
    if (token.type === TokenTypes.LPAREN)
      depth++;
    if (token.type === TokenTypes.RPAREN)
      depth--;
    if (token.type === TokenTypes.QUESTION && depth === 0) {
      return true;
    }
    if (token.type === TokenTypes.NEWLINE || token.type === TokenTypes.SEMICOLON || token.type === TokenTypes.RBRACE || token.type === TokenTypes.COMMA || token.type === TokenTypes.PIPE) {
      return false;
    }
    i++;
  }
  return false;
}
__name(lookAheadForTernary, "lookAheadForTernary");
function parsePrintOr(p) {
  let left = parsePrintAnd(p);
  while (p.check(TokenTypes.OR)) {
    p.advance();
    const right = parsePrintAnd(p);
    left = { type: "binary", operator: "||", left, right };
  }
  return left;
}
__name(parsePrintOr, "parsePrintOr");
function parsePrintAnd(p) {
  let left = parsePrintIn(p);
  while (p.check(TokenTypes.AND)) {
    p.advance();
    const right = parsePrintIn(p);
    left = { type: "binary", operator: "&&", left, right };
  }
  return left;
}
__name(parsePrintAnd, "parsePrintAnd");
function parsePrintIn(p) {
  const left = parsePrintConcatenation(p);
  if (p.check(TokenTypes.IN)) {
    p.advance();
    const arrayName = String(p.expect(TokenTypes.IDENT).value);
    return { type: "in", key: left, array: arrayName };
  }
  return left;
}
__name(parsePrintIn, "parsePrintIn");
function parsePrintConcatenation(p) {
  let left = parsePrintMatch(p);
  while (canStartExpression(p) && !isPrintConcatTerminator(p)) {
    const right = parsePrintMatch(p);
    left = { type: "binary", operator: " ", left, right };
  }
  return left;
}
__name(parsePrintConcatenation, "parsePrintConcatenation");
function parsePrintMatch(p) {
  let left = parsePrintComparison(p);
  while (p.match(TokenTypes.MATCH, TokenTypes.NOT_MATCH)) {
    const op = p.advance().type === TokenTypes.MATCH ? "~" : "!~";
    const right = parsePrintComparison(p);
    left = { type: "binary", operator: op, left, right };
  }
  return left;
}
__name(parsePrintMatch, "parsePrintMatch");
function parsePrintComparison(p) {
  let left = p.parseAddSub();
  while (p.match(TokenTypes.LT, TokenTypes.LE, TokenTypes.GE, TokenTypes.EQ, TokenTypes.NE)) {
    const opToken = p.advance();
    const right = p.parseAddSub();
    const opMap = {
      "<": "<",
      "<=": "<=",
      ">=": ">=",
      "==": "==",
      "!=": "!="
    };
    left = {
      type: "binary",
      operator: opMap[opToken.value],
      left,
      right
    };
  }
  return left;
}
__name(parsePrintComparison, "parsePrintComparison");
function canStartExpression(p) {
  return p.match(TokenTypes.NUMBER, TokenTypes.STRING, TokenTypes.IDENT, TokenTypes.DOLLAR, TokenTypes.LPAREN, TokenTypes.NOT, TokenTypes.MINUS, TokenTypes.PLUS, TokenTypes.INCREMENT, TokenTypes.DECREMENT);
}
__name(canStartExpression, "canStartExpression");
function isPrintConcatTerminator(p) {
  return p.match(
    // Logical operators
    TokenTypes.AND,
    TokenTypes.OR,
    TokenTypes.QUESTION,
    // Assignment operators
    TokenTypes.ASSIGN,
    TokenTypes.PLUS_ASSIGN,
    TokenTypes.MINUS_ASSIGN,
    TokenTypes.STAR_ASSIGN,
    TokenTypes.SLASH_ASSIGN,
    TokenTypes.PERCENT_ASSIGN,
    TokenTypes.CARET_ASSIGN,
    // Expression terminators
    TokenTypes.COMMA,
    TokenTypes.SEMICOLON,
    TokenTypes.NEWLINE,
    TokenTypes.RBRACE,
    TokenTypes.RPAREN,
    TokenTypes.RBRACKET,
    TokenTypes.COLON,
    // Redirection (print-specific)
    TokenTypes.PIPE,
    TokenTypes.APPEND,
    TokenTypes.GT,
    // > is redirection in print context
    // Array membership
    TokenTypes.IN
  );
}
__name(isPrintConcatTerminator, "isPrintConcatTerminator");
function parsePrintfStatement(p) {
  p.expect(TokenTypes.PRINTF);
  const hasParens = p.check(TokenTypes.LPAREN);
  if (hasParens) {
    p.advance();
    p.skipNewlines();
  }
  const format = hasParens ? p.parseExpression() : parsePrintArg(p);
  const args = [];
  while (p.check(TokenTypes.COMMA)) {
    p.advance();
    if (hasParens) {
      p.skipNewlines();
    }
    args.push(hasParens ? p.parseExpression() : parsePrintArg(p));
  }
  if (hasParens) {
    p.skipNewlines();
    p.expect(TokenTypes.RPAREN);
  }
  let output;
  if (p.check(TokenTypes.GT)) {
    p.advance();
    output = { redirect: ">", file: p.parsePrimary() };
  } else if (p.check(TokenTypes.APPEND)) {
    p.advance();
    output = { redirect: ">>", file: p.parsePrimary() };
  }
  return { type: "printf", format, args, output };
}
__name(parsePrintfStatement, "parsePrintfStatement");
var AwkParser = (_c = class {
  tokens = [];
  pos = 0;
  parse(input) {
    const lexer = new AwkLexer(input);
    this.tokens = lexer.tokenize();
    this.pos = 0;
    return this.parseProgram();
  }
  // ─── Helper methods ────────────────────────────────────────
  setPos(newPos) {
    this.pos = newPos;
  }
  current() {
    return this.tokens[this.pos] || {
      type: TokenType.EOF,
      value: "",
      line: 0,
      column: 0
    };
  }
  advance() {
    const token = this.current();
    if (this.pos < this.tokens.length) {
      this.pos++;
    }
    return token;
  }
  match(...types) {
    return types.includes(this.current().type);
  }
  check(type) {
    return this.current().type === type;
  }
  expect(type, message) {
    if (!this.check(type)) {
      const tok = this.current();
      throw new Error(message || `Expected ${type}, got ${tok.type} at line ${tok.line}:${tok.column}`);
    }
    return this.advance();
  }
  skipNewlines() {
    while (this.check(TokenType.NEWLINE)) {
      this.advance();
    }
  }
  skipTerminators() {
    while (this.check(TokenType.NEWLINE) || this.check(TokenType.SEMICOLON)) {
      this.advance();
    }
  }
  // ─── Program parsing ───────────────────────────────────────
  parseProgram() {
    const functions = [];
    const rules = [];
    this.skipNewlines();
    while (!this.check(TokenType.EOF)) {
      this.skipNewlines();
      if (this.check(TokenType.EOF))
        break;
      if (this.check(TokenType.FUNCTION)) {
        functions.push(this.parseFunction());
      } else {
        rules.push(this.parseRule());
      }
      this.skipTerminators();
    }
    return { functions, rules };
  }
  parseFunction() {
    this.expect(TokenType.FUNCTION);
    const name = this.expect(TokenType.IDENT).value;
    this.expect(TokenType.LPAREN);
    const params = [];
    if (!this.check(TokenType.RPAREN)) {
      params.push(this.expect(TokenType.IDENT).value);
      while (this.check(TokenType.COMMA)) {
        this.advance();
        params.push(this.expect(TokenType.IDENT).value);
      }
    }
    this.expect(TokenType.RPAREN);
    this.skipNewlines();
    const body = this.parseBlock();
    return { name, params, body };
  }
  parseRule() {
    let pattern;
    if (this.check(TokenType.BEGIN)) {
      this.advance();
      pattern = { type: "begin" };
    } else if (this.check(TokenType.END)) {
      this.advance();
      pattern = { type: "end" };
    } else if (this.check(TokenType.LBRACE)) {
      pattern = void 0;
    } else if (this.check(TokenType.REGEX)) {
      const regexToken = this.advance();
      if (this.check(TokenType.AND) || this.check(TokenType.OR)) {
        const regexExpr = {
          type: "binary",
          operator: "~",
          left: { type: "field", index: { type: "number", value: 0 } },
          right: { type: "regex", pattern: regexToken.value }
        };
        const fullExpr = this.parseLogicalOrRest(regexExpr);
        pattern = { type: "expr_pattern", expression: fullExpr };
      } else {
        const pat = {
          type: "regex_pattern",
          pattern: regexToken.value
        };
        if (this.check(TokenType.COMMA)) {
          this.advance();
          let endPattern;
          if (this.check(TokenType.REGEX)) {
            const endRegex = this.advance();
            endPattern = {
              type: "regex_pattern",
              pattern: endRegex.value
            };
          } else {
            endPattern = {
              type: "expr_pattern",
              expression: this.parseExpression()
            };
          }
          pattern = { type: "range", start: pat, end: endPattern };
        } else {
          pattern = pat;
        }
      }
    } else {
      const expr = this.parseExpression();
      const pat = { type: "expr_pattern", expression: expr };
      if (this.check(TokenType.COMMA)) {
        this.advance();
        let endPattern;
        if (this.check(TokenType.REGEX)) {
          const endRegex = this.advance();
          endPattern = {
            type: "regex_pattern",
            pattern: endRegex.value
          };
        } else {
          endPattern = {
            type: "expr_pattern",
            expression: this.parseExpression()
          };
        }
        pattern = { type: "range", start: pat, end: endPattern };
      } else {
        pattern = pat;
      }
    }
    this.skipNewlines();
    let action;
    if (this.check(TokenType.LBRACE)) {
      action = this.parseBlock();
    } else {
      action = {
        type: "block",
        statements: [
          {
            type: "print",
            args: [{ type: "field", index: { type: "number", value: 0 } }]
          }
        ]
      };
    }
    return { pattern, action };
  }
  parseBlock() {
    this.expect(TokenType.LBRACE);
    this.skipNewlines();
    const statements = [];
    while (!this.check(TokenType.RBRACE) && !this.check(TokenType.EOF)) {
      statements.push(this.parseStatement());
      this.skipTerminators();
    }
    this.expect(TokenType.RBRACE);
    return { type: "block", statements };
  }
  // ─── Statement parsing ─────────────────────────────────────
  parseStatement() {
    if (this.check(TokenType.SEMICOLON) || this.check(TokenType.NEWLINE)) {
      this.advance();
      return { type: "block", statements: [] };
    }
    if (this.check(TokenType.LBRACE)) {
      return this.parseBlock();
    }
    if (this.check(TokenType.IF)) {
      return this.parseIf();
    }
    if (this.check(TokenType.WHILE)) {
      return this.parseWhile();
    }
    if (this.check(TokenType.DO)) {
      return this.parseDoWhile();
    }
    if (this.check(TokenType.FOR)) {
      return this.parseFor();
    }
    if (this.check(TokenType.BREAK)) {
      this.advance();
      return { type: "break" };
    }
    if (this.check(TokenType.CONTINUE)) {
      this.advance();
      return { type: "continue" };
    }
    if (this.check(TokenType.NEXT)) {
      this.advance();
      return { type: "next" };
    }
    if (this.check(TokenType.NEXTFILE)) {
      this.advance();
      return { type: "nextfile" };
    }
    if (this.check(TokenType.EXIT)) {
      this.advance();
      let code;
      if (!this.check(TokenType.NEWLINE) && !this.check(TokenType.SEMICOLON) && !this.check(TokenType.RBRACE) && !this.check(TokenType.EOF)) {
        code = this.parseExpression();
      }
      return { type: "exit", code };
    }
    if (this.check(TokenType.RETURN)) {
      this.advance();
      let value;
      if (!this.check(TokenType.NEWLINE) && !this.check(TokenType.SEMICOLON) && !this.check(TokenType.RBRACE) && !this.check(TokenType.EOF)) {
        value = this.parseExpression();
      }
      return { type: "return", value };
    }
    if (this.check(TokenType.DELETE)) {
      this.advance();
      const target = this.parsePrimary();
      if (target.type !== "array_access" && target.type !== "variable") {
        throw new Error("delete requires array element or array");
      }
      return { type: "delete", target };
    }
    if (this.check(TokenType.PRINT)) {
      return parsePrintStatement(this);
    }
    if (this.check(TokenType.PRINTF)) {
      return parsePrintfStatement(this);
    }
    const expr = this.parseExpression();
    return { type: "expr_stmt", expression: expr };
  }
  parseIf() {
    this.expect(TokenType.IF);
    this.expect(TokenType.LPAREN);
    const condition = this.parseExpression();
    this.expect(TokenType.RPAREN);
    this.skipNewlines();
    const consequent = this.parseStatement();
    this.skipTerminators();
    let alternate;
    if (this.check(TokenType.ELSE)) {
      this.advance();
      this.skipNewlines();
      alternate = this.parseStatement();
    }
    return { type: "if", condition, consequent, alternate };
  }
  parseWhile() {
    this.expect(TokenType.WHILE);
    this.expect(TokenType.LPAREN);
    const condition = this.parseExpression();
    this.expect(TokenType.RPAREN);
    this.skipNewlines();
    const body = this.parseStatement();
    return { type: "while", condition, body };
  }
  parseDoWhile() {
    this.expect(TokenType.DO);
    this.skipNewlines();
    const body = this.parseStatement();
    this.skipNewlines();
    this.expect(TokenType.WHILE);
    this.expect(TokenType.LPAREN);
    const condition = this.parseExpression();
    this.expect(TokenType.RPAREN);
    return { type: "do_while", body, condition };
  }
  parseFor() {
    this.expect(TokenType.FOR);
    this.expect(TokenType.LPAREN);
    if (this.check(TokenType.IDENT)) {
      const varToken = this.advance();
      if (this.check(TokenType.IN)) {
        this.advance();
        const array = this.expect(TokenType.IDENT).value;
        this.expect(TokenType.RPAREN);
        this.skipNewlines();
        const body2 = this.parseStatement();
        return {
          type: "for_in",
          variable: varToken.value,
          array,
          body: body2
        };
      }
      this.pos--;
    }
    let init;
    if (!this.check(TokenType.SEMICOLON)) {
      init = this.parseExpression();
    }
    this.expect(TokenType.SEMICOLON);
    let condition;
    if (!this.check(TokenType.SEMICOLON)) {
      condition = this.parseExpression();
    }
    this.expect(TokenType.SEMICOLON);
    let update;
    if (!this.check(TokenType.RPAREN)) {
      update = this.parseExpression();
    }
    this.expect(TokenType.RPAREN);
    this.skipNewlines();
    const body = this.parseStatement();
    return { type: "for", init, condition, update, body };
  }
  // ─── Expression parsing (precedence climbing) ──────────────
  parseExpression() {
    return this.parseAssignment();
  }
  parseAssignment() {
    const expr = this.parseTernary();
    if (this.match(TokenType.ASSIGN, TokenType.PLUS_ASSIGN, TokenType.MINUS_ASSIGN, TokenType.STAR_ASSIGN, TokenType.SLASH_ASSIGN, TokenType.PERCENT_ASSIGN, TokenType.CARET_ASSIGN)) {
      const opToken = this.advance();
      const value = this.parseAssignment();
      if (expr.type !== "variable" && expr.type !== "field" && expr.type !== "array_access") {
        throw new Error("Invalid assignment target");
      }
      const opMap = {
        "=": "=",
        "+=": "+=",
        "-=": "-=",
        "*=": "*=",
        "/=": "/=",
        "%=": "%=",
        "^=": "^="
      };
      return {
        type: "assignment",
        operator: opMap[opToken.value],
        target: expr,
        value
      };
    }
    return expr;
  }
  parseTernary() {
    let expr = this.parsePipeGetline();
    if (this.check(TokenType.QUESTION)) {
      this.advance();
      const consequent = this.parseExpression();
      this.expect(TokenType.COLON);
      const alternate = this.parseExpression();
      expr = { type: "ternary", condition: expr, consequent, alternate };
    }
    return expr;
  }
  /**
   * Parse command pipe getline: "cmd" | getline [var]
   * This has lower precedence than logical OR but higher than ternary.
   */
  parsePipeGetline() {
    const left = this.parseOr();
    if (this.check(TokenType.PIPE)) {
      this.advance();
      if (!this.check(TokenType.GETLINE)) {
        throw new Error("Expected 'getline' after '|' in expression context");
      }
      this.advance();
      let variable;
      if (this.check(TokenType.IDENT)) {
        variable = this.advance().value;
      }
      return { type: "getline", command: left, variable };
    }
    return left;
  }
  parseOr() {
    let left = this.parseAnd();
    while (this.check(TokenType.OR)) {
      this.advance();
      const right = this.parseAnd();
      left = { type: "binary", operator: "||", left, right };
    }
    return left;
  }
  /**
   * Continue parsing a logical OR/AND expression from a given left-hand side.
   * Used when we've already parsed part of an expression (e.g., a regex in pattern context).
   */
  parseLogicalOrRest(left) {
    left = this.parseLogicalAndRest(left);
    while (this.check(TokenType.OR)) {
      this.advance();
      const right = this.parseAnd();
      left = { type: "binary", operator: "||", left, right };
    }
    return left;
  }
  /**
   * Continue parsing a logical AND expression from a given left-hand side.
   */
  parseLogicalAndRest(left) {
    while (this.check(TokenType.AND)) {
      this.advance();
      const right = this.parseIn();
      left = { type: "binary", operator: "&&", left, right };
    }
    return left;
  }
  parseAnd() {
    let left = this.parseIn();
    while (this.check(TokenType.AND)) {
      this.advance();
      const right = this.parseIn();
      left = { type: "binary", operator: "&&", left, right };
    }
    return left;
  }
  parseIn() {
    const left = this.parseConcatenation();
    if (this.check(TokenType.IN)) {
      this.advance();
      const array = this.expect(TokenType.IDENT).value;
      return { type: "in", key: left, array };
    }
    return left;
  }
  parseConcatenation() {
    let left = this.parseMatch();
    while (this.canStartExpression() && !this.isConcatTerminator()) {
      const right = this.parseMatch();
      left = { type: "binary", operator: " ", left, right };
    }
    return left;
  }
  parseMatch() {
    let left = this.parseComparison();
    while (this.match(TokenType.MATCH, TokenType.NOT_MATCH)) {
      const op = this.advance().type === TokenType.MATCH ? "~" : "!~";
      const right = this.parseComparison();
      left = { type: "binary", operator: op, left, right };
    }
    return left;
  }
  parseComparison() {
    let left = this.parseAddSub();
    while (this.match(TokenType.LT, TokenType.LE, TokenType.GT, TokenType.GE, TokenType.EQ, TokenType.NE)) {
      const opToken = this.advance();
      const right = this.parseAddSub();
      const opMap = {
        "<": "<",
        "<=": "<=",
        ">": ">",
        ">=": ">=",
        "==": "==",
        "!=": "!="
      };
      left = {
        type: "binary",
        operator: opMap[opToken.value],
        left,
        right
      };
    }
    return left;
  }
  canStartExpression() {
    return this.match(TokenType.NUMBER, TokenType.STRING, TokenType.IDENT, TokenType.DOLLAR, TokenType.LPAREN, TokenType.NOT, TokenType.MINUS, TokenType.PLUS, TokenType.INCREMENT, TokenType.DECREMENT);
  }
  /**
   * Check if the current token terminates a concatenation.
   * These are tokens that indicate we've reached a higher-level operator
   * or end of expression.
   */
  isConcatTerminator() {
    return this.match(
      // Logical operators (lower precedence than concatenation)
      TokenType.AND,
      TokenType.OR,
      TokenType.QUESTION,
      // Assignment operators
      TokenType.ASSIGN,
      TokenType.PLUS_ASSIGN,
      TokenType.MINUS_ASSIGN,
      TokenType.STAR_ASSIGN,
      TokenType.SLASH_ASSIGN,
      TokenType.PERCENT_ASSIGN,
      TokenType.CARET_ASSIGN,
      // Expression terminators
      TokenType.COMMA,
      TokenType.SEMICOLON,
      TokenType.NEWLINE,
      TokenType.RBRACE,
      TokenType.RPAREN,
      TokenType.RBRACKET,
      TokenType.COLON,
      // Redirection (in print context)
      TokenType.PIPE,
      TokenType.APPEND,
      // Array membership (lower precedence)
      TokenType.IN
    );
  }
  parseAddSub() {
    let left = this.parseMulDiv();
    while (this.match(TokenType.PLUS, TokenType.MINUS)) {
      const op = this.advance().value;
      const right = this.parseMulDiv();
      left = { type: "binary", operator: op, left, right };
    }
    return left;
  }
  parseMulDiv() {
    let left = this.parseUnary();
    while (this.match(TokenType.STAR, TokenType.SLASH, TokenType.PERCENT)) {
      const opToken = this.advance();
      const right = this.parseUnary();
      const opMap = {
        "*": "*",
        "/": "/",
        "%": "%"
      };
      left = {
        type: "binary",
        operator: opMap[opToken.value],
        left,
        right
      };
    }
    return left;
  }
  parseUnary() {
    if (this.check(TokenType.INCREMENT)) {
      this.advance();
      const operand = this.parseUnary();
      if (operand.type !== "variable" && operand.type !== "field" && operand.type !== "array_access") {
        return {
          type: "unary",
          operator: "+",
          operand: { type: "unary", operator: "+", operand }
        };
      }
      return {
        type: "pre_increment",
        operand
      };
    }
    if (this.check(TokenType.DECREMENT)) {
      this.advance();
      const operand = this.parseUnary();
      if (operand.type !== "variable" && operand.type !== "field" && operand.type !== "array_access") {
        return {
          type: "unary",
          operator: "-",
          operand: { type: "unary", operator: "-", operand }
        };
      }
      return {
        type: "pre_decrement",
        operand
      };
    }
    if (this.match(TokenType.NOT, TokenType.MINUS, TokenType.PLUS)) {
      const op = this.advance().value;
      const operand = this.parseUnary();
      return { type: "unary", operator: op, operand };
    }
    return this.parsePower();
  }
  parsePower() {
    let left = this.parsePostfix();
    if (this.check(TokenType.CARET)) {
      this.advance();
      const right = this.parsePower();
      left = { type: "binary", operator: "^", left, right };
    }
    return left;
  }
  parsePostfix() {
    const expr = this.parsePrimary();
    if (this.check(TokenType.INCREMENT)) {
      this.advance();
      if (expr.type !== "variable" && expr.type !== "field" && expr.type !== "array_access") {
        throw new Error("Invalid increment operand");
      }
      return {
        type: "post_increment",
        operand: expr
      };
    }
    if (this.check(TokenType.DECREMENT)) {
      this.advance();
      if (expr.type !== "variable" && expr.type !== "field" && expr.type !== "array_access") {
        throw new Error("Invalid decrement operand");
      }
      return {
        type: "post_decrement",
        operand: expr
      };
    }
    return expr;
  }
  /**
   * Parse a field index expression. This is like parseUnary but does NOT allow
   * postfix operators, so that $i++ parses as ($i)++ rather than $(i++).
   * Allows: $1, $i, $++i, $--i, $(expr), $-1
   * Does NOT consume postfix ++ or -- (those apply to the field, not the index)
   */
  parseFieldIndex() {
    if (this.check(TokenType.INCREMENT)) {
      this.advance();
      const operand = this.parseFieldIndex();
      if (operand.type !== "variable" && operand.type !== "field" && operand.type !== "array_access") {
        return {
          type: "unary",
          operator: "+",
          operand: { type: "unary", operator: "+", operand }
        };
      }
      return {
        type: "pre_increment",
        operand
      };
    }
    if (this.check(TokenType.DECREMENT)) {
      this.advance();
      const operand = this.parseFieldIndex();
      if (operand.type !== "variable" && operand.type !== "field" && operand.type !== "array_access") {
        return {
          type: "unary",
          operator: "-",
          operand: { type: "unary", operator: "-", operand }
        };
      }
      return {
        type: "pre_decrement",
        operand
      };
    }
    if (this.match(TokenType.NOT, TokenType.MINUS, TokenType.PLUS)) {
      const op = this.advance().value;
      const operand = this.parseFieldIndex();
      return { type: "unary", operator: op, operand };
    }
    return this.parseFieldIndexPower();
  }
  /**
   * Parse power expression for field index (no postfix on base)
   */
  parseFieldIndexPower() {
    let left = this.parseFieldIndexPrimary();
    if (this.check(TokenType.CARET)) {
      this.advance();
      const right = this.parseFieldIndexPower();
      left = { type: "binary", operator: "^", left, right };
    }
    return left;
  }
  /**
   * Parse primary expression for field index - like parsePrimary but returns
   * without checking for postfix operators
   */
  parseFieldIndexPrimary() {
    if (this.check(TokenType.NUMBER)) {
      const value = this.advance().value;
      return { type: "number", value };
    }
    if (this.check(TokenType.STRING)) {
      const value = this.advance().value;
      return { type: "string", value };
    }
    if (this.check(TokenType.DOLLAR)) {
      this.advance();
      const index = this.parseFieldIndex();
      return { type: "field", index };
    }
    if (this.check(TokenType.LPAREN)) {
      this.advance();
      const expr = this.parseExpression();
      this.expect(TokenType.RPAREN);
      return expr;
    }
    if (this.check(TokenType.IDENT)) {
      const name = this.advance().value;
      if (this.check(TokenType.LPAREN)) {
        this.advance();
        const args = [];
        if (!this.check(TokenType.RPAREN)) {
          args.push(this.parseExpression());
          while (this.check(TokenType.COMMA)) {
            this.advance();
            args.push(this.parseExpression());
          }
        }
        this.expect(TokenType.RPAREN);
        return { type: "call", name, args };
      }
      if (this.check(TokenType.LBRACKET)) {
        this.advance();
        const key = this.parseExpression();
        if (this.check(TokenType.COMMA)) {
          const keys = [key];
          while (this.check(TokenType.COMMA)) {
            this.advance();
            keys.push(this.parseExpression());
          }
          this.expect(TokenType.RBRACKET);
          const combinedKey = keys.reduce((acc, k) => ({
            type: "binary",
            operator: " ",
            left: {
              type: "binary",
              operator: " ",
              left: acc,
              right: { type: "variable", name: "SUBSEP" }
            },
            right: k
          }));
          return { type: "array_access", array: name, key: combinedKey };
        }
        this.expect(TokenType.RBRACKET);
        return { type: "array_access", array: name, key };
      }
      return { type: "variable", name };
    }
    throw new Error(`Unexpected token in field index: ${this.current().type} at line ${this.current().line}:${this.current().column}`);
  }
  parsePrimary() {
    if (this.check(TokenType.NUMBER)) {
      const value = this.advance().value;
      return { type: "number", value };
    }
    if (this.check(TokenType.STRING)) {
      const value = this.advance().value;
      return { type: "string", value };
    }
    if (this.check(TokenType.REGEX)) {
      const pattern = this.advance().value;
      return { type: "regex", pattern };
    }
    if (this.check(TokenType.DOLLAR)) {
      this.advance();
      const index = this.parseFieldIndex();
      return { type: "field", index };
    }
    if (this.check(TokenType.LPAREN)) {
      this.advance();
      const first = this.parseExpression();
      if (this.check(TokenType.COMMA)) {
        const elements = [first];
        while (this.check(TokenType.COMMA)) {
          this.advance();
          elements.push(this.parseExpression());
        }
        this.expect(TokenType.RPAREN);
        return { type: "tuple", elements };
      }
      this.expect(TokenType.RPAREN);
      return first;
    }
    if (this.check(TokenType.GETLINE)) {
      this.advance();
      let variable;
      let file;
      if (this.check(TokenType.IDENT)) {
        variable = this.advance().value;
      }
      if (this.check(TokenType.LT)) {
        this.advance();
        file = this.parsePrimary();
      }
      return { type: "getline", variable, file };
    }
    if (this.check(TokenType.IDENT)) {
      const name = this.advance().value;
      if (this.check(TokenType.LPAREN)) {
        this.advance();
        const args = [];
        this.skipNewlines();
        if (!this.check(TokenType.RPAREN)) {
          args.push(this.parseExpression());
          while (this.check(TokenType.COMMA)) {
            this.advance();
            this.skipNewlines();
            args.push(this.parseExpression());
          }
        }
        this.skipNewlines();
        this.expect(TokenType.RPAREN);
        return { type: "call", name, args };
      }
      if (this.check(TokenType.LBRACKET)) {
        this.advance();
        const keys = [this.parseExpression()];
        while (this.check(TokenType.COMMA)) {
          this.advance();
          keys.push(this.parseExpression());
        }
        this.expect(TokenType.RBRACKET);
        let key;
        if (keys.length === 1) {
          key = keys[0];
        } else {
          key = keys[0];
          for (let i = 1; i < keys.length; i++) {
            key = {
              type: "binary",
              operator: " ",
              left: {
                type: "binary",
                operator: " ",
                left: key,
                right: { type: "variable", name: "SUBSEP" }
              },
              right: keys[i]
            };
          }
        }
        return { type: "array_access", array: name, key };
      }
      return { type: "variable", name };
    }
    throw new Error(`Unexpected token: ${this.current().type} at line ${this.current().line}:${this.current().column}`);
  }
}, __name(_c, "AwkParser"), _c);
var awkHelp = {
  name: "awk",
  summary: "pattern scanning and text processing language",
  usage: "awk [OPTIONS] 'PROGRAM' [FILE...]",
  options: [
    "-F FS      use FS as field separator",
    "-v VAR=VAL assign VAL to variable VAR",
    "    --help display this help and exit"
  ]
};
var awkCommand2 = {
  name: "awk",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(awkHelp);
    }
    let fieldSep = /\s+/;
    let fieldSepStr = " ";
    const vars = {};
    let programIdx = 0;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "-F" && i + 1 < args.length) {
        fieldSepStr = processEscapes(args[++i]);
        fieldSep = createFieldSepRegex(fieldSepStr);
        programIdx = i + 1;
      } else if (arg.startsWith("-F")) {
        fieldSepStr = processEscapes(arg.slice(2));
        fieldSep = createFieldSepRegex(fieldSepStr);
        programIdx = i + 1;
      } else if (arg === "-v" && i + 1 < args.length) {
        const assignment = args[++i];
        const eqIdx = assignment.indexOf("=");
        if (eqIdx > 0) {
          const varName = assignment.slice(0, eqIdx);
          const varValue = processEscapes(assignment.slice(eqIdx + 1));
          vars[varName] = varValue;
        }
        programIdx = i + 1;
      } else if (arg.startsWith("--")) {
        return unknownOption("awk", arg);
      } else if (arg.startsWith("-") && arg.length > 1) {
        const optChar = arg[1];
        if (optChar !== "F" && optChar !== "v") {
          return unknownOption("awk", `-${optChar}`);
        }
        programIdx = i + 1;
      } else if (!arg.startsWith("-")) {
        programIdx = i;
        break;
      }
    }
    if (programIdx >= args.length) {
      return { stdout: "", stderr: "awk: missing program\n", exitCode: 1 };
    }
    const program = args[programIdx];
    const files = args.slice(programIdx + 1);
    const parser = new AwkParser();
    let ast;
    try {
      ast = parser.parse(program);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { stdout: "", stderr: `awk: ${msg}
`, exitCode: 1 };
    }
    const awkFs = {
      readFile: ctx.fs.readFile.bind(ctx.fs),
      writeFile: ctx.fs.writeFile.bind(ctx.fs),
      appendFile: /* @__PURE__ */ __name(async (path, content) => {
        try {
          const existing = await ctx.fs.readFile(path);
          await ctx.fs.writeFile(path, existing + content);
        } catch {
          await ctx.fs.writeFile(path, content);
        }
      }, "appendFile"),
      resolvePath: ctx.fs.resolvePath.bind(ctx.fs)
    };
    const runtimeCtx = createRuntimeContext({
      fieldSep,
      maxIterations: ctx.limits?.maxAwkIterations,
      fs: awkFs,
      cwd: ctx.cwd,
      // Wrap ctx.exec to match the expected signature for command pipe getline
      exec: ctx.exec ? (
        // biome-ignore lint/style/noNonNullAssertion: exec checked in ternary
        ((cmd) => ctx.exec(cmd, { cwd: ctx.cwd }))
      ) : void 0
    });
    runtimeCtx.FS = fieldSepStr;
    runtimeCtx.vars = { ...vars };
    runtimeCtx.ARGC = files.length + 1;
    runtimeCtx.ARGV = { "0": "awk" };
    for (let i = 0; i < files.length; i++) {
      runtimeCtx.ARGV[String(i + 1)] = files[i];
    }
    runtimeCtx.ENVIRON = { ...ctx.env };
    const interp = new AwkInterpreter(runtimeCtx);
    interp.execute(ast);
    const hasMainRules = ast.rules.some((rule) => rule.pattern?.type !== "begin" && rule.pattern?.type !== "end");
    const hasEndBlocks = ast.rules.some((rule) => rule.pattern?.type === "end");
    try {
      await interp.executeBegin();
      if (runtimeCtx.shouldExit) {
        await interp.executeEnd();
        return {
          stdout: interp.getOutput(),
          stderr: "",
          exitCode: interp.getExitCode()
        };
      }
      if (!hasMainRules && !hasEndBlocks) {
        return {
          stdout: interp.getOutput(),
          stderr: "",
          exitCode: interp.getExitCode()
        };
      }
      const fileDataList = [];
      if (files.length > 0) {
        for (const file of files) {
          try {
            const filePath = ctx.fs.resolvePath(ctx.cwd, file);
            const content = await ctx.fs.readFile(filePath);
            const lines = content.split("\n");
            if (lines.length > 0 && lines[lines.length - 1] === "") {
              lines.pop();
            }
            fileDataList.push({ filename: file, lines });
          } catch {
            return {
              stdout: "",
              stderr: `awk: ${file}: No such file or directory
`,
              exitCode: 1
            };
          }
        }
      } else {
        const lines = ctx.stdin.split("\n");
        if (lines.length > 0 && lines[lines.length - 1] === "") {
          lines.pop();
        }
        fileDataList.push({ filename: "", lines });
      }
      for (const fileData of fileDataList) {
        runtimeCtx.FILENAME = fileData.filename;
        runtimeCtx.FNR = 0;
        runtimeCtx.lines = fileData.lines;
        runtimeCtx.lineIndex = -1;
        runtimeCtx.shouldNextFile = false;
        while (runtimeCtx.lineIndex < fileData.lines.length - 1) {
          runtimeCtx.lineIndex++;
          await interp.executeLine(fileData.lines[runtimeCtx.lineIndex]);
          if (runtimeCtx.shouldExit || runtimeCtx.shouldNextFile)
            break;
        }
        if (runtimeCtx.shouldExit)
          break;
      }
      await interp.executeEnd();
      return {
        stdout: interp.getOutput(),
        stderr: "",
        exitCode: interp.getExitCode()
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const exitCode = e instanceof ExecutionLimitError ? ExecutionLimitError.EXIT_CODE : 2;
      return {
        stdout: interp.getOutput(),
        stderr: `awk: ${msg}
`,
        exitCode
      };
    }
  }
};
function processEscapes(str) {
  return str.replace(/\\t/g, "	").replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\b/g, "\b").replace(/\\f/g, "\f").replace(/\\a/g, "\x07").replace(/\\v/g, "\v").replace(/\\\\/g, "\\");
}
__name(processEscapes, "processEscapes");
function createFieldSepRegex(sep) {
  if (sep === " ") {
    return /\s+/;
  }
  const regexMetachars = /[[\](){}.*+?^$|\\]/;
  if (regexMetachars.test(sep)) {
    try {
      return new RegExp(sep);
    } catch {
      return new RegExp(escapeForRegex(sep));
    }
  }
  return new RegExp(escapeForRegex(sep));
}
__name(createFieldSepRegex, "createFieldSepRegex");
function escapeForRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
__name(escapeForRegex, "escapeForRegex");
export {
  awkCommand2
};
