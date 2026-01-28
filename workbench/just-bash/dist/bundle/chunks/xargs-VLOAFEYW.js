import {
  hasHelpFlag,
  showHelp,
  unknownOption
} from "./chunk-HAN5425M.js";
import {
  __name
} from "./chunk-Y7IWVHJ4.js";

// dist/commands/xargs/xargs.js
var xargsHelp = {
  name: "xargs",
  summary: "build and execute command lines from standard input",
  usage: "xargs [OPTION]... [COMMAND [INITIAL-ARGS]]",
  options: [
    "-I REPLACE   replace occurrences of REPLACE with input",
    "-d DELIM     use DELIM as input delimiter (e.g., -d '\\n' for newline)",
    "-n NUM       use at most NUM arguments per command line",
    "-P NUM       run at most NUM processes at a time",
    "-0, --null   items are separated by null, not whitespace",
    "-t, --verbose  print commands before executing",
    "-r, --no-run-if-empty  do not run command if input is empty",
    "    --help   display this help and exit"
  ]
};
var xargsCommand = {
  name: "xargs",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(xargsHelp);
    }
    let replaceStr = null;
    let delimiter = null;
    let maxArgs = null;
    let maxProcs = null;
    let nullSeparator = false;
    let verbose = false;
    let noRunIfEmpty = false;
    let commandStart = 0;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "-I" && i + 1 < args.length) {
        replaceStr = args[++i];
        commandStart = i + 1;
      } else if (arg === "-d" && i + 1 < args.length) {
        const delimArg = args[++i];
        delimiter = delimArg.replace(/\\n/g, "\n").replace(/\\t/g, "	").replace(/\\r/g, "\r").replace(/\\0/g, "\0").replace(/\\\\/g, "\\");
        commandStart = i + 1;
      } else if (arg === "-n" && i + 1 < args.length) {
        maxArgs = parseInt(args[++i], 10);
        commandStart = i + 1;
      } else if (arg === "-P" && i + 1 < args.length) {
        maxProcs = parseInt(args[++i], 10);
        commandStart = i + 1;
      } else if (arg === "-0" || arg === "--null") {
        nullSeparator = true;
        commandStart = i + 1;
      } else if (arg === "-t" || arg === "--verbose") {
        verbose = true;
        commandStart = i + 1;
      } else if (arg === "-r" || arg === "--no-run-if-empty") {
        noRunIfEmpty = true;
        commandStart = i + 1;
      } else if (arg.startsWith("--")) {
        return unknownOption("xargs", arg);
      } else if (arg.startsWith("-") && arg.length > 1) {
        for (const c of arg.slice(1)) {
          if (!"0tr".includes(c)) {
            return unknownOption("xargs", `-${c}`);
          }
        }
        if (arg.includes("0"))
          nullSeparator = true;
        if (arg.includes("t"))
          verbose = true;
        if (arg.includes("r"))
          noRunIfEmpty = true;
        commandStart = i + 1;
      } else if (!arg.startsWith("-")) {
        commandStart = i;
        break;
      }
    }
    const command = args.slice(commandStart);
    if (command.length === 0) {
      command.push("echo");
    }
    let items;
    if (nullSeparator) {
      items = ctx.stdin.split("\0").filter((s) => s.length > 0);
    } else if (delimiter !== null) {
      const input = ctx.stdin.replace(/\n$/, "");
      items = input.split(delimiter).filter((s) => s.length > 0);
    } else {
      items = ctx.stdin.split(/\s+/).map((s) => s.trim()).filter((s) => s.length > 0);
    }
    if (items.length === 0) {
      if (noRunIfEmpty) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    const quoteArg = /* @__PURE__ */ __name((arg) => {
      if (/[\s"'\\$`!*?[\]{}();&|<>#]/.test(arg)) {
        return `"${arg.replace(/([\\"`$])/g, "\\$1")}"`;
      }
      return arg;
    }, "quoteArg");
    const executeCommand = /* @__PURE__ */ __name(async (cmdArgs) => {
      const cmdLine = cmdArgs.map(quoteArg).join(" ");
      if (verbose) {
        stderr += `${cmdLine}
`;
      }
      if (ctx.exec) {
        return ctx.exec(cmdLine, { cwd: ctx.cwd });
      }
      return { stdout: `${cmdLine}
`, stderr: "", exitCode: 0 };
    }, "executeCommand");
    const runCommands = /* @__PURE__ */ __name(async (cmdArgsList) => {
      if (maxProcs !== null && maxProcs > 1) {
        for (let i = 0; i < cmdArgsList.length; i += maxProcs) {
          const batch = cmdArgsList.slice(i, i + maxProcs);
          const results = await Promise.all(batch.map(executeCommand));
          for (const result of results) {
            stdout += result.stdout;
            stderr += result.stderr;
            if (result.exitCode !== 0) {
              exitCode = result.exitCode;
            }
          }
        }
      } else {
        for (const cmdArgs of cmdArgsList) {
          const result = await executeCommand(cmdArgs);
          stdout += result.stdout;
          stderr += result.stderr;
          if (result.exitCode !== 0) {
            exitCode = result.exitCode;
          }
        }
      }
    }, "runCommands");
    if (replaceStr !== null) {
      const cmdArgsList = items.map((item) => command.map((c) => c.replaceAll(replaceStr, item)));
      await runCommands(cmdArgsList);
    } else if (maxArgs !== null) {
      const cmdArgsList = [];
      for (let i = 0; i < items.length; i += maxArgs) {
        const batch = items.slice(i, i + maxArgs);
        cmdArgsList.push([...command, ...batch]);
      }
      await runCommands(cmdArgsList);
    } else {
      const cmdArgs = [...command, ...items];
      const result = await executeCommand(cmdArgs);
      stdout += result.stdout;
      stderr += result.stderr;
      exitCode = result.exitCode;
    }
    return { stdout, stderr, exitCode };
  }
};
export {
  xargsCommand
};
