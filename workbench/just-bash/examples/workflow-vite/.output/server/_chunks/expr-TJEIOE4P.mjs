import { _ as __name } from "../index.mjs";
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
var exprCommand = {
  name: "expr",
  async execute(args, _ctx) {
    if (args.length === 0) {
      return {
        stdout: "",
        stderr: "expr: missing operand\n",
        exitCode: 2
      };
    }
    try {
      const result = evaluateExpr(args);
      const exitCode = result === "0" || result === "" ? 1 : 0;
      return {
        stdout: `${result}
`,
        stderr: "",
        exitCode
      };
    } catch (error) {
      return {
        stdout: "",
        stderr: `expr: ${error.message}
`,
        exitCode: 2
      };
    }
  }
};
function evaluateExpr(args) {
  if (args.length === 1) {
    return args[0];
  }
  let i = 0;
  function parseOr() {
    let left = parseAnd();
    while (i < args.length && args[i] === "|") {
      i++;
      const right = parseAnd();
      if (left !== "0" && left !== "") {
        return left;
      }
      left = right;
    }
    return left;
  }
  __name(parseOr, "parseOr");
  function parseAnd() {
    let left = parseComparison();
    while (i < args.length && args[i] === "&") {
      i++;
      const right = parseComparison();
      if (left === "0" || left === "" || right === "0" || right === "") {
        left = "0";
      }
    }
    return left;
  }
  __name(parseAnd, "parseAnd");
  function parseComparison() {
    let left = parseAddSub();
    while (i < args.length) {
      const op = args[i];
      if (["=", "!=", "<", ">", "<=", ">="].includes(op)) {
        i++;
        const right = parseAddSub();
        const leftNum = parseInt(left, 10);
        const rightNum = parseInt(right, 10);
        const isNumeric = !Number.isNaN(leftNum) && !Number.isNaN(rightNum);
        let result;
        if (op === "=") {
          result = isNumeric ? leftNum === rightNum : left === right;
        } else if (op === "!=") {
          result = isNumeric ? leftNum !== rightNum : left !== right;
        } else if (op === "<") {
          result = isNumeric ? leftNum < rightNum : left < right;
        } else if (op === ">") {
          result = isNumeric ? leftNum > rightNum : left > right;
        } else if (op === "<=") {
          result = isNumeric ? leftNum <= rightNum : left <= right;
        } else {
          result = isNumeric ? leftNum >= rightNum : left >= right;
        }
        left = result ? "1" : "0";
      } else {
        break;
      }
    }
    return left;
  }
  __name(parseComparison, "parseComparison");
  function parseAddSub() {
    let left = parseMulDiv();
    while (i < args.length) {
      const op = args[i];
      if (op === "+" || op === "-") {
        i++;
        const right = parseMulDiv();
        const leftNum = parseInt(left, 10);
        const rightNum = parseInt(right, 10);
        if (Number.isNaN(leftNum) || Number.isNaN(rightNum)) {
          throw new Error("non-integer argument");
        }
        left = String(op === "+" ? leftNum + rightNum : leftNum - rightNum);
      } else {
        break;
      }
    }
    return left;
  }
  __name(parseAddSub, "parseAddSub");
  function parseMulDiv() {
    let left = parseMatch();
    while (i < args.length) {
      const op = args[i];
      if (op === "*" || op === "/" || op === "%") {
        i++;
        const right = parseMatch();
        const leftNum = parseInt(left, 10);
        const rightNum = parseInt(right, 10);
        if (Number.isNaN(leftNum) || Number.isNaN(rightNum)) {
          throw new Error("non-integer argument");
        }
        if ((op === "/" || op === "%") && rightNum === 0) {
          throw new Error("division by zero");
        }
        if (op === "*") {
          left = String(leftNum * rightNum);
        } else if (op === "/") {
          left = String(Math.trunc(leftNum / rightNum));
        } else {
          left = String(leftNum % rightNum);
        }
      } else {
        break;
      }
    }
    return left;
  }
  __name(parseMulDiv, "parseMulDiv");
  function parseMatch() {
    let left = parsePrimary();
    while (i < args.length && args[i] === ":") {
      i++;
      const pattern = parsePrimary();
      const regex = new RegExp(`^${pattern}`);
      const match = left.match(regex);
      if (match) {
        left = match[1] !== void 0 ? match[1] : String(match[0].length);
      } else {
        left = "0";
      }
    }
    return left;
  }
  __name(parseMatch, "parseMatch");
  function parsePrimary() {
    if (i >= args.length) {
      throw new Error("syntax error");
    }
    const token = args[i];
    if (token === "match") {
      i++;
      const str = parsePrimary();
      const pattern = parsePrimary();
      const regex = new RegExp(pattern);
      const match = str.match(regex);
      if (match) {
        return match[1] !== void 0 ? match[1] : String(match[0].length);
      }
      return "0";
    }
    if (token === "substr") {
      i++;
      const str = parsePrimary();
      const pos = parseInt(parsePrimary(), 10);
      const len = parseInt(parsePrimary(), 10);
      if (Number.isNaN(pos) || Number.isNaN(len)) {
        throw new Error("non-integer argument");
      }
      return str.substring(pos - 1, pos - 1 + len);
    }
    if (token === "index") {
      i++;
      const str = parsePrimary();
      const chars = parsePrimary();
      for (let j = 0; j < str.length; j++) {
        if (chars.includes(str[j])) {
          return String(j + 1);
        }
      }
      return "0";
    }
    if (token === "length") {
      i++;
      const str = parsePrimary();
      return String(str.length);
    }
    if (token === "(") {
      i++;
      const result = parseOr();
      if (i >= args.length || args[i] !== ")") {
        throw new Error("syntax error");
      }
      i++;
      return result;
    }
    i++;
    return token;
  }
  __name(parsePrimary, "parsePrimary");
  return parseOr();
}
__name(evaluateExpr, "evaluateExpr");
export {
  exprCommand
};
