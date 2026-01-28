import { _ as __name } from "../index.mjs";
import "./_libs/@vercel/functions.mjs";
import "../_libs/srvx.mjs";
import "node:http";
import "node:stream";
import "node:https";
import "node:http2";
import "../_libs/h3.mjs";
import "../_libs/rou3.mjs";
import "../_libs/ms.mjs";
import "./_libs/@mongodb-js/zstd.mjs";
import "util";
import "util/types";
import "../_libs/ulid.mjs";
import "node:crypto";
import "node:module";
import "node:path";
import "node:child_process";
import "node:fs/promises";
import "node:util";
import "node:url";
import "node:timers/promises";
import "./_libs/@vercel/queue.mjs";
import "../_libs/mixpart.mjs";
import "./_libs/@vercel/oidc.mjs";
import "path";
import "fs";
import "os";
import "./_libs/async-sema.mjs";
import "events";
import "./_libs/undici.mjs";
import "node:assert";
import "node:net";
import "node:buffer";
import "node:querystring";
import "node:events";
import "node:diagnostics_channel";
import "node:tls";
import "node:zlib";
import "node:perf_hooks";
import "node:util/types";
import "node:worker_threads";
import "node:async_hooks";
import "node:console";
import "node:dns";
import "string_decoder";
import "../_libs/zod.mjs";
import "node:fs";
import "node:os";
import "../_libs/cbor-x.mjs";
import "../_libs/devalue.mjs";
import "./_libs/debug.mjs";
import "tty";
import "../_libs/supports-color.mjs";
import "../_libs/has-flag.mjs";
import "./_libs/@jridgewell/trace-mapping.mjs";
import "./_libs/@jridgewell/sourcemap-codec.mjs";
import "./_libs/@jridgewell/resolve-uri.mjs";
import "node:vm";
import "../_libs/nanoid.mjs";
import "../_libs/seedrandom.mjs";
import "../_libs/ufo.mjs";
var CATEGORIES = {
  "File operations": [
    "ls",
    "cat",
    "head",
    "tail",
    "wc",
    "touch",
    "mkdir",
    "rm",
    "cp",
    "mv",
    "ln",
    "chmod",
    "stat",
    "readlink"
  ],
  "Text processing": [
    "grep",
    "sed",
    "awk",
    "sort",
    "uniq",
    "cut",
    "tr",
    "tee",
    "diff"
  ],
  Search: ["find"],
  "Navigation & paths": ["pwd", "basename", "dirname", "tree", "du"],
  "Environment & shell": [
    "echo",
    "printf",
    "env",
    "printenv",
    "export",
    "alias",
    "unalias",
    "history",
    "clear",
    "true",
    "false",
    "bash",
    "sh"
  ],
  "Data processing": ["xargs", "jq", "base64", "date"],
  Network: ["curl", "html-to-markdown"]
};
function formatHelp(commands) {
  const lines = [];
  const commandSet = new Set(commands);
  lines.push("Available commands:\n");
  const uncategorized = [];
  for (const [category, cmds] of Object.entries(CATEGORIES)) {
    const available = cmds.filter((c) => commandSet.has(c));
    if (available.length > 0) {
      lines.push(`  ${category}:`);
      lines.push(`    ${available.join(", ")}
`);
      for (const c of available) {
        commandSet.delete(c);
      }
    }
  }
  for (const cmd of commandSet) {
    uncategorized.push(cmd);
  }
  if (uncategorized.length > 0) {
    lines.push("  Other:");
    lines.push(`    ${uncategorized.sort().join(", ")}
`);
  }
  lines.push("Use '<command> --help' for details on a specific command.");
  return `${lines.join("\n")}
`;
}
__name(formatHelp, "formatHelp");
var helpCommand = {
  name: "help",
  async execute(args, ctx) {
    if (args.includes("--help") || args.includes("-h")) {
      return {
        stdout: `help - display available commands

Usage: help [command]

Options:
  -h, --help    Show this help message

If a command name is provided, shows help for that command.
Otherwise, lists all available commands.
`,
        stderr: "",
        exitCode: 0
      };
    }
    if (args.length > 0 && ctx.exec) {
      const cmdName = args[0];
      return ctx.exec(`${cmdName} --help`, { cwd: ctx.cwd });
    }
    const commands = ctx.getRegisteredCommands?.() ?? [];
    return {
      stdout: formatHelp(commands),
      stderr: "",
      exitCode: 0
    };
  }
};
export {
  helpCommand
};
