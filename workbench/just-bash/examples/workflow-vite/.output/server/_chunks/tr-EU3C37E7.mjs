import { p as parseArgs } from "./chunk-5NTVBLMJ.mjs";
import { h as hasHelpFlag, s as showHelp } from "./chunk-HAN5425M.mjs";
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
var trHelp = {
  name: "tr",
  summary: "translate or delete characters",
  usage: "tr [OPTION]... SET1 [SET2]",
  options: [
    "-c, -C, --complement   use the complement of SET1",
    "-d, --delete           delete characters in SET1",
    "-s, --squeeze-repeats  squeeze repeated characters",
    "    --help             display this help and exit"
  ],
  description: `SET syntax:
  a-z         character range
  [:alnum:]   all letters and digits
  [:alpha:]   all letters
  [:digit:]   all digits
  [:lower:]   all lowercase letters
  [:upper:]   all uppercase letters
  [:space:]   all whitespace
  [:blank:]   horizontal whitespace
  [:punct:]   all punctuation
  [:print:]   all printable characters
  [:graph:]   all printable characters except space
  [:cntrl:]   all control characters
  [:xdigit:]  all hexadecimal digits
  \\n, \\t, \\r  escape sequences`
};
var POSIX_CLASSES = {
  "[:alnum:]": "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  "[:alpha:]": "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
  "[:blank:]": " 	",
  "[:cntrl:]": Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join("").concat(String.fromCharCode(127)),
  "[:digit:]": "0123456789",
  "[:graph:]": Array.from({ length: 94 }, (_, i) => String.fromCharCode(33 + i)).join(""),
  "[:lower:]": "abcdefghijklmnopqrstuvwxyz",
  "[:print:]": Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join(""),
  "[:punct:]": "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~",
  "[:space:]": " 	\n\r\f\v",
  "[:upper:]": "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  "[:xdigit:]": "0123456789ABCDEFabcdef"
};
function expandRange(set) {
  let result = "";
  let i = 0;
  while (i < set.length) {
    if (set[i] === "[" && set[i + 1] === ":") {
      let found = false;
      for (const [className, chars] of Object.entries(POSIX_CLASSES)) {
        if (set.slice(i).startsWith(className)) {
          result += chars;
          i += className.length;
          found = true;
          break;
        }
      }
      if (found)
        continue;
    }
    if (set[i] === "\\" && i + 1 < set.length) {
      const next = set[i + 1];
      if (next === "n") {
        result += "\n";
      } else if (next === "t") {
        result += "	";
      } else if (next === "r") {
        result += "\r";
      } else {
        result += next;
      }
      i += 2;
      continue;
    }
    if (i + 2 < set.length && set[i + 1] === "-") {
      const start = set.charCodeAt(i);
      const end = set.charCodeAt(i + 2);
      for (let code = start; code <= end; code++) {
        result += String.fromCharCode(code);
      }
      i += 3;
      continue;
    }
    result += set[i];
    i++;
  }
  return result;
}
__name(expandRange, "expandRange");
var argDefs = {
  complement: { short: "c", long: "complement", type: "boolean" },
  complementUpper: { short: "C", type: "boolean" },
  delete: { short: "d", long: "delete", type: "boolean" },
  squeeze: { short: "s", long: "squeeze-repeats", type: "boolean" }
};
var trCommand = {
  name: "tr",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(trHelp);
    }
    const parsed = parseArgs("tr", args, argDefs);
    if (!parsed.ok)
      return parsed.error;
    const complementMode = parsed.result.flags.complement || parsed.result.flags.complementUpper;
    const deleteMode = parsed.result.flags.delete;
    const squeezeMode = parsed.result.flags.squeeze;
    const sets = parsed.result.positional;
    if (sets.length < 1) {
      return {
        stdout: "",
        stderr: "tr: missing operand\n",
        exitCode: 1
      };
    }
    if (!deleteMode && !squeezeMode && sets.length < 2) {
      return {
        stdout: "",
        stderr: "tr: missing operand after SET1\n",
        exitCode: 1
      };
    }
    const set1Raw = expandRange(sets[0]);
    const set2 = sets.length > 1 ? expandRange(sets[1]) : "";
    const content = ctx.stdin;
    const isInSet1 = /* @__PURE__ */ __name((char) => {
      const inSet = set1Raw.includes(char);
      return complementMode ? !inSet : inSet;
    }, "isInSet1");
    let output = "";
    if (deleteMode) {
      for (const char of content) {
        if (!isInSet1(char)) {
          output += char;
        }
      }
    } else if (squeezeMode && sets.length === 1) {
      let prev = "";
      for (const char of content) {
        if (isInSet1(char) && char === prev) {
          continue;
        }
        output += char;
        prev = char;
      }
    } else {
      if (complementMode) {
        const targetChar = set2.length > 0 ? set2[set2.length - 1] : "";
        for (const char of content) {
          if (!set1Raw.includes(char)) {
            output += targetChar;
          } else {
            output += char;
          }
        }
      } else {
        const translationMap = /* @__PURE__ */ new Map();
        for (let i = 0; i < set1Raw.length; i++) {
          const targetChar = i < set2.length ? set2[i] : set2[set2.length - 1];
          translationMap.set(set1Raw[i], targetChar);
        }
        for (const char of content) {
          output += translationMap.get(char) ?? char;
        }
      }
      if (squeezeMode) {
        let squeezed = "";
        let prev = "";
        for (const char of output) {
          if (set2.includes(char) && char === prev) {
            continue;
          }
          squeezed += char;
          prev = char;
        }
        output = squeezed;
      }
    }
    return { stdout: output, stderr: "", exitCode: 0 };
  }
};
export {
  trCommand
};
