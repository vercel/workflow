import { h as hasHelpFlag, s as showHelp, u as unknownOption } from "./chunk-HAN5425M.mjs";
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
var timeoutHelp = {
  name: "timeout",
  summary: "run a command with a time limit",
  usage: "timeout [OPTION] DURATION COMMAND [ARG]...",
  description: `Start COMMAND, and kill it if still running after DURATION.

DURATION is a number with optional suffix:
  s - seconds (default)
  m - minutes
  h - hours
  d - days`,
  options: [
    "-k, --kill-after=DURATION  send KILL signal after DURATION if still running",
    "-s, --signal=SIGNAL        specify signal to send (default: TERM)",
    "    --preserve-status      exit with same status as COMMAND, even on timeout",
    "    --foreground           run command in foreground",
    "    --help                 display this help and exit"
  ]
};
function parseDuration(arg) {
  const match = arg.match(/^(\d+\.?\d*)(s|m|h|d)?$/);
  if (!match)
    return null;
  const value = parseFloat(match[1]);
  const suffix = match[2] || "s";
  switch (suffix) {
    case "s":
      return value * 1e3;
    case "m":
      return value * 60 * 1e3;
    case "h":
      return value * 60 * 60 * 1e3;
    case "d":
      return value * 24 * 60 * 60 * 1e3;
    default:
      return null;
  }
}
__name(parseDuration, "parseDuration");
var timeoutCommand = {
  name: "timeout",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(timeoutHelp);
    }
    let preserveStatus = false;
    let commandStart = 0;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--preserve-status") {
        preserveStatus = true;
        commandStart = i + 1;
      } else if (arg === "--foreground") {
        commandStart = i + 1;
      } else if (arg === "-k" || arg === "--kill-after") {
        i++;
        commandStart = i + 1;
      } else if (arg.startsWith("--kill-after=")) {
        commandStart = i + 1;
      } else if (arg === "-s" || arg === "--signal") {
        i++;
        commandStart = i + 1;
      } else if (arg.startsWith("--signal=")) {
        commandStart = i + 1;
      } else if (arg.startsWith("--") && arg !== "--") {
        return unknownOption("timeout", arg);
      } else if (arg.startsWith("-") && arg.length > 1 && arg !== "--") {
        if (arg.startsWith("-k")) {
          commandStart = i + 1;
        } else if (arg.startsWith("-s")) {
          commandStart = i + 1;
        } else {
          return unknownOption("timeout", arg);
        }
      } else {
        commandStart = i;
        break;
      }
    }
    const remainingArgs = args.slice(commandStart);
    if (remainingArgs.length === 0) {
      return {
        stdout: "",
        stderr: "timeout: missing operand\n",
        exitCode: 1
      };
    }
    const durationStr = remainingArgs[0];
    const durationMs = parseDuration(durationStr);
    if (durationMs === null) {
      return {
        stdout: "",
        stderr: `timeout: invalid time interval '${durationStr}'
`,
        exitCode: 1
      };
    }
    const commandArgs = remainingArgs.slice(1);
    if (commandArgs.length === 0) {
      return {
        stdout: "",
        stderr: "timeout: missing operand\n",
        exitCode: 1
      };
    }
    if (!ctx.exec) {
      return {
        stdout: "",
        stderr: "timeout: exec not available\n",
        exitCode: 1
      };
    }
    const commandStr = commandArgs.map((arg) => {
      if (arg.includes(" ") || arg.includes("	")) {
        return `'${arg.replace(/'/g, "'\\''")}'`;
      }
      return arg;
    }).join(" ");
    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => resolve({ timedOut: true }), durationMs);
    });
    const execPromise = ctx.exec(commandStr, { cwd: ctx.cwd }).then((result) => ({ timedOut: false, result }));
    const outcome = await Promise.race([timeoutPromise, execPromise]);
    if (outcome.timedOut) {
      return {
        stdout: "",
        stderr: "",
        exitCode: preserveStatus ? 124 : 124
      };
    }
    return outcome.result;
  }
};
export {
  timeoutCommand
};
