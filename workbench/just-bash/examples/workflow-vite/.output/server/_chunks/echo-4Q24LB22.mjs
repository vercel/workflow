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
