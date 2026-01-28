import {
  hasHelpFlag,
  showHelp
} from "./chunk-HAN5425M.js";
import {
  __name
} from "./chunk-Y7IWVHJ4.js";

// dist/commands/sleep/sleep.js
var sleepHelp = {
  name: "sleep",
  summary: "delay for a specified amount of time",
  usage: "sleep NUMBER[SUFFIX]",
  description: `Pause for NUMBER seconds. SUFFIX may be:
  s - seconds (default)
  m - minutes
  h - hours
  d - days

NUMBER may be a decimal number.`,
  options: ["    --help display this help and exit"]
};
function parseDuration(arg) {
  const match = arg.match(/^(\d+\.?\d*)(s|m|h|d)?$/);
  if (!match)
    return null;
  const value = parseFloat(match[1]);
  const suffix = match[2] || "s";
  switch (suffix) {
    case "s":
      return value * 1e3;
    case "m":
      return value * 60 * 1e3;
    case "h":
      return value * 60 * 60 * 1e3;
    case "d":
      return value * 24 * 60 * 60 * 1e3;
    default:
      return null;
  }
}
__name(parseDuration, "parseDuration");
var sleepCommand = {
  name: "sleep",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(sleepHelp);
    }
    if (args.length === 0) {
      return {
        stdout: "",
        stderr: "sleep: missing operand\n",
        exitCode: 1
      };
    }
    let totalMs = 0;
    for (const arg of args) {
      const ms = parseDuration(arg);
      if (ms === null) {
        return {
          stdout: "",
          stderr: `sleep: invalid time interval '${arg}'
`,
          exitCode: 1
        };
      }
      totalMs += ms;
    }
    if (ctx.sleep) {
      await ctx.sleep(totalMs);
    } else {
      await new Promise((resolve) => setTimeout(resolve, totalMs));
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  }
};
export {
  sleepCommand
};
