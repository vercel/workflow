import {
  hasHelpFlag,
  showHelp
} from "./chunk-HAN5425M.js";
import "./chunk-Y7IWVHJ4.js";

// dist/commands/history/history.js
var historyHelp = {
  name: "history",
  summary: "display command history",
  usage: "history [n]",
  options: [
    "-c      clear the history list",
    "    --help display this help and exit"
  ]
};
var HISTORY_KEY = "BASH_HISTORY";
var historyCommand = {
  name: "history",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(historyHelp);
    }
    const historyStr = ctx.env[HISTORY_KEY] || "[]";
    let history;
    try {
      history = JSON.parse(historyStr);
    } catch {
      history = [];
    }
    if (args[0] === "-c") {
      ctx.env[HISTORY_KEY] = "[]";
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    let count = history.length;
    if (args[0] && /^\d+$/.test(args[0])) {
      count = Math.min(parseInt(args[0], 10), history.length);
    }
    const start = history.length - count;
    let stdout = "";
    for (let i = start; i < history.length; i++) {
      const lineNum = (i + 1).toString().padStart(5, " ");
      stdout += `${lineNum}  ${history[i]}
`;
    }
    return { stdout, stderr: "", exitCode: 0 };
  }
};
export {
  historyCommand
};
