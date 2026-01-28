import { h as hasHelpFlag, s as showHelp } from "./chunk-HAN5425M.mjs";
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
var aliasHelp = {
  name: "alias",
  summary: "define or display aliases",
  usage: "alias [name[=value] ...]",
  options: ["    --help display this help and exit"]
};
var ALIAS_PREFIX = "BASH_ALIAS_";
var aliasCommand = {
  name: "alias",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(aliasHelp);
    }
    if (args.length === 0) {
      let stdout = "";
      for (const [key, value] of Object.entries(ctx.env)) {
        if (key.startsWith(ALIAS_PREFIX)) {
          const name = key.slice(ALIAS_PREFIX.length);
          stdout += `alias ${name}='${value}'
`;
        }
      }
      return { stdout, stderr: "", exitCode: 0 };
    }
    const processArgs = args[0] === "--" ? args.slice(1) : args;
    for (const arg of processArgs) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx === -1) {
        const key = ALIAS_PREFIX + arg;
        if (ctx.env[key]) {
          return {
            stdout: `alias ${arg}='${ctx.env[key]}'
`,
            stderr: "",
            exitCode: 0
          };
        } else {
          return {
            stdout: "",
            stderr: `alias: ${arg}: not found
`,
            exitCode: 1
          };
        }
      } else {
        const name = arg.slice(0, eqIdx);
        let value = arg.slice(eqIdx + 1);
        if (value.startsWith("'") && value.endsWith("'") || value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1);
        }
        ctx.env[ALIAS_PREFIX + name] = value;
      }
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  }
};
var unaliasCommand = {
  name: "unalias",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp({
        name: "unalias",
        summary: "remove alias definitions",
        usage: "unalias name [name ...]",
        options: [
          "-a      remove all aliases",
          "    --help display this help and exit"
        ]
      });
    }
    if (args.length === 0) {
      return {
        stdout: "",
        stderr: "unalias: usage: unalias [-a] name [name ...]\n",
        exitCode: 1
      };
    }
    if (args[0] === "-a") {
      for (const key of Object.keys(ctx.env)) {
        if (key.startsWith(ALIAS_PREFIX)) {
          delete ctx.env[key];
        }
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    const processArgs = args[0] === "--" ? args.slice(1) : args;
    let anyError = false;
    let stderr = "";
    for (const name of processArgs) {
      const key = ALIAS_PREFIX + name;
      if (ctx.env[key]) {
        delete ctx.env[key];
      } else {
        stderr += `unalias: ${name}: not found
`;
        anyError = true;
      }
    }
    return { stdout: "", stderr, exitCode: anyError ? 1 : 0 };
  }
};
export {
  aliasCommand,
  unaliasCommand
};
