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
var statHelp = {
  name: "stat",
  summary: "display file or file system status",
  usage: "stat [OPTION]... FILE...",
  options: [
    "-c FORMAT   use the specified FORMAT instead of the default",
    "    --help  display this help and exit"
  ]
};
var argDefs = {
  format: { short: "c", type: "string" }
};
var statCommand = {
  name: "stat",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(statHelp);
    }
    const parsed = parseArgs("stat", args, argDefs);
    if (!parsed.ok)
      return parsed.error;
    const format = parsed.result.flags.format ?? null;
    const files = parsed.result.positional;
    if (files.length === 0) {
      return {
        stdout: "",
        stderr: "stat: missing operand\n",
        exitCode: 1
      };
    }
    let stdout = "";
    let stderr = "";
    let hasError = false;
    for (const file of files) {
      const fullPath = ctx.fs.resolvePath(ctx.cwd, file);
      try {
        const stat = await ctx.fs.stat(fullPath);
        if (format) {
          let output = format;
          const modeOctal = stat.mode.toString(8);
          const modeStr = formatModeString(stat.mode, stat.isDirectory);
          output = output.replace(/%n/g, file);
          output = output.replace(/%N/g, `'${file}'`);
          output = output.replace(/%s/g, String(stat.size));
          output = output.replace(/%F/g, stat.isDirectory ? "directory" : "regular file");
          output = output.replace(/%a/g, modeOctal);
          output = output.replace(/%A/g, modeStr);
          output = output.replace(/%u/g, "1000");
          output = output.replace(/%U/g, "user");
          output = output.replace(/%g/g, "1000");
          output = output.replace(/%G/g, "group");
          stdout += `${output}
`;
        } else {
          const modeOctal = stat.mode.toString(8).padStart(4, "0");
          const modeStr = formatModeString(stat.mode, stat.isDirectory);
          stdout += `  File: ${file}
`;
          stdout += `  Size: ${stat.size}		Blocks: ${Math.ceil(stat.size / 512)}
`;
          stdout += `Access: (${modeOctal}/${modeStr})
`;
          stdout += `Modify: ${stat.mtime.toISOString()}
`;
        }
      } catch {
        stderr += `stat: cannot stat '${file}': No such file or directory
`;
        hasError = true;
      }
    }
    return { stdout, stderr, exitCode: hasError ? 1 : 0 };
  }
};
function formatModeString(mode, isDirectory) {
  const typeChar = isDirectory ? "d" : "-";
  const perms = [
    mode & 256 ? "r" : "-",
    mode & 128 ? "w" : "-",
    mode & 64 ? "x" : "-",
    mode & 32 ? "r" : "-",
    mode & 16 ? "w" : "-",
    mode & 8 ? "x" : "-",
    mode & 4 ? "r" : "-",
    mode & 2 ? "w" : "-",
    mode & 1 ? "x" : "-"
  ];
  return typeChar + perms.join("");
}
__name(formatModeString, "formatModeString");
export {
  statCommand
};
