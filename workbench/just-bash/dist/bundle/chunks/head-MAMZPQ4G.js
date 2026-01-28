import {
  getHead,
  parseHeadTailArgs,
  processHeadTailFiles
} from "./chunk-ZLSOC547.js";
import {
  hasHelpFlag,
  showHelp
} from "./chunk-HAN5425M.js";
import "./chunk-Y7IWVHJ4.js";

// dist/commands/head/head.js
var headHelp = {
  name: "head",
  summary: "output the first part of files",
  usage: "head [OPTION]... [FILE]...",
  options: [
    "-c, --bytes=NUM    print the first NUM bytes",
    "-n, --lines=NUM    print the first NUM lines (default 10)",
    "-q, --quiet        never print headers giving file names",
    "-v, --verbose      always print headers giving file names",
    "    --help         display this help and exit"
  ]
};
var headCommand = {
  name: "head",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(headHelp);
    }
    const parsed = parseHeadTailArgs(args, "head");
    if (!parsed.ok) {
      return parsed.error;
    }
    const { lines, bytes } = parsed.options;
    return processHeadTailFiles(ctx, parsed.options, "head", (content) => getHead(content, lines, bytes));
  }
};
export {
  headCommand
};
