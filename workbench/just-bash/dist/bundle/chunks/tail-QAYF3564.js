import {
  getTail,
  parseHeadTailArgs,
  processHeadTailFiles
} from "./chunk-ZLSOC547.js";
import {
  hasHelpFlag,
  showHelp
} from "./chunk-HAN5425M.js";
import "./chunk-Y7IWVHJ4.js";

// dist/commands/tail/tail.js
var tailHelp = {
  name: "tail",
  summary: "output the last part of files",
  usage: "tail [OPTION]... [FILE]...",
  options: [
    "-c, --bytes=NUM    print the last NUM bytes",
    "-n, --lines=NUM    print the last NUM lines (default 10)",
    "-n +NUM            print starting from line NUM",
    "-q, --quiet        never print headers giving file names",
    "-v, --verbose      always print headers giving file names",
    "    --help         display this help and exit"
  ]
};
var tailCommand = {
  name: "tail",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(tailHelp);
    }
    const parsed = parseHeadTailArgs(args, "tail");
    if (!parsed.ok) {
      return parsed.error;
    }
    const { lines, bytes, fromLine } = parsed.options;
    return processHeadTailFiles(ctx, parsed.options, "tail", (content) => getTail(content, lines, bytes, fromLine ?? false));
  }
};
export {
  tailCommand
};
