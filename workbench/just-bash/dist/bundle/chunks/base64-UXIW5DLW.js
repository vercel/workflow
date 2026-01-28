import {
  parseArgs
} from "./chunk-5NTVBLMJ.js";
import {
  hasHelpFlag,
  showHelp
} from "./chunk-HAN5425M.js";
import {
  __name
} from "./chunk-Y7IWVHJ4.js";

// dist/commands/base64/base64.js
var base64Help = {
  name: "base64",
  summary: "base64 encode/decode data and print to standard output",
  usage: "base64 [OPTION]... [FILE]",
  options: [
    "-d, --decode    decode data",
    "-w, --wrap=COLS wrap encoded lines after COLS character (default 76, 0 to disable)",
    "    --help      display this help and exit"
  ]
};
var argDefs = {
  decode: { short: "d", long: "decode", type: "boolean" },
  wrap: { short: "w", long: "wrap", type: "number", default: 76 }
};
async function readBinary(ctx, files, cmdName) {
  if (files.length === 0 || files.length === 1 && files[0] === "-") {
    return {
      ok: true,
      data: Uint8Array.from(ctx.stdin, (c) => c.charCodeAt(0))
    };
  }
  const chunks = [];
  for (const file of files) {
    if (file === "-") {
      chunks.push(Uint8Array.from(ctx.stdin, (c) => c.charCodeAt(0)));
      continue;
    }
    try {
      const filePath = ctx.fs.resolvePath(ctx.cwd, file);
      const data = await ctx.fs.readFileBuffer(filePath);
      chunks.push(data);
    } catch {
      return {
        ok: false,
        error: {
          stdout: "",
          stderr: `${cmdName}: ${file}: No such file or directory
`,
          exitCode: 1
        }
      };
    }
  }
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return { ok: true, data: result };
}
__name(readBinary, "readBinary");
var base64Command = {
  name: "base64",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(base64Help);
    }
    const parsed = parseArgs("base64", args, argDefs);
    if (!parsed.ok)
      return parsed.error;
    const decode = parsed.result.flags.decode;
    const wrapCols = parsed.result.flags.wrap;
    const files = parsed.result.positional;
    try {
      if (decode) {
        const readResult2 = await readBinary(ctx, files, "base64");
        if (!readResult2.ok)
          return readResult2.error;
        const input = String.fromCharCode(...readResult2.data);
        const cleaned = input.replace(/\s/g, "");
        const decoded = atob(cleaned);
        return { stdout: decoded, stderr: "", exitCode: 0 };
      }
      const readResult = await readBinary(ctx, files, "base64");
      if (!readResult.ok)
        return readResult.error;
      let encoded = btoa(String.fromCharCode(...readResult.data));
      if (wrapCols > 0) {
        const lines = [];
        for (let i = 0; i < encoded.length; i += wrapCols) {
          lines.push(encoded.slice(i, i + wrapCols));
        }
        encoded = lines.join("\n") + (encoded.length > 0 ? "\n" : "");
      }
      return { stdout: encoded, stderr: "", exitCode: 0 };
    } catch {
      return { stdout: "", stderr: "base64: invalid input\n", exitCode: 1 };
    }
  }
};
export {
  base64Command
};
