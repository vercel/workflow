import { h as hasHelpFlag, s as showHelp, u as unknownOption } from "./chunk-HAN5425M.mjs";
import "../index.mjs";
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
var envHelp = {
  name: "env",
  summary: "run a program in a modified environment",
  usage: "env [OPTION]... [NAME=VALUE]... [COMMAND [ARG]...]",
  options: [
    "-i, --ignore-environment  start with an empty environment",
    "-u NAME, --unset=NAME     remove NAME from the environment",
    "    --help                display this help and exit"
  ]
};
var envCommand = {
  name: "env",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(envHelp);
    }
    let ignoreEnv = false;
    const unsetVars = [];
    const setVars = {};
    let commandStart = -1;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "-i" || arg === "--ignore-environment") {
        ignoreEnv = true;
      } else if (arg === "-u" && i + 1 < args.length) {
        unsetVars.push(args[++i]);
      } else if (arg.startsWith("-u")) {
        unsetVars.push(arg.slice(2));
      } else if (arg.startsWith("--unset=")) {
        unsetVars.push(arg.slice(8));
      } else if (arg.startsWith("--") && arg !== "--") {
        return unknownOption("env", arg);
      } else if (arg.startsWith("-") && arg !== "-") {
        for (const c of arg.slice(1)) {
          if (c !== "i" && c !== "u") {
            return unknownOption("env", `-${c}`);
          }
        }
        if (arg.includes("i"))
          ignoreEnv = true;
      } else if (arg.includes("=") && commandStart === -1) {
        const eqIdx = arg.indexOf("=");
        const name = arg.slice(0, eqIdx);
        const value = arg.slice(eqIdx + 1);
        setVars[name] = value;
      } else {
        commandStart = i;
        break;
      }
    }
    let newEnv;
    if (ignoreEnv) {
      newEnv = { ...setVars };
    } else {
      newEnv = { ...ctx.env };
      for (const name of unsetVars) {
        delete newEnv[name];
      }
      Object.assign(newEnv, setVars);
    }
    if (commandStart === -1) {
      const lines = [];
      for (const [key, value] of Object.entries(newEnv)) {
        lines.push(`${key}=${value}`);
      }
      return {
        stdout: lines.join("\n") + (lines.length > 0 ? "\n" : ""),
        stderr: "",
        exitCode: 0
      };
    }
    if (!ctx.exec) {
      return {
        stdout: "",
        stderr: "env: command execution not supported in this context\n",
        exitCode: 1
      };
    }
    const cmdArgs = args.slice(commandStart);
    const cmdName = cmdArgs[0];
    const cmdRest = cmdArgs.slice(1);
    const quotedArgs = cmdRest.map((arg) => {
      if (/[\s"'\\$`!*?[\]{}|&;<>()]/.test(arg)) {
        return `'${arg.replace(/'/g, "'\\''")}'`;
      }
      return arg;
    });
    const command = [`command`, cmdName, ...quotedArgs].join(" ");
    const envPrefix = Object.entries(setVars).map(([k, v]) => `${k}="${v}"`).join(" ");
    const fullCommand = envPrefix ? `${envPrefix} ${command}` : command;
    return ctx.exec(fullCommand, { cwd: ctx.cwd });
  }
};
var printenvHelp = {
  name: "printenv",
  summary: "print all or part of environment",
  usage: "printenv [OPTION]... [VARIABLE]...",
  options: ["    --help       display this help and exit"]
};
var printenvCommand = {
  name: "printenv",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(printenvHelp);
    }
    const vars = args.filter((arg) => !arg.startsWith("-"));
    if (vars.length === 0) {
      const lines2 = [];
      for (const [key, value] of Object.entries(ctx.env)) {
        lines2.push(`${key}=${value}`);
      }
      return {
        stdout: lines2.join("\n") + (lines2.length > 0 ? "\n" : ""),
        stderr: "",
        exitCode: 0
      };
    }
    const lines = [];
    let exitCode = 0;
    for (const varName of vars) {
      if (varName in ctx.env) {
        lines.push(ctx.env[varName]);
      } else {
        exitCode = 1;
      }
    }
    return {
      stdout: lines.join("\n") + (lines.length > 0 ? "\n" : ""),
      stderr: "",
      exitCode
    };
  }
};
export {
  envCommand,
  printenvCommand
};
