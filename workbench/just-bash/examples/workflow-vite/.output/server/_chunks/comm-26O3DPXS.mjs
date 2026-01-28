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
var commHelp = {
  name: "comm",
  summary: "compare two sorted files line by line",
  usage: "comm [OPTION]... FILE1 FILE2",
  options: [
    "-1             suppress column 1 (lines unique to FILE1)",
    "-2             suppress column 2 (lines unique to FILE2)",
    "-3             suppress column 3 (lines that appear in both files)",
    "    --help     display this help and exit"
  ]
};
var commCommand = {
  name: "comm",
  async execute(args, ctx) {
    if (hasHelpFlag(args))
      return showHelp(commHelp);
    let suppress1 = false;
    let suppress2 = false;
    let suppress3 = false;
    const files = [];
    for (const arg of args) {
      if (arg === "-1")
        suppress1 = true;
      else if (arg === "-2")
        suppress2 = true;
      else if (arg === "-3")
        suppress3 = true;
      else if (arg === "-12" || arg === "-21") {
        suppress1 = true;
        suppress2 = true;
      } else if (arg === "-13" || arg === "-31") {
        suppress1 = true;
        suppress3 = true;
      } else if (arg === "-23" || arg === "-32") {
        suppress2 = true;
        suppress3 = true;
      } else if (arg === "-123" || arg === "-132" || arg === "-213" || arg === "-231" || arg === "-312" || arg === "-321") {
        suppress1 = true;
        suppress2 = true;
        suppress3 = true;
      } else if (arg.startsWith("-") && arg !== "-") {
        return unknownOption("comm", arg);
      } else {
        files.push(arg);
      }
    }
    if (files.length !== 2) {
      return {
        stdout: "",
        stderr: "comm: missing operand\nTry 'comm --help' for more information.\n",
        exitCode: 1
      };
    }
    const readFile = /* @__PURE__ */ __name(async (file) => {
      if (file === "-") {
        return ctx.stdin;
      }
      try {
        const path = ctx.fs.resolvePath(ctx.cwd, file);
        return await ctx.fs.readFile(path);
      } catch {
        return null;
      }
    }, "readFile");
    const content1 = await readFile(files[0]);
    if (content1 === null) {
      return {
        stdout: "",
        stderr: `comm: ${files[0]}: No such file or directory
`,
        exitCode: 1
      };
    }
    const content2 = await readFile(files[1]);
    if (content2 === null) {
      return {
        stdout: "",
        stderr: `comm: ${files[1]}: No such file or directory
`,
        exitCode: 1
      };
    }
    const lines1 = content1.split("\n");
    const lines2 = content2.split("\n");
    if (lines1.length > 0 && lines1[lines1.length - 1] === "")
      lines1.pop();
    if (lines2.length > 0 && lines2[lines2.length - 1] === "")
      lines2.pop();
    let i = 0;
    let j = 0;
    let output = "";
    const col2Prefix = suppress1 ? "" : "	";
    const col3Prefix = (suppress1 ? "" : "	") + (suppress2 ? "" : "	");
    while (i < lines1.length || j < lines2.length) {
      if (i >= lines1.length) {
        if (!suppress2) {
          output += `${col2Prefix}${lines2[j]}
`;
        }
        j++;
      } else if (j >= lines2.length) {
        if (!suppress1) {
          output += `${lines1[i]}
`;
        }
        i++;
      } else if (lines1[i] < lines2[j]) {
        if (!suppress1) {
          output += `${lines1[i]}
`;
        }
        i++;
      } else if (lines1[i] > lines2[j]) {
        if (!suppress2) {
          output += `${col2Prefix}${lines2[j]}
`;
        }
        j++;
      } else {
        if (!suppress3) {
          output += `${col3Prefix}${lines1[i]}
`;
        }
        i++;
        j++;
      }
    }
    return { stdout: output, stderr: "", exitCode: 0 };
  }
};
export {
  commCommand
};
