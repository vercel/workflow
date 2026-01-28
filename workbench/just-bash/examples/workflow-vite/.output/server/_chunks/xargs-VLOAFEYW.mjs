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
var xargsHelp = {
  name: "xargs",
  summary: "build and execute command lines from standard input",
  usage: "xargs [OPTION]... [COMMAND [INITIAL-ARGS]]",
  options: [
    "-I REPLACE   replace occurrences of REPLACE with input",
    "-d DELIM     use DELIM as input delimiter (e.g., -d '\\n' for newline)",
    "-n NUM       use at most NUM arguments per command line",
    "-P NUM       run at most NUM processes at a time",
    "-0, --null   items are separated by null, not whitespace",
    "-t, --verbose  print commands before executing",
    "-r, --no-run-if-empty  do not run command if input is empty",
    "    --help   display this help and exit"
  ]
};
var xargsCommand = {
  name: "xargs",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(xargsHelp);
    }
    let replaceStr = null;
    let delimiter = null;
    let maxArgs = null;
    let maxProcs = null;
    let nullSeparator = false;
    let verbose = false;
    let noRunIfEmpty = false;
    let commandStart = 0;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "-I" && i + 1 < args.length) {
        replaceStr = args[++i];
        commandStart = i + 1;
      } else if (arg === "-d" && i + 1 < args.length) {
        const delimArg = args[++i];
        delimiter = delimArg.replace(/\\n/g, "\n").replace(/\\t/g, "	").replace(/\\r/g, "\r").replace(/\\0/g, "\0").replace(/\\\\/g, "\\");
        commandStart = i + 1;
      } else if (arg === "-n" && i + 1 < args.length) {
        maxArgs = parseInt(args[++i], 10);
        commandStart = i + 1;
      } else if (arg === "-P" && i + 1 < args.length) {
        maxProcs = parseInt(args[++i], 10);
        commandStart = i + 1;
      } else if (arg === "-0" || arg === "--null") {
        nullSeparator = true;
        commandStart = i + 1;
      } else if (arg === "-t" || arg === "--verbose") {
        verbose = true;
        commandStart = i + 1;
      } else if (arg === "-r" || arg === "--no-run-if-empty") {
        noRunIfEmpty = true;
        commandStart = i + 1;
      } else if (arg.startsWith("--")) {
        return unknownOption("xargs", arg);
      } else if (arg.startsWith("-") && arg.length > 1) {
        for (const c of arg.slice(1)) {
          if (!"0tr".includes(c)) {
            return unknownOption("xargs", `-${c}`);
          }
        }
        if (arg.includes("0"))
          nullSeparator = true;
        if (arg.includes("t"))
          verbose = true;
        if (arg.includes("r"))
          noRunIfEmpty = true;
        commandStart = i + 1;
      } else if (!arg.startsWith("-")) {
        commandStart = i;
        break;
      }
    }
    const command = args.slice(commandStart);
    if (command.length === 0) {
      command.push("echo");
    }
    let items;
    if (nullSeparator) {
      items = ctx.stdin.split("\0").filter((s) => s.length > 0);
    } else if (delimiter !== null) {
      const input = ctx.stdin.replace(/\n$/, "");
      items = input.split(delimiter).filter((s) => s.length > 0);
    } else {
      items = ctx.stdin.split(/\s+/).map((s) => s.trim()).filter((s) => s.length > 0);
    }
    if (items.length === 0) {
      if (noRunIfEmpty) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    const quoteArg = /* @__PURE__ */ __name((arg) => {
      if (/[\s"'\\$`!*?[\]{}();&|<>#]/.test(arg)) {
        return `"${arg.replace(/([\\"`$])/g, "\\$1")}"`;
      }
      return arg;
    }, "quoteArg");
    const executeCommand = /* @__PURE__ */ __name(async (cmdArgs) => {
      const cmdLine = cmdArgs.map(quoteArg).join(" ");
      if (verbose) {
        stderr += `${cmdLine}
`;
      }
      if (ctx.exec) {
        return ctx.exec(cmdLine, { cwd: ctx.cwd });
      }
      return { stdout: `${cmdLine}
`, stderr: "", exitCode: 0 };
    }, "executeCommand");
    const runCommands = /* @__PURE__ */ __name(async (cmdArgsList) => {
      if (maxProcs !== null && maxProcs > 1) {
        for (let i = 0; i < cmdArgsList.length; i += maxProcs) {
          const batch = cmdArgsList.slice(i, i + maxProcs);
          const results = await Promise.all(batch.map(executeCommand));
          for (const result of results) {
            stdout += result.stdout;
            stderr += result.stderr;
            if (result.exitCode !== 0) {
              exitCode = result.exitCode;
            }
          }
        }
      } else {
        for (const cmdArgs of cmdArgsList) {
          const result = await executeCommand(cmdArgs);
          stdout += result.stdout;
          stderr += result.stderr;
          if (result.exitCode !== 0) {
            exitCode = result.exitCode;
          }
        }
      }
    }, "runCommands");
    if (replaceStr !== null) {
      const cmdArgsList = items.map((item) => command.map((c) => c.replaceAll(replaceStr, item)));
      await runCommands(cmdArgsList);
    } else if (maxArgs !== null) {
      const cmdArgsList = [];
      for (let i = 0; i < items.length; i += maxArgs) {
        const batch = items.slice(i, i + maxArgs);
        cmdArgsList.push([...command, ...batch]);
      }
      await runCommands(cmdArgsList);
    } else {
      const cmdArgs = [...command, ...items];
      const result = await executeCommand(cmdArgs);
      stdout += result.stdout;
      stderr += result.stderr;
      exitCode = result.exitCode;
    }
    return { stdout, stderr, exitCode };
  }
};
export {
  xargsCommand
};
