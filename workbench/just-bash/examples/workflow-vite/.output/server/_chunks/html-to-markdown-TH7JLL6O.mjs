import { h as hasHelpFlag, s as showHelp, u as unknownOption } from "./chunk-HAN5425M.mjs";
import { T as TurndownService } from "../_libs/turndown.mjs";
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
var htmlToMarkdownHelp = {
  name: "html-to-markdown",
  summary: "convert HTML to Markdown (BashEnv extension)",
  usage: "html-to-markdown [OPTION]... [FILE]",
  description: [
    "Convert HTML content to Markdown format using the turndown library.",
    "This is a non-standard BashEnv extension command, not available in regular bash.",
    "",
    "Read HTML from FILE or standard input and output Markdown to standard output.",
    "Commonly used with curl to convert web pages:",
    "  curl -s https://example.com | html-to-markdown",
    "",
    "Supported HTML elements:",
    "  - Headings (h1-h6) → # Markdown headings",
    "  - Paragraphs (p) → Plain text with blank lines",
    "  - Links (a) → [text](url)",
    "  - Images (img) → ![alt](src)",
    "  - Bold/Strong → **text**",
    "  - Italic/Em → _text_",
    "  - Code (code, pre) → `inline` or fenced blocks",
    "  - Lists (ul, ol, li) → - or 1. items",
    "  - Blockquotes → > quoted text",
    "  - Horizontal rules (hr) → ---"
  ],
  options: [
    "-b, --bullet=CHAR     bullet character for unordered lists (-, +, or *)",
    "-c, --code=FENCE      fence style for code blocks (``` or ~~~)",
    "-r, --hr=STRING       string for horizontal rules (default: ---)",
    "    --heading-style=STYLE",
    "                      heading style: 'atx' for # headings (default),",
    "                      'setext' for underlined headings (h1/h2 only)",
    "    --help            display this help and exit"
  ],
  examples: [
    "echo '<h1>Hello</h1><p>World</p>' | html-to-markdown",
    "html-to-markdown page.html",
    "curl -s https://example.com | html-to-markdown > page.md"
  ]
};
var htmlToMarkdownCommand = {
  name: "html-to-markdown",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(htmlToMarkdownHelp);
    }
    let bullet = "-";
    let codeFence = "```";
    let hr = "---";
    let headingStyle = "atx";
    const files = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "-b" || arg === "--bullet") {
        bullet = args[++i] ?? "-";
      } else if (arg.startsWith("--bullet=")) {
        bullet = arg.slice(9);
      } else if (arg === "-c" || arg === "--code") {
        codeFence = args[++i] ?? "```";
      } else if (arg.startsWith("--code=")) {
        codeFence = arg.slice(7);
      } else if (arg === "-r" || arg === "--hr") {
        hr = args[++i] ?? "---";
      } else if (arg.startsWith("--hr=")) {
        hr = arg.slice(5);
      } else if (arg.startsWith("--heading-style=")) {
        const style = arg.slice(16);
        if (style === "setext" || style === "atx") {
          headingStyle = style;
        }
      } else if (arg === "-") {
        files.push("-");
      } else if (arg.startsWith("--")) {
        return unknownOption("html-to-markdown", arg);
      } else if (arg.startsWith("-")) {
        return unknownOption("html-to-markdown", arg);
      } else {
        files.push(arg);
      }
    }
    let input;
    if (files.length === 0 || files.length === 1 && files[0] === "-") {
      input = ctx.stdin;
    } else {
      try {
        const filePath = ctx.fs.resolvePath(ctx.cwd, files[0]);
        input = await ctx.fs.readFile(filePath);
      } catch {
        return {
          stdout: "",
          stderr: `html-to-markdown: ${files[0]}: No such file or directory
`,
          exitCode: 1
        };
      }
    }
    if (!input.trim()) {
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    try {
      const turndownService = new TurndownService({
        bulletListMarker: bullet,
        codeBlockStyle: "fenced",
        fence: codeFence,
        hr,
        headingStyle
      });
      turndownService.remove(["script", "style", "footer"]);
      const markdown = turndownService.turndown(input).trim();
      return {
        stdout: `${markdown}
`,
        stderr: "",
        exitCode: 0
      };
    } catch (error) {
      return {
        stdout: "",
        stderr: `html-to-markdown: conversion error: ${error.message}
`,
        exitCode: 1
      };
    }
  }
};
export {
  htmlToMarkdownCommand
};
