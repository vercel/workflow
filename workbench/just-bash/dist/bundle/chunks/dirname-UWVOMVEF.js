import {
  hasHelpFlag,
  showHelp
} from "./chunk-HAN5425M.js";
import "./chunk-Y7IWVHJ4.js";

// dist/commands/dirname/dirname.js
var dirnameHelp = {
  name: "dirname",
  summary: "strip last component from file name",
  usage: "dirname [OPTION] NAME...",
  options: ["    --help       display this help and exit"]
};
var dirnameCommand = {
  name: "dirname",
  async execute(args, _ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(dirnameHelp);
    }
    const names = args.filter((arg) => !arg.startsWith("-"));
    if (names.length === 0) {
      return {
        stdout: "",
        stderr: "dirname: missing operand\n",
        exitCode: 1
      };
    }
    const results = [];
    for (const name of names) {
      const cleanName = name.replace(/\/+$/, "");
      const lastSlash = cleanName.lastIndexOf("/");
      if (lastSlash === -1) {
        results.push(".");
      } else if (lastSlash === 0) {
        results.push("/");
      } else {
        results.push(cleanName.slice(0, lastSlash));
      }
    }
    return {
      stdout: `${results.join("\n")}
`,
      stderr: "",
      exitCode: 0
    };
  }
};
export {
  dirnameCommand
};
