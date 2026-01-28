import {
  hasHelpFlag,
  showHelp,
  unknownOption
} from "./chunk-HAN5425M.js";
import "./chunk-Y7IWVHJ4.js";

// dist/commands/html-to-markdown/html-to-markdown.js
import TurndownService from "turndown";
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
    "  - Headings (h1-h6) \u2192 # Markdown headings",
    "  - Paragraphs (p) \u2192 Plain text with blank lines",
    "  - Links (a) \u2192 [text](url)",
    "  - Images (img) \u2192 ![alt](src)",
    "  - Bold/Strong \u2192 **text**",
    "  - Italic/Em \u2192 _text_",
    "  - Code (code, pre) \u2192 `inline` or fenced blocks",
    "  - Lists (ul, ol, li) \u2192 - or 1. items",
    "  - Blockquotes \u2192 > quoted text",
    "  - Horizontal rules (hr) \u2192 ---"
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
