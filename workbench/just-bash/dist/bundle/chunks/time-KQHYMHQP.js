import {
  __name
} from "./chunk-Y7IWVHJ4.js";

// dist/commands/time/time.js
var timeCommand = {
  name: "time",
  async execute(args, ctx) {
    let format = "%e %M";
    let outputFile = null;
    let appendMode = false;
    let posixFormat = false;
    let i = 0;
    while (i < args.length) {
      const arg = args[i];
      if (arg === "-f" || arg === "--format") {
        i++;
        if (i >= args.length) {
          return {
            stdout: "",
            stderr: "time: missing argument to '-f'\n",
            exitCode: 1
          };
        }
        format = args[i];
        i++;
      } else if (arg === "-o" || arg === "--output") {
        i++;
        if (i >= args.length) {
          return {
            stdout: "",
            stderr: "time: missing argument to '-o'\n",
            exitCode: 1
          };
        }
        outputFile = args[i];
        i++;
      } else if (arg === "-a" || arg === "--append") {
        appendMode = true;
        i++;
      } else if (arg === "-v" || arg === "--verbose") {
        format = "Command being timed: %C\nElapsed (wall clock) time: %e seconds\nMaximum resident set size (kbytes): %M";
        i++;
      } else if (arg === "-p" || arg === "--portability") {
        posixFormat = true;
        i++;
      } else if (arg === "--") {
        i++;
        break;
      } else if (arg.startsWith("-")) {
        i++;
      } else {
        break;
      }
    }
    const commandArgs = args.slice(i);
    if (commandArgs.length === 0) {
      return {
        stdout: "",
        stderr: "",
        exitCode: 0
      };
    }
    const startTime = performance.now();
    const commandString = commandArgs.join(" ");
    let result;
    try {
      if (!ctx.exec) {
        return {
          stdout: "",
          stderr: "time: exec not available\n",
          exitCode: 1
        };
      }
      result = await ctx.exec(commandString, { env: ctx.env, cwd: ctx.cwd });
    } catch (error) {
      result = {
        stdout: "",
        stderr: `time: ${error.message}
`,
        exitCode: 127
      };
    }
    const endTime = performance.now();
    const elapsedSeconds = (endTime - startTime) / 1e3;
    let timingOutput;
    if (posixFormat) {
      timingOutput = `real ${elapsedSeconds.toFixed(2)}
user 0.00
sys 0.00
`;
    } else {
      timingOutput = format.replace(/%e/g, elapsedSeconds.toFixed(2)).replace(/%E/g, formatElapsedTime(elapsedSeconds)).replace(/%M/g, "0").replace(/%S/g, "0.00").replace(/%U/g, "0.00").replace(/%P/g, "0%").replace(/%C/g, commandString);
      if (!timingOutput.endsWith("\n")) {
        timingOutput += "\n";
      }
    }
    if (outputFile) {
      try {
        const filePath = ctx.fs.resolvePath(ctx.cwd, outputFile);
        if (appendMode && await ctx.fs.exists(filePath)) {
          const existing = await ctx.fs.readFile(filePath);
          await ctx.fs.writeFile(filePath, existing + timingOutput);
        } else {
          await ctx.fs.writeFile(filePath, timingOutput);
        }
      } catch (error) {
        return {
          stdout: result.stdout,
          stderr: result.stderr + `time: cannot write to '${outputFile}': ${error.message}
`,
          exitCode: result.exitCode
        };
      }
    } else {
      result = {
        ...result,
        stderr: result.stderr + timingOutput
      };
    }
    return result;
  }
};
function formatElapsedTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const secs = seconds % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${secs.toFixed(2).padStart(5, "0")}`;
  }
  return `${minutes}:${secs.toFixed(2).padStart(5, "0")}`;
}
__name(formatElapsedTime, "formatElapsedTime");
export {
  timeCommand
};
