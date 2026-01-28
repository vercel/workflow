import { r as readFiles } from "./chunk-XTSQ6SVV.mjs";
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
var wcHelp = {
  name: "wc",
  summary: "print newline, word, and byte counts for each file",
  usage: "wc [OPTION]... [FILE]...",
  options: [
    "-c, --bytes      print the byte counts",
    "-m, --chars      print the character counts",
    "-l, --lines      print the newline counts",
    "-w, --words      print the word counts",
    "    --help       display this help and exit"
  ]
};
var argDefs = {
  lines: { short: "l", long: "lines", type: "boolean" },
  words: { short: "w", long: "words", type: "boolean" },
  bytes: { short: "c", long: "bytes", type: "boolean" },
  chars: { short: "m", long: "chars", type: "boolean" }
};
var wcCommand = {
  name: "wc",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(wcHelp);
    }
    const parsed = parseArgs("wc", args, argDefs);
    if (!parsed.ok)
      return parsed.error;
    let { lines: showLines, words: showWords } = parsed.result.flags;
    let showChars = parsed.result.flags.bytes || parsed.result.flags.chars;
    const files = parsed.result.positional;
    if (!showLines && !showWords && !showChars) {
      showLines = showWords = showChars = true;
    }
    const readResult = await readFiles(ctx, files, {
      cmdName: "wc",
      stopOnError: false
    });
    if (files.length === 0) {
      const stats = countStats(readResult.files[0].content);
      return {
        stdout: `${formatStats(stats, showLines, showWords, showChars, "", 0)}
`,
        stderr: "",
        exitCode: 0
      };
    }
    const allStats = [];
    let totalLines = 0;
    let totalWords = 0;
    let totalChars = 0;
    for (const { filename, content } of readResult.files) {
      const stats = countStats(content);
      totalLines += stats.lines;
      totalWords += stats.words;
      totalChars += stats.chars;
      allStats.push({ filename, stats });
    }
    const maxLines = files.length > 1 ? totalLines : Math.max(...allStats.map((s) => s.stats.lines));
    const maxWords = files.length > 1 ? totalWords : Math.max(...allStats.map((s) => s.stats.words));
    const maxChars = files.length > 1 ? totalChars : Math.max(...allStats.map((s) => s.stats.chars));
    let maxWidth = files.length > 1 ? 3 : 0;
    if (showLines)
      maxWidth = Math.max(maxWidth, String(maxLines).length);
    if (showWords)
      maxWidth = Math.max(maxWidth, String(maxWords).length);
    if (showChars)
      maxWidth = Math.max(maxWidth, String(maxChars).length);
    let stdout = "";
    for (const { filename, stats } of allStats) {
      stdout += `${formatStats(stats, showLines, showWords, showChars, filename, maxWidth)}
`;
    }
    if (files.length > 1) {
      stdout += `${formatStats({ lines: totalLines, words: totalWords, chars: totalChars }, showLines, showWords, showChars, "total", maxWidth)}
`;
    }
    return { stdout, stderr: readResult.stderr, exitCode: readResult.exitCode };
  }
};
function countStats(content) {
  const len = content.length;
  let lines = 0;
  let words = 0;
  let inWord = false;
  for (let i = 0; i < len; i++) {
    const c = content[i];
    if (c === "\n") {
      lines++;
      if (inWord) {
        words++;
        inWord = false;
      }
    } else if (c === " " || c === "	" || c === "\r") {
      if (inWord) {
        words++;
        inWord = false;
      }
    } else {
      inWord = true;
    }
  }
  if (inWord) {
    words++;
  }
  return { lines, words, chars: len };
}
__name(countStats, "countStats");
function formatStats(stats, showLines, showWords, showChars, filename, minWidth) {
  const values = [];
  if (showLines) {
    values.push(String(stats.lines).padStart(minWidth));
  }
  if (showWords) {
    values.push(String(stats.words).padStart(minWidth));
  }
  if (showChars) {
    values.push(String(stats.chars).padStart(minWidth));
  }
  let result = values.join(" ");
  if (filename) {
    result += ` ${filename}`;
  }
  return result;
}
__name(formatStats, "formatStats");
export {
  wcCommand
};
