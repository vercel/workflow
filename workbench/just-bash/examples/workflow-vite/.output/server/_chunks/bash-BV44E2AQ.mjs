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
var bashHelp = {
  name: "bash",
  summary: "execute shell commands or scripts",
  usage: "bash [OPTIONS] [SCRIPT_FILE] [ARGUMENTS...]",
  options: [
    "-c COMMAND  execute COMMAND string",
    "    --help  display this help and exit"
  ],
  notes: [
    "Without -c, reads and executes commands from SCRIPT_FILE.",
    "Arguments are passed as $1, $2, etc. to the script.",
    '$0 is set to the script name (or "bash" with -c).'
  ]
};
var bashCommand = {
  name: "bash",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(bashHelp);
    }
    if (args[0] === "-c" && args.length >= 2) {
      const command = args[1];
      const scriptName = args[2] || "bash";
      const scriptArgs2 = args.slice(3);
      return executeScript(command, scriptName, scriptArgs2, ctx);
    }
    if (args.length === 0) {
      if (ctx.stdin?.trim()) {
        return executeScript(ctx.stdin, "bash", [], ctx);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    const scriptPath = args[0];
    const scriptArgs = args.slice(1);
    try {
      const fullPath = ctx.fs.resolvePath(ctx.cwd, scriptPath);
      const scriptContent = await ctx.fs.readFile(fullPath);
      return executeScript(scriptContent, scriptPath, scriptArgs, ctx);
    } catch {
      return {
        stdout: "",
        stderr: `bash: ${scriptPath}: No such file or directory
`,
        exitCode: 127
      };
    }
  }
};
var shCommand = {
  name: "sh",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp({
        ...bashHelp,
        name: "sh",
        summary: "execute shell commands or scripts (POSIX shell)"
      });
    }
    if (args[0] === "-c" && args.length >= 2) {
      const command = args[1];
      const scriptName = args[2] || "sh";
      const scriptArgs2 = args.slice(3);
      return executeScript(command, scriptName, scriptArgs2, ctx);
    }
    if (args.length === 0) {
      if (ctx.stdin?.trim()) {
        return executeScript(ctx.stdin, "sh", [], ctx);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    const scriptPath = args[0];
    const scriptArgs = args.slice(1);
    try {
      const fullPath = ctx.fs.resolvePath(ctx.cwd, scriptPath);
      const scriptContent = await ctx.fs.readFile(fullPath);
      return executeScript(scriptContent, scriptPath, scriptArgs, ctx);
    } catch {
      return {
        stdout: "",
        stderr: `sh: ${scriptPath}: No such file or directory
`,
        exitCode: 127
      };
    }
  }
};
async function executeScript(script, scriptName, scriptArgs, ctx) {
  if (!ctx.exec) {
    return {
      stdout: "",
      stderr: "bash: internal error: exec function not available\n",
      exitCode: 1
    };
  }
  const positionalEnv = {
    // Inherit exported environment from parent context
    ...ctx.exportedEnv || {},
    // Override with positional parameters
    "0": scriptName,
    "#": String(scriptArgs.length),
    "@": scriptArgs.join(" "),
    "*": scriptArgs.join(" ")
  };
  scriptArgs.forEach((arg, i) => {
    positionalEnv[String(i + 1)] = arg;
  });
  let scriptToRun = script;
  if (scriptToRun.startsWith("#!")) {
    const firstNewline = scriptToRun.indexOf("\n");
    if (firstNewline !== -1) {
      scriptToRun = scriptToRun.slice(firstNewline + 1);
    }
  }
  const result = await ctx.exec(scriptToRun, {
    env: positionalEnv,
    cwd: ctx.cwd
  });
  return result;
}
__name(executeScript, "executeScript");
export {
  bashCommand,
  shCommand
};
