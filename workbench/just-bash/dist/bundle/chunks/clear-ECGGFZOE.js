import {
  hasHelpFlag,
  showHelp
} from "./chunk-HAN5425M.js";
import "./chunk-Y7IWVHJ4.js";

// dist/commands/clear/clear.js
var clearHelp = {
  name: "clear",
  summary: "clear the terminal screen",
  usage: "clear [OPTIONS]",
  options: ["    --help display this help and exit"]
};
var clearCommand = {
  name: "clear",
  async execute(args, _ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(clearHelp);
    }
    const clearSequence = "\x1B[2J\x1B[H";
    return { stdout: clearSequence, stderr: "", exitCode: 0 };
  }
};
export {
  clearCommand
};
