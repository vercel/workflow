import {
  hasHelpFlag,
  showHelp
} from "./chunk-HAN5425M.js";
import "./chunk-Y7IWVHJ4.js";

// dist/commands/alias/alias.js
var aliasHelp = {
  name: "alias",
  summary: "define or display aliases",
  usage: "alias [name[=value] ...]",
  options: ["    --help display this help and exit"]
};
var ALIAS_PREFIX = "BASH_ALIAS_";
var aliasCommand = {
  name: "alias",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(aliasHelp);
    }
    if (args.length === 0) {
      let stdout = "";
      for (const [key, value] of Object.entries(ctx.env)) {
        if (key.startsWith(ALIAS_PREFIX)) {
          const name = key.slice(ALIAS_PREFIX.length);
          stdout += `alias ${name}='${value}'
`;
        }
      }
      return { stdout, stderr: "", exitCode: 0 };
    }
    const processArgs = args[0] === "--" ? args.slice(1) : args;
    for (const arg of processArgs) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx === -1) {
        const key = ALIAS_PREFIX + arg;
        if (ctx.env[key]) {
          return {
            stdout: `alias ${arg}='${ctx.env[key]}'
`,
            stderr: "",
            exitCode: 0
          };
        } else {
          return {
            stdout: "",
            stderr: `alias: ${arg}: not found
`,
            exitCode: 1
          };
        }
      } else {
        const name = arg.slice(0, eqIdx);
        let value = arg.slice(eqIdx + 1);
        if (value.startsWith("'") && value.endsWith("'") || value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1);
        }
        ctx.env[ALIAS_PREFIX + name] = value;
      }
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  }
};
var unaliasCommand = {
  name: "unalias",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp({
        name: "unalias",
        summary: "remove alias definitions",
        usage: "unalias name [name ...]",
        options: [
          "-a      remove all aliases",
          "    --help display this help and exit"
        ]
      });
    }
    if (args.length === 0) {
      return {
        stdout: "",
        stderr: "unalias: usage: unalias [-a] name [name ...]\n",
        exitCode: 1
      };
    }
    if (args[0] === "-a") {
      for (const key of Object.keys(ctx.env)) {
        if (key.startsWith(ALIAS_PREFIX)) {
          delete ctx.env[key];
        }
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    const processArgs = args[0] === "--" ? args.slice(1) : args;
    let anyError = false;
    let stderr = "";
    for (const name of processArgs) {
      const key = ALIAS_PREFIX + name;
      if (ctx.env[key]) {
        delete ctx.env[key];
      } else {
        stderr += `unalias: ${name}: not found
`;
        anyError = true;
      }
    }
    return { stdout: "", stderr, exitCode: anyError ? 1 : 0 };
  }
};
export {
  aliasCommand,
  unaliasCommand
};
