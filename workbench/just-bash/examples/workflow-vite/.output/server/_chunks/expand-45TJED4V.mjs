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
var expandHelp = {
  name: "expand",
  summary: "convert tabs to spaces",
  usage: "expand [OPTION]... [FILE]...",
  description: "Convert TABs in each FILE to spaces, writing to standard output. If no FILE is specified, standard input is read.",
  options: [
    "-t N        Use N spaces per tab (default: 8)",
    "-t LIST     Use comma-separated list of tab stops",
    "-i          Only convert leading tabs on each line"
  ],
  examples: [
    "expand file.txt             # Convert all tabs to 8 spaces",
    "expand -t 4 file.txt        # Use 4-space tabs",
    "expand -t 4,8,12 file.txt   # Custom tab stops"
  ]
};
function parseTabStops(spec) {
  const parts = spec.split(",").map((s) => s.trim());
  const stops = [];
  for (const part of parts) {
    const num = parseInt(part, 10);
    if (Number.isNaN(num) || num < 1) {
      return null;
    }
    stops.push(num);
  }
  for (let i = 1; i < stops.length; i++) {
    if (stops[i] <= stops[i - 1]) {
      return null;
    }
  }
  return stops;
}
__name(parseTabStops, "parseTabStops");
function getTabWidth(column, tabStops) {
  if (tabStops.length === 1) {
    const tabWidth = tabStops[0];
    return tabWidth - column % tabWidth;
  }
  for (const stop of tabStops) {
    if (stop > column) {
      return stop - column;
    }
  }
  if (tabStops.length >= 2) {
    const lastInterval = tabStops[tabStops.length - 1] - tabStops[tabStops.length - 2];
    const lastStop = tabStops[tabStops.length - 1];
    const stopsAfterLast = Math.floor((column - lastStop) / lastInterval) + 1;
    const nextStop = lastStop + stopsAfterLast * lastInterval;
    return nextStop - column;
  }
  return 1;
}
__name(getTabWidth, "getTabWidth");
function expandLine(line, options) {
  const { tabStops, leadingOnly } = options;
  let result = "";
  let column = 0;
  let inLeadingWhitespace = true;
  for (const char of line) {
    if (char === "	") {
      if (leadingOnly && !inLeadingWhitespace) {
        result += char;
        column++;
      } else {
        const spaces = getTabWidth(column, tabStops);
        result += " ".repeat(spaces);
        column += spaces;
      }
    } else {
      if (char !== " " && char !== "	") {
        inLeadingWhitespace = false;
      }
      result += char;
      column++;
    }
  }
  return result;
}
__name(expandLine, "expandLine");
function processContent(content, options) {
  if (content === "") {
    return "";
  }
  const lines = content.split("\n");
  const hasTrailingNewline = content.endsWith("\n") && lines[lines.length - 1] === "";
  if (hasTrailingNewline) {
    lines.pop();
  }
  const expandedLines = lines.map((line) => expandLine(line, options));
  return expandedLines.join("\n") + (hasTrailingNewline ? "\n" : "");
}
__name(processContent, "processContent");
var expand = {
  name: "expand",
  execute: /* @__PURE__ */ __name(async (args, ctx) => {
    if (hasHelpFlag(args)) {
      return showHelp(expandHelp);
    }
    const options = {
      tabStops: [8],
      leadingOnly: false
    };
    const files = [];
    let i = 0;
    while (i < args.length) {
      const arg = args[i];
      if (arg === "-t" && i + 1 < args.length) {
        const stops = parseTabStops(args[i + 1]);
        if (!stops) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `expand: invalid tab size: '${args[i + 1]}'
`
          };
        }
        options.tabStops = stops;
        i += 2;
      } else if (arg.startsWith("-t") && arg.length > 2) {
        const stops = parseTabStops(arg.slice(2));
        if (!stops) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `expand: invalid tab size: '${arg.slice(2)}'
`
          };
        }
        options.tabStops = stops;
        i++;
      } else if (arg === "--tabs" && i + 1 < args.length) {
        const stops = parseTabStops(args[i + 1]);
        if (!stops) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `expand: invalid tab size: '${args[i + 1]}'
`
          };
        }
        options.tabStops = stops;
        i += 2;
      } else if (arg.startsWith("--tabs=")) {
        const stops = parseTabStops(arg.slice(7));
        if (!stops) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `expand: invalid tab size: '${arg.slice(7)}'
`
          };
        }
        options.tabStops = stops;
        i++;
      } else if (arg === "-i" || arg === "--initial") {
        options.leadingOnly = true;
        i++;
      } else if (arg === "--") {
        files.push(...args.slice(i + 1));
        break;
      } else if (arg.startsWith("-") && arg !== "-") {
        return unknownOption("expand", arg);
      } else {
        files.push(arg);
        i++;
      }
    }
    let output = "";
    if (files.length === 0) {
      const input = ctx.stdin ?? "";
      output = processContent(input, options);
    } else {
      for (const file of files) {
        const filePath = ctx.fs.resolvePath(ctx.cwd, file);
        const content = await ctx.fs.readFile(filePath);
        if (content === null) {
          return {
            exitCode: 1,
            stdout: output,
            stderr: `expand: ${file}: No such file or directory
`
          };
        }
        output += processContent(content, options);
      }
    }
    return {
      exitCode: 0,
      stdout: output,
      stderr: ""
    };
  }, "execute")
};
export {
  expand
};
