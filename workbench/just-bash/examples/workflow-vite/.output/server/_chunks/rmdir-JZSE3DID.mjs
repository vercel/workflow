import { p as parseArgs } from "./chunk-5NTVBLMJ.mjs";
import { m as getErrorMessage, _ as __name } from "../index.mjs";
import "./chunk-HAN5425M.mjs";
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
var USAGE = `Usage: rmdir [-pv] DIRECTORY...
Remove empty directories.

Options:
  -p, --parents   Remove DIRECTORY and its ancestors
  -v, --verbose   Output a diagnostic for every directory processed`;
var argDefs = {
  parents: { short: "p", long: "parents", type: "boolean" },
  verbose: { short: "v", long: "verbose", type: "boolean" },
  help: { long: "help", type: "boolean" }
};
var rmdirCommand = {
  name: "rmdir",
  async execute(args, ctx) {
    const parsed = parseArgs("rmdir", args, argDefs);
    if (!parsed.ok)
      return parsed.error;
    if (parsed.result.flags.help) {
      return { stdout: `${USAGE}
`, stderr: "", exitCode: 0 };
    }
    const parents = parsed.result.flags.parents;
    const verbose = parsed.result.flags.verbose;
    const dirs = parsed.result.positional;
    if (dirs.length === 0) {
      return {
        stdout: "",
        stderr: "rmdir: missing operand\n",
        exitCode: 1
      };
    }
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    for (const dir of dirs) {
      const result = await removeDir(ctx, dir, parents, verbose);
      stdout += result.stdout;
      stderr += result.stderr;
      if (result.exitCode !== 0) {
        exitCode = result.exitCode;
      }
    }
    return { stdout, stderr, exitCode };
  }
};
async function removeDir(ctx, dir, parents, verbose) {
  let stdout = "";
  let stderr = "";
  const exitCode = 0;
  const fullPath = ctx.fs.resolvePath(ctx.cwd, dir);
  const result = await removeSingleDir(ctx, fullPath, dir, verbose);
  stdout += result.stdout;
  stderr += result.stderr;
  if (result.exitCode !== 0) {
    return { stdout, stderr, exitCode: result.exitCode };
  }
  if (parents) {
    let currentPath = fullPath;
    let currentDir = dir;
    while (true) {
      const parentPath = getParentPath(currentPath);
      const parentDir = getParentPath(currentDir);
      if (parentPath === currentPath || parentPath === "/" || parentPath === "." || parentDir === "." || parentDir === "") {
        break;
      }
      const parentResult = await removeSingleDir(ctx, parentPath, parentDir, verbose);
      stdout += parentResult.stdout;
      if (parentResult.exitCode !== 0) {
        break;
      }
      currentPath = parentPath;
      currentDir = parentDir;
    }
  }
  return { stdout, stderr, exitCode };
}
__name(removeDir, "removeDir");
async function removeSingleDir(ctx, fullPath, displayPath, verbose) {
  try {
    const exists = await ctx.fs.exists(fullPath);
    if (!exists) {
      return {
        stdout: "",
        stderr: `rmdir: failed to remove '${displayPath}': No such file or directory
`,
        exitCode: 1
      };
    }
    const stat = await ctx.fs.stat(fullPath);
    if (!stat.isDirectory) {
      return {
        stdout: "",
        stderr: `rmdir: failed to remove '${displayPath}': Not a directory
`,
        exitCode: 1
      };
    }
    const entries = await ctx.fs.readdir(fullPath);
    if (entries.length > 0) {
      return {
        stdout: "",
        stderr: `rmdir: failed to remove '${displayPath}': Directory not empty
`,
        exitCode: 1
      };
    }
    await ctx.fs.rm(fullPath, { recursive: false, force: false });
    let stdout = "";
    if (verbose) {
      stdout = `rmdir: removing directory, '${displayPath}'
`;
    }
    return { stdout, stderr: "", exitCode: 0 };
  } catch (error) {
    const message = getErrorMessage(error);
    return {
      stdout: "",
      stderr: `rmdir: failed to remove '${displayPath}': ${message}
`,
      exitCode: 1
    };
  }
}
__name(removeSingleDir, "removeSingleDir");
function getParentPath(path) {
  const normalized = path.replace(/\/+$/, "");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash === -1) {
    return ".";
  }
  if (lastSlash === 0) {
    return "/";
  }
  return normalized.substring(0, lastSlash);
}
__name(getParentPath, "getParentPath");
export {
  rmdirCommand
};
