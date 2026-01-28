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
var readlinkHelp = {
  name: "readlink",
  summary: "print resolved symbolic links or canonical file names",
  usage: "readlink [OPTIONS] FILE...",
  options: [
    "-f      canonicalize by following every symlink in every component of the given name recursively",
    "    --help display this help and exit"
  ]
};
var readlinkCommand = {
  name: "readlink",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(readlinkHelp);
    }
    let canonicalize = false;
    let argIdx = 0;
    while (argIdx < args.length && args[argIdx].startsWith("-")) {
      const arg = args[argIdx];
      if (arg === "-f" || arg === "--canonicalize") {
        canonicalize = true;
        argIdx++;
      } else if (arg === "--") {
        argIdx++;
        break;
      } else {
        return {
          stdout: "",
          stderr: `readlink: invalid option -- '${arg.slice(1)}'
`,
          exitCode: 1
        };
      }
    }
    const files = args.slice(argIdx);
    if (files.length === 0) {
      return { stdout: "", stderr: "readlink: missing operand\n", exitCode: 1 };
    }
    let stdout = "";
    let anyError = false;
    for (const file of files) {
      const filePath = ctx.fs.resolvePath(ctx.cwd, file);
      try {
        if (canonicalize) {
          let currentPath = filePath;
          const seen = /* @__PURE__ */ new Set();
          while (true) {
            if (seen.has(currentPath)) {
              break;
            }
            seen.add(currentPath);
            try {
              const target = await ctx.fs.readlink(currentPath);
              if (target.startsWith("/")) {
                currentPath = target;
              } else {
                const dir = currentPath.substring(0, currentPath.lastIndexOf("/")) || "/";
                currentPath = ctx.fs.resolvePath(dir, target);
              }
            } catch {
              break;
            }
          }
          stdout += `${currentPath}
`;
        } else {
          const target = await ctx.fs.readlink(filePath);
          stdout += `${target}
`;
        }
      } catch {
        if (!canonicalize) {
          anyError = true;
        } else {
          stdout += `${filePath}
`;
        }
      }
    }
    return { stdout, stderr: "", exitCode: anyError ? 1 : 0 };
  }
};
export {
  readlinkCommand
};
