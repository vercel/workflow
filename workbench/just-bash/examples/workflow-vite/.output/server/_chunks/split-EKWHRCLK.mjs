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
var splitHelp = {
  name: "split",
  summary: "split a file into pieces",
  usage: "split [OPTION]... [FILE [PREFIX]]",
  description: "Output pieces of FILE to PREFIXaa, PREFIXab, ...; default size is 1000 lines, and default PREFIX is 'x'.",
  options: [
    "-l N         Put N lines per output file",
    "-b SIZE      Put SIZE bytes per output file (K, M, G suffixes)",
    "-n CHUNKS    Split into CHUNKS equal-sized files",
    "-d           Use numeric suffixes (00, 01, ...) instead of alphabetic",
    "-a LENGTH    Use suffixes of length LENGTH (default: 2)",
    "--additional-suffix=SUFFIX  Append SUFFIX to file names"
  ],
  examples: [
    "split -l 100 file.txt        # Split into 100-line chunks",
    "split -b 1M file.bin         # Split into 1MB chunks",
    "split -n 5 file.txt          # Split into 5 equal parts",
    "split -d file.txt part_      # part_00, part_01, ...",
    "split -a 3 -d file.txt x     # x000, x001, ..."
  ]
};
function parseSize(sizeStr) {
  const match = sizeStr.match(/^(\d+)([KMGTPEZY]?)([B]?)$/i);
  if (!match) {
    return null;
  }
  const num = Number.parseInt(match[1], 10);
  if (Number.isNaN(num) || num < 1) {
    return null;
  }
  const suffix = (match[2] || "").toUpperCase();
  const multipliers = {
    "": 1,
    K: 1024,
    M: 1024 * 1024,
    G: 1024 * 1024 * 1024,
    T: 1024 * 1024 * 1024 * 1024,
    P: 1024 * 1024 * 1024 * 1024 * 1024
  };
  const multiplier = multipliers[suffix];
  if (multiplier === void 0) {
    return null;
  }
  return num * multiplier;
}
__name(parseSize, "parseSize");
function generateSuffix(index, useNumeric, length) {
  if (useNumeric) {
    return index.toString().padStart(length, "0");
  }
  const chars = "abcdefghijklmnopqrstuvwxyz";
  let suffix = "";
  let remaining = index;
  for (let i = 0; i < length; i++) {
    suffix = chars[remaining % 26] + suffix;
    remaining = Math.floor(remaining / 26);
  }
  return suffix;
}
__name(generateSuffix, "generateSuffix");
function splitByLines(content, linesPerFile) {
  const lines = content.split("\n");
  const hasTrailingNewline = content.endsWith("\n") && lines[lines.length - 1] === "";
  if (hasTrailingNewline) {
    lines.pop();
  }
  const chunks = [];
  for (let i = 0; i < lines.length; i += linesPerFile) {
    const chunkLines = lines.slice(i, i + linesPerFile);
    const isLastChunk = i + linesPerFile >= lines.length;
    const chunkContent = isLastChunk && !hasTrailingNewline ? chunkLines.join("\n") : `${chunkLines.join("\n")}
`;
    chunks.push({ content: chunkContent, hasContent: true });
  }
  return chunks;
}
__name(splitByLines, "splitByLines");
function splitByBytes(content, bytesPerFile) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(content);
  const decoder = new TextDecoder();
  const chunks = [];
  for (let i = 0; i < bytes.length; i += bytesPerFile) {
    const chunkBytes = bytes.slice(i, i + bytesPerFile);
    chunks.push({
      content: decoder.decode(chunkBytes),
      hasContent: chunkBytes.length > 0
    });
  }
  return chunks;
}
__name(splitByBytes, "splitByBytes");
function splitIntoChunks(content, numChunks) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(content);
  const decoder = new TextDecoder();
  const chunks = [];
  const bytesPerChunk = Math.ceil(bytes.length / numChunks);
  for (let i = 0; i < numChunks; i++) {
    const start = i * bytesPerChunk;
    const end = Math.min(start + bytesPerChunk, bytes.length);
    const chunkBytes = bytes.slice(start, end);
    chunks.push({
      content: decoder.decode(chunkBytes),
      hasContent: chunkBytes.length > 0
    });
  }
  return chunks;
}
__name(splitIntoChunks, "splitIntoChunks");
var split = {
  name: "split",
  execute: /* @__PURE__ */ __name(async (args, ctx) => {
    if (hasHelpFlag(args)) {
      return showHelp(splitHelp);
    }
    const options = {
      mode: "lines",
      lines: 1e3,
      bytes: 0,
      chunks: 0,
      useNumericSuffix: false,
      suffixLength: 2,
      additionalSuffix: ""
    };
    const positionalArgs = [];
    let i = 0;
    while (i < args.length) {
      const arg = args[i];
      if (arg === "-l" && i + 1 < args.length) {
        const lines = Number.parseInt(args[i + 1], 10);
        if (Number.isNaN(lines) || lines < 1) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `split: invalid number of lines: '${args[i + 1]}'
`
          };
        }
        options.mode = "lines";
        options.lines = lines;
        i += 2;
      } else if (arg.match(/^-l\d+$/)) {
        const lines = Number.parseInt(arg.slice(2), 10);
        if (Number.isNaN(lines) || lines < 1) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `split: invalid number of lines: '${arg.slice(2)}'
`
          };
        }
        options.mode = "lines";
        options.lines = lines;
        i++;
      } else if (arg === "-b" && i + 1 < args.length) {
        const bytes = parseSize(args[i + 1]);
        if (bytes === null) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `split: invalid number of bytes: '${args[i + 1]}'
`
          };
        }
        options.mode = "bytes";
        options.bytes = bytes;
        i += 2;
      } else if (arg.match(/^-b.+$/)) {
        const bytes = parseSize(arg.slice(2));
        if (bytes === null) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `split: invalid number of bytes: '${arg.slice(2)}'
`
          };
        }
        options.mode = "bytes";
        options.bytes = bytes;
        i++;
      } else if (arg === "-n" && i + 1 < args.length) {
        const chunks2 = Number.parseInt(args[i + 1], 10);
        if (Number.isNaN(chunks2) || chunks2 < 1) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `split: invalid number of chunks: '${args[i + 1]}'
`
          };
        }
        options.mode = "chunks";
        options.chunks = chunks2;
        i += 2;
      } else if (arg.match(/^-n\d+$/)) {
        const chunks2 = Number.parseInt(arg.slice(2), 10);
        if (Number.isNaN(chunks2) || chunks2 < 1) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `split: invalid number of chunks: '${arg.slice(2)}'
`
          };
        }
        options.mode = "chunks";
        options.chunks = chunks2;
        i++;
      } else if (arg === "-a" && i + 1 < args.length) {
        const len = Number.parseInt(args[i + 1], 10);
        if (Number.isNaN(len) || len < 1) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `split: invalid suffix length: '${args[i + 1]}'
`
          };
        }
        options.suffixLength = len;
        i += 2;
      } else if (arg.match(/^-a\d+$/)) {
        const len = Number.parseInt(arg.slice(2), 10);
        if (Number.isNaN(len) || len < 1) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `split: invalid suffix length: '${arg.slice(2)}'
`
          };
        }
        options.suffixLength = len;
        i++;
      } else if (arg === "-d" || arg === "--numeric-suffixes") {
        options.useNumericSuffix = true;
        i++;
      } else if (arg.startsWith("--additional-suffix=")) {
        options.additionalSuffix = arg.slice("--additional-suffix=".length);
        i++;
      } else if (arg === "--additional-suffix" && i + 1 < args.length) {
        options.additionalSuffix = args[i + 1];
        i += 2;
      } else if (arg === "--") {
        positionalArgs.push(...args.slice(i + 1));
        break;
      } else if (arg.startsWith("-") && arg !== "-") {
        return unknownOption("split", arg);
      } else {
        positionalArgs.push(arg);
        i++;
      }
    }
    let inputFile = "-";
    let prefix = "x";
    if (positionalArgs.length >= 1) {
      inputFile = positionalArgs[0];
    }
    if (positionalArgs.length >= 2) {
      prefix = positionalArgs[1];
    }
    let content;
    if (inputFile === "-") {
      content = ctx.stdin ?? "";
    } else {
      const filePath = ctx.fs.resolvePath(ctx.cwd, inputFile);
      const fileContent = await ctx.fs.readFile(filePath);
      if (fileContent === null) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `split: ${inputFile}: No such file or directory
`
        };
      }
      content = fileContent;
    }
    if (content === "") {
      return {
        exitCode: 0,
        stdout: "",
        stderr: ""
      };
    }
    let chunks;
    switch (options.mode) {
      case "lines":
        chunks = splitByLines(content, options.lines);
        break;
      case "bytes":
        chunks = splitByBytes(content, options.bytes);
        break;
      case "chunks":
        chunks = splitIntoChunks(content, options.chunks);
        break;
      default: {
        const _exhaustive = options.mode;
        return _exhaustive;
      }
    }
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const chunk = chunks[chunkIndex];
      if (!chunk.hasContent)
        continue;
      const suffix = generateSuffix(chunkIndex, options.useNumericSuffix, options.suffixLength);
      const filename = `${prefix}${suffix}${options.additionalSuffix}`;
      const filePath = ctx.fs.resolvePath(ctx.cwd, filename);
      await ctx.fs.writeFile(filePath, chunk.content);
    }
    return {
      exitCode: 0,
      stdout: "",
      stderr: ""
    };
  }, "execute")
};
export {
  split
};
