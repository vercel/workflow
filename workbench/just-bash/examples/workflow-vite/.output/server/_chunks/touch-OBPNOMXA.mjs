import { m as getErrorMessage, _ as __name } from "../index.mjs";
import { u as unknownOption } from "./chunk-HAN5425M.mjs";
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
function parseDateString(dateStr) {
  const normalized = dateStr.replace(/\//g, "-");
  let date = new Date(normalized);
  if (!Number.isNaN(date.getTime())) {
    return date;
  }
  const dateMatch = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateMatch) {
    const [, year, month, day] = dateMatch;
    date = new Date(Number.parseInt(year, 10), Number.parseInt(month, 10) - 1, Number.parseInt(day, 10));
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }
  const dateTimeMatch = normalized.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (dateTimeMatch) {
    const [, year, month, day, hour, minute, second] = dateTimeMatch;
    date = new Date(Number.parseInt(year, 10), Number.parseInt(month, 10) - 1, Number.parseInt(day, 10), Number.parseInt(hour, 10), Number.parseInt(minute, 10), Number.parseInt(second, 10));
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }
  return null;
}
__name(parseDateString, "parseDateString");
var touchCommand = {
  name: "touch",
  async execute(args, ctx) {
    const files = [];
    let dateStr = null;
    let noCreate = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--") {
        files.push(...args.slice(i + 1));
        break;
      } else if (arg === "-d" || arg === "--date") {
        if (i + 1 >= args.length) {
          return {
            stdout: "",
            stderr: "touch: option requires an argument -- 'd'\n",
            exitCode: 1
          };
        }
        dateStr = args[++i];
      } else if (arg.startsWith("--date=")) {
        dateStr = arg.slice("--date=".length);
      } else if (arg === "-c" || arg === "--no-create") {
        noCreate = true;
      } else if (arg === "-a" || arg === "-m" || arg === "-r" || arg === "-t") {
        if (arg === "-r" || arg === "-t") {
          i++;
        }
      } else if (arg.startsWith("--")) {
        return unknownOption("touch", arg);
      } else if (arg.startsWith("-") && arg.length > 1) {
        let skipNext = false;
        for (const char of arg.slice(1)) {
          if (char === "c") {
            noCreate = true;
          } else if (char === "a" || char === "m") ;
          else if (char === "d") {
            if (i + 1 >= args.length) {
              return {
                stdout: "",
                stderr: "touch: option requires an argument -- 'd'\n",
                exitCode: 1
              };
            }
            dateStr = args[++i];
            skipNext = true;
            break;
          } else if (char === "r" || char === "t") {
            i++;
            skipNext = true;
            break;
          } else {
            return unknownOption("touch", `-${char}`);
          }
        }
        if (skipNext)
          continue;
      } else {
        files.push(arg);
      }
    }
    if (files.length === 0) {
      return {
        stdout: "",
        stderr: "touch: missing file operand\n",
        exitCode: 1
      };
    }
    let targetTime = null;
    if (dateStr !== null) {
      targetTime = parseDateString(dateStr);
      if (targetTime === null) {
        return {
          stdout: "",
          stderr: `touch: invalid date format '${dateStr}'
`,
          exitCode: 1
        };
      }
    }
    let stderr = "";
    let exitCode = 0;
    for (const file of files) {
      try {
        const fullPath = ctx.fs.resolvePath(ctx.cwd, file);
        const exists = await ctx.fs.exists(fullPath);
        if (!exists) {
          if (noCreate) {
            continue;
          }
          await ctx.fs.writeFile(fullPath, "");
        }
        const mtime = targetTime ?? /* @__PURE__ */ new Date();
        await ctx.fs.utimes(fullPath, mtime, mtime);
      } catch (error) {
        stderr += `touch: cannot touch '${file}': ${getErrorMessage(error)}
`;
        exitCode = 1;
      }
    }
    return { stdout: "", stderr, exitCode };
  }
};
export {
  touchCommand
};
