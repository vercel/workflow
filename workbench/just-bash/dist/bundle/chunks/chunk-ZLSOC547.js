import {
  unknownOption
} from "./chunk-HAN5425M.js";
import {
  __name
} from "./chunk-Y7IWVHJ4.js";

// dist/commands/head/head-tail-shared.js
function parseHeadTailArgs(args, cmdName) {
  let lines = 10;
  let bytes = null;
  let quiet = false;
  let verbose = false;
  let fromLine = false;
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-n" && i + 1 < args.length) {
      const nextArg = args[++i];
      if (cmdName === "tail" && nextArg.startsWith("+")) {
        fromLine = true;
        lines = parseInt(nextArg.slice(1), 10);
      } else {
        lines = parseInt(nextArg, 10);
      }
    } else if (cmdName === "tail" && arg.startsWith("-n+")) {
      fromLine = true;
      lines = parseInt(arg.slice(3), 10);
    } else if (arg.startsWith("-n")) {
      lines = parseInt(arg.slice(2), 10);
    } else if (arg === "-c" && i + 1 < args.length) {
      bytes = parseInt(args[++i], 10);
    } else if (arg.startsWith("-c")) {
      bytes = parseInt(arg.slice(2), 10);
    } else if (arg.startsWith("--bytes=")) {
      bytes = parseInt(arg.slice(8), 10);
    } else if (arg.startsWith("--lines=")) {
      lines = parseInt(arg.slice(8), 10);
    } else if (arg === "-q" || arg === "--quiet" || arg === "--silent") {
      quiet = true;
    } else if (arg === "-v" || arg === "--verbose") {
      verbose = true;
    } else if (arg.match(/^-\d+$/)) {
      lines = parseInt(arg.slice(1), 10);
    } else if (arg.startsWith("--")) {
      return { ok: false, error: unknownOption(cmdName, arg) };
    } else if (arg.startsWith("-") && arg !== "-") {
      return { ok: false, error: unknownOption(cmdName, arg) };
    } else {
      files.push(arg);
    }
  }
  if (bytes !== null && (Number.isNaN(bytes) || bytes < 0)) {
    return {
      ok: false,
      error: {
        stdout: "",
        stderr: `${cmdName}: invalid number of bytes
`,
        exitCode: 1
      }
    };
  }
  if (Number.isNaN(lines) || lines < 0) {
    return {
      ok: false,
      error: {
        stdout: "",
        stderr: `${cmdName}: invalid number of lines
`,
        exitCode: 1
      }
    };
  }
  return {
    ok: true,
    options: { lines, bytes, quiet, verbose, files, fromLine }
  };
}
__name(parseHeadTailArgs, "parseHeadTailArgs");
async function processHeadTailFiles(ctx, options, cmdName, contentProcessor) {
  const { quiet, verbose, files } = options;
  if (files.length === 0) {
    return {
      stdout: contentProcessor(ctx.stdin),
      stderr: "",
      exitCode: 0
    };
  }
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  const showHeaders = verbose || !quiet && files.length > 1;
  let filesProcessed = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    try {
      const filePath = ctx.fs.resolvePath(ctx.cwd, file);
      const content = await ctx.fs.readFile(filePath);
      if (showHeaders) {
        if (filesProcessed > 0)
          stdout += "\n";
        stdout += `==> ${file} <==
`;
      }
      stdout += contentProcessor(content);
      filesProcessed++;
    } catch {
      stderr += `${cmdName}: ${file}: No such file or directory
`;
      exitCode = 1;
    }
  }
  return { stdout, stderr, exitCode };
}
__name(processHeadTailFiles, "processHeadTailFiles");
function getHead(content, lines, bytes) {
  if (bytes !== null) {
    return content.slice(0, bytes);
  }
  if (lines === 0)
    return "";
  let pos = 0;
  let lineCount = 0;
  const len = content.length;
  while (pos < len && lineCount < lines) {
    const nextNewline = content.indexOf("\n", pos);
    if (nextNewline === -1) {
      return `${content}
`;
    }
    lineCount++;
    pos = nextNewline + 1;
  }
  return pos > 0 ? content.slice(0, pos) : "";
}
__name(getHead, "getHead");
function getTail(content, lines, bytes, fromLine) {
  if (bytes !== null) {
    return content.slice(-bytes);
  }
  const len = content.length;
  if (len === 0)
    return "";
  if (fromLine) {
    let pos2 = 0;
    let lineCount2 = 1;
    while (pos2 < len && lineCount2 < lines) {
      const nextNewline = content.indexOf("\n", pos2);
      if (nextNewline === -1)
        break;
      lineCount2++;
      pos2 = nextNewline + 1;
    }
    const result2 = content.slice(pos2);
    return result2.endsWith("\n") ? result2 : `${result2}
`;
  }
  if (lines === 0)
    return "";
  let pos = len - 1;
  if (content[pos] === "\n")
    pos--;
  let lineCount = 0;
  while (pos >= 0 && lineCount < lines) {
    if (content[pos] === "\n") {
      lineCount++;
      if (lineCount === lines) {
        pos++;
        break;
      }
    }
    pos--;
  }
  if (pos < 0)
    pos = 0;
  const result = content.slice(pos);
  return content[len - 1] === "\n" ? result : `${result}
`;
}
__name(getTail, "getTail");

export {
  parseHeadTailArgs,
  processHeadTailFiles,
  getHead,
  getTail
};
