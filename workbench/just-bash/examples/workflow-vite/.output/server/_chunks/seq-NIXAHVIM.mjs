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
var seqCommand = {
  name: "seq",
  async execute(args) {
    let separator = "\n";
    let equalizeWidth = false;
    const nums = [];
    let i = 0;
    while (i < args.length) {
      const arg = args[i];
      if (arg === "-s" && i + 1 < args.length) {
        separator = args[i + 1];
        i += 2;
        continue;
      }
      if (arg === "-w") {
        equalizeWidth = true;
        i++;
        continue;
      }
      if (arg === "--") {
        i++;
        break;
      }
      if (arg.startsWith("-") && arg !== "-") {
        if (arg.startsWith("-s") && arg.length > 2) {
          separator = arg.slice(2);
          i++;
          continue;
        }
        if (arg === "-ws" || arg === "-sw") {
          equalizeWidth = true;
          if (i + 1 < args.length) {
            separator = args[i + 1];
            i += 2;
            continue;
          }
        }
      }
      nums.push(arg);
      i++;
    }
    while (i < args.length) {
      nums.push(args[i]);
      i++;
    }
    if (nums.length === 0) {
      return {
        stdout: "",
        stderr: "seq: missing operand\n",
        exitCode: 1
      };
    }
    let first = 1;
    let increment = 1;
    let last;
    if (nums.length === 1) {
      last = parseFloat(nums[0]);
    } else if (nums.length === 2) {
      first = parseFloat(nums[0]);
      last = parseFloat(nums[1]);
    } else {
      first = parseFloat(nums[0]);
      increment = parseFloat(nums[1]);
      last = parseFloat(nums[2]);
    }
    if (Number.isNaN(first) || Number.isNaN(increment) || Number.isNaN(last)) {
      const invalid = nums.find((n) => Number.isNaN(parseFloat(n)));
      return {
        stdout: "",
        stderr: `seq: invalid floating point argument: '${invalid}'
`,
        exitCode: 1
      };
    }
    if (increment === 0) {
      return {
        stdout: "",
        stderr: "seq: invalid Zero increment value: '0'\n",
        exitCode: 1
      };
    }
    const results = [];
    const getPrecision = /* @__PURE__ */ __name((n) => {
      const str = String(n);
      const dotIndex = str.indexOf(".");
      return dotIndex === -1 ? 0 : str.length - dotIndex - 1;
    }, "getPrecision");
    const precision = Math.max(getPrecision(first), getPrecision(increment), getPrecision(last));
    const maxIterations = 1e5;
    let iterations = 0;
    if (increment > 0) {
      for (let n = first; n <= last + 1e-10; n += increment) {
        if (iterations++ > maxIterations)
          break;
        results.push(precision > 0 ? n.toFixed(precision) : String(Math.round(n)));
      }
    } else {
      for (let n = first; n >= last - 1e-10; n += increment) {
        if (iterations++ > maxIterations)
          break;
        results.push(precision > 0 ? n.toFixed(precision) : String(Math.round(n)));
      }
    }
    if (equalizeWidth && results.length > 0) {
      const maxLen = Math.max(...results.map((r) => r.replace("-", "").length));
      for (let j = 0; j < results.length; j++) {
        const isNegative = results[j].startsWith("-");
        const num = isNegative ? results[j].slice(1) : results[j];
        const padded = num.padStart(maxLen, "0");
        results[j] = isNegative ? `-${padded}` : padded;
      }
    }
    const output = results.join(separator);
    return {
      stdout: output ? `${output}
` : "",
      stderr: "",
      exitCode: 0
    };
  }
};
export {
  seqCommand
};
