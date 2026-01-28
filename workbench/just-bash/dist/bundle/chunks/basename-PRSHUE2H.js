import {
  hasHelpFlag,
  showHelp
} from "./chunk-HAN5425M.js";
import "./chunk-Y7IWVHJ4.js";

// dist/commands/basename/basename.js
var basenameHelp = {
  name: "basename",
  summary: "strip directory and suffix from filenames",
  usage: "basename NAME [SUFFIX]\nbasename OPTION... NAME...",
  options: [
    "-a, --multiple   support multiple arguments",
    "-s, --suffix=SUFFIX  remove a trailing SUFFIX",
    "    --help       display this help and exit"
  ]
};
var basenameCommand = {
  name: "basename",
  async execute(args, _ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(basenameHelp);
    }
    let multiple = false;
    let suffix = "";
    const names = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "-a" || arg === "--multiple") {
        multiple = true;
      } else if (arg === "-s" && i + 1 < args.length) {
        suffix = args[++i];
        multiple = true;
      } else if (arg.startsWith("--suffix=")) {
        suffix = arg.slice(9);
        multiple = true;
      } else if (!arg.startsWith("-")) {
        names.push(arg);
      }
    }
    if (names.length === 0) {
      return {
        stdout: "",
        stderr: "basename: missing operand\n",
        exitCode: 1
      };
    }
    if (!multiple && names.length >= 2) {
      suffix = names.pop() ?? "";
    }
    const results = [];
    for (const name of names) {
      const cleanName = name.replace(/\/+$/, "");
      let base = cleanName.split("/").pop() || cleanName;
      if (suffix && base.endsWith(suffix)) {
        base = base.slice(0, -suffix.length);
      }
      results.push(base);
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
  basenameCommand
};
