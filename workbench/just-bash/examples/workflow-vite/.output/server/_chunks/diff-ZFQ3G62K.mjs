import { p as parseArgs } from "./chunk-5NTVBLMJ.mjs";
import { h as hasHelpFlag, s as showHelp } from "./chunk-HAN5425M.mjs";
import { c as createTwoFilesPatch } from "../_libs/diff.mjs";
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
var diffHelp = {
  name: "diff",
  summary: "compare files line by line",
  usage: "diff [OPTION]... FILE1 FILE2",
  options: [
    "-u, --unified     output unified diff format (default)",
    "-q, --brief       report only whether files differ",
    "-s, --report-identical-files  report when files are the same",
    "-i, --ignore-case  ignore case differences",
    "    --help        display this help and exit"
  ]
};
var argDefs = {
  unified: { short: "u", long: "unified", type: "boolean" },
  brief: { short: "q", long: "brief", type: "boolean" },
  reportSame: {
    short: "s",
    long: "report-identical-files",
    type: "boolean"
  },
  ignoreCase: { short: "i", long: "ignore-case", type: "boolean" }
};
var diffCommand = {
  name: "diff",
  async execute(args, ctx) {
    if (hasHelpFlag(args))
      return showHelp(diffHelp);
    const parsed = parseArgs("diff", args, argDefs);
    if (!parsed.ok)
      return parsed.error;
    const brief = parsed.result.flags.brief;
    const reportSame = parsed.result.flags.reportSame;
    const ignoreCase = parsed.result.flags.ignoreCase;
    const files = parsed.result.positional;
    void parsed.result.flags.unified;
    if (files.length < 2) {
      return { stdout: "", stderr: "diff: missing operand\n", exitCode: 2 };
    }
    let c1, c2;
    const [f1, f2] = files;
    try {
      c1 = f1 === "-" ? ctx.stdin : await ctx.fs.readFile(ctx.fs.resolvePath(ctx.cwd, f1));
    } catch {
      return {
        stdout: "",
        stderr: `diff: ${f1}: No such file or directory
`,
        exitCode: 2
      };
    }
    try {
      c2 = f2 === "-" ? ctx.stdin : await ctx.fs.readFile(ctx.fs.resolvePath(ctx.cwd, f2));
    } catch {
      return {
        stdout: "",
        stderr: `diff: ${f2}: No such file or directory
`,
        exitCode: 2
      };
    }
    let t1 = c1, t2 = c2;
    if (ignoreCase) {
      t1 = t1.toLowerCase();
      t2 = t2.toLowerCase();
    }
    if (t1 === t2) {
      if (reportSame)
        return {
          stdout: `Files ${f1} and ${f2} are identical
`,
          stderr: "",
          exitCode: 0
        };
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (brief) {
      return {
        stdout: `Files ${f1} and ${f2} differ
`,
        stderr: "",
        exitCode: 1
      };
    }
    const output = createTwoFilesPatch(f1, f2, c1, c2, "", "", {
      context: 3
    });
    return { stdout: output, stderr: "", exitCode: 1 };
  }
};
export {
  diffCommand
};
