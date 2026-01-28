import {
  __name
} from "./chunk-Y7IWVHJ4.js";

// dist/commands/tac/tac.js
async function tacExecute(args, ctx) {
  if (args.length > 0 && args[0] !== "-") {
    const filePath = args[0].startsWith("/") ? args[0] : `${ctx.cwd}/${args[0]}`;
    try {
      const content = await ctx.fs.readFile(filePath);
      const lines2 = content.split("\n");
      if (lines2[lines2.length - 1] === "") {
        lines2.pop();
      }
      const reversed2 = lines2.reverse();
      return {
        stdout: reversed2.length > 0 ? `${reversed2.join("\n")}
` : "",
        stderr: "",
        exitCode: 0
      };
    } catch {
      return {
        stdout: "",
        stderr: `tac: ${args[0]}: No such file or directory
`,
        exitCode: 1
      };
    }
  }
  const lines = ctx.stdin.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  const reversed = lines.reverse();
  return {
    stdout: reversed.length > 0 ? `${reversed.join("\n")}
` : "",
    stderr: "",
    exitCode: 0
  };
}
__name(tacExecute, "tacExecute");
var tac = {
  name: "tac",
  execute: tacExecute
};
export {
  tac
};
