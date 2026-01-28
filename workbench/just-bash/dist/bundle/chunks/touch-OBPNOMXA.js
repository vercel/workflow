import {
  getErrorMessage
} from "./chunk-3EDCHFHY.js";
import {
  unknownOption
} from "./chunk-HAN5425M.js";
import {
  __name
} from "./chunk-Y7IWVHJ4.js";

// dist/commands/touch/touch.js
function parseDateString(dateStr) {
  const normalized = dateStr.replace(/\//g, "-");
  let date = new Date(normalized);
  if (!Number.isNaN(date.getTime())) {
    return date;
  }
  const dateMatch = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateMatch) {
    const [, year, month, day] = dateMatch;
    date = new Date(Number.parseInt(year, 10), Number.parseInt(month, 10) - 1, Number.parseInt(day, 10));
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }
  const dateTimeMatch = normalized.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (dateTimeMatch) {
    const [, year, month, day, hour, minute, second] = dateTimeMatch;
    date = new Date(Number.parseInt(year, 10), Number.parseInt(month, 10) - 1, Number.parseInt(day, 10), Number.parseInt(hour, 10), Number.parseInt(minute, 10), Number.parseInt(second, 10));
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }
  return null;
}
__name(parseDateString, "parseDateString");
var touchCommand = {
  name: "touch",
  async execute(args, ctx) {
    const files = [];
    let dateStr = null;
    let noCreate = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--") {
        files.push(...args.slice(i + 1));
        break;
      } else if (arg === "-d" || arg === "--date") {
        if (i + 1 >= args.length) {
          return {
            stdout: "",
            stderr: "touch: option requires an argument -- 'd'\n",
            exitCode: 1
          };
        }
        dateStr = args[++i];
      } else if (arg.startsWith("--date=")) {
        dateStr = arg.slice("--date=".length);
      } else if (arg === "-c" || arg === "--no-create") {
        noCreate = true;
      } else if (arg === "-a" || arg === "-m" || arg === "-r" || arg === "-t") {
        if (arg === "-r" || arg === "-t") {
          i++;
        }
      } else if (arg.startsWith("--")) {
        return unknownOption("touch", arg);
      } else if (arg.startsWith("-") && arg.length > 1) {
        let skipNext = false;
        for (const char of arg.slice(1)) {
          if (char === "c") {
            noCreate = true;
          } else if (char === "a" || char === "m") {
          } else if (char === "d") {
            if (i + 1 >= args.length) {
              return {
                stdout: "",
                stderr: "touch: option requires an argument -- 'd'\n",
                exitCode: 1
              };
            }
            dateStr = args[++i];
            skipNext = true;
            break;
          } else if (char === "r" || char === "t") {
            i++;
            skipNext = true;
            break;
          } else {
            return unknownOption("touch", `-${char}`);
          }
        }
        if (skipNext)
          continue;
      } else {
        files.push(arg);
      }
    }
    if (files.length === 0) {
      return {
        stdout: "",
        stderr: "touch: missing file operand\n",
        exitCode: 1
      };
    }
    let targetTime = null;
    if (dateStr !== null) {
      targetTime = parseDateString(dateStr);
      if (targetTime === null) {
        return {
          stdout: "",
          stderr: `touch: invalid date format '${dateStr}'
`,
          exitCode: 1
        };
      }
    }
    let stderr = "";
    let exitCode = 0;
    for (const file of files) {
      try {
        const fullPath = ctx.fs.resolvePath(ctx.cwd, file);
        const exists = await ctx.fs.exists(fullPath);
        if (!exists) {
          if (noCreate) {
            continue;
          }
          await ctx.fs.writeFile(fullPath, "");
        }
        const mtime = targetTime ?? /* @__PURE__ */ new Date();
        await ctx.fs.utimes(fullPath, mtime, mtime);
      } catch (error) {
        stderr += `touch: cannot touch '${file}': ${getErrorMessage(error)}
`;
        exitCode = 1;
      }
    }
    return { stdout: "", stderr, exitCode };
  }
};
export {
  touchCommand
};
