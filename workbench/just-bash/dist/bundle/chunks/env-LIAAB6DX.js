import {
  hasHelpFlag,
  showHelp,
  unknownOption
} from "./chunk-HAN5425M.js";
import "./chunk-Y7IWVHJ4.js";

// dist/commands/env/env.js
var envHelp = {
  name: "env",
  summary: "run a program in a modified environment",
  usage: "env [OPTION]... [NAME=VALUE]... [COMMAND [ARG]...]",
  options: [
    "-i, --ignore-environment  start with an empty environment",
    "-u NAME, --unset=NAME     remove NAME from the environment",
    "    --help                display this help and exit"
  ]
};
var envCommand = {
  name: "env",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(envHelp);
    }
    let ignoreEnv = false;
    const unsetVars = [];
    const setVars = {};
    let commandStart = -1;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "-i" || arg === "--ignore-environment") {
        ignoreEnv = true;
      } else if (arg === "-u" && i + 1 < args.length) {
        unsetVars.push(args[++i]);
      } else if (arg.startsWith("-u")) {
        unsetVars.push(arg.slice(2));
      } else if (arg.startsWith("--unset=")) {
        unsetVars.push(arg.slice(8));
      } else if (arg.startsWith("--") && arg !== "--") {
        return unknownOption("env", arg);
      } else if (arg.startsWith("-") && arg !== "-") {
        for (const c of arg.slice(1)) {
          if (c !== "i" && c !== "u") {
            return unknownOption("env", `-${c}`);
          }
        }
        if (arg.includes("i"))
          ignoreEnv = true;
      } else if (arg.includes("=") && commandStart === -1) {
        const eqIdx = arg.indexOf("=");
        const name = arg.slice(0, eqIdx);
        const value = arg.slice(eqIdx + 1);
        setVars[name] = value;
      } else {
        commandStart = i;
        break;
      }
    }
    let newEnv;
    if (ignoreEnv) {
      newEnv = { ...setVars };
    } else {
      newEnv = { ...ctx.env };
      for (const name of unsetVars) {
        delete newEnv[name];
      }
      Object.assign(newEnv, setVars);
    }
    if (commandStart === -1) {
      const lines = [];
      for (const [key, value] of Object.entries(newEnv)) {
        lines.push(`${key}=${value}`);
      }
      return {
        stdout: lines.join("\n") + (lines.length > 0 ? "\n" : ""),
        stderr: "",
        exitCode: 0
      };
    }
    if (!ctx.exec) {
      return {
        stdout: "",
        stderr: "env: command execution not supported in this context\n",
        exitCode: 1
      };
    }
    const cmdArgs = args.slice(commandStart);
    const cmdName = cmdArgs[0];
    const cmdRest = cmdArgs.slice(1);
    const quotedArgs = cmdRest.map((arg) => {
      if (/[\s"'\\$`!*?[\]{}|&;<>()]/.test(arg)) {
        return `'${arg.replace(/'/g, "'\\''")}'`;
      }
      return arg;
    });
    const command = [`command`, cmdName, ...quotedArgs].join(" ");
    const envPrefix = Object.entries(setVars).map(([k, v]) => `${k}="${v}"`).join(" ");
    const fullCommand = envPrefix ? `${envPrefix} ${command}` : command;
    return ctx.exec(fullCommand, { cwd: ctx.cwd });
  }
};
var printenvHelp = {
  name: "printenv",
  summary: "print all or part of environment",
  usage: "printenv [OPTION]... [VARIABLE]...",
  options: ["    --help       display this help and exit"]
};
var printenvCommand = {
  name: "printenv",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(printenvHelp);
    }
    const vars = args.filter((arg) => !arg.startsWith("-"));
    if (vars.length === 0) {
      const lines2 = [];
      for (const [key, value] of Object.entries(ctx.env)) {
        lines2.push(`${key}=${value}`);
      }
      return {
        stdout: lines2.join("\n") + (lines2.length > 0 ? "\n" : ""),
        stderr: "",
        exitCode: 0
      };
    }
    const lines = [];
    let exitCode = 0;
    for (const varName of vars) {
      if (varName in ctx.env) {
        lines.push(ctx.env[varName]);
      } else {
        exitCode = 1;
      }
    }
    return {
      stdout: lines.join("\n") + (lines.length > 0 ? "\n" : ""),
      stderr: "",
      exitCode
    };
  }
};
export {
  envCommand,
  printenvCommand
};
