import {
  evaluate,
  parse
} from "./chunk-E7HLGBJ6.js";
import {
  ExecutionLimitError
} from "./chunk-KRBYMBZY.js";
import {
  readFiles
} from "./chunk-XTSQ6SVV.js";
import "./chunk-PRIRMCRG.js";
import {
  hasHelpFlag,
  showHelp,
  unknownOption
} from "./chunk-HAN5425M.js";
import {
  __name
} from "./chunk-Y7IWVHJ4.js";

// dist/commands/jq/jq.js
function parseJsonStream(input) {
  const results = [];
  let pos = 0;
  const len = input.length;
  while (pos < len) {
    while (pos < len && /\s/.test(input[pos]))
      pos++;
    if (pos >= len)
      break;
    const startPos = pos;
    const char = input[pos];
    if (char === "{" || char === "[") {
      const openBracket = char;
      const closeBracket = char === "{" ? "}" : "]";
      let depth = 1;
      let inString = false;
      let isEscaped = false;
      pos++;
      while (pos < len && depth > 0) {
        const c = input[pos];
        if (isEscaped) {
          isEscaped = false;
        } else if (c === "\\") {
          isEscaped = true;
        } else if (c === '"') {
          inString = !inString;
        } else if (!inString) {
          if (c === openBracket)
            depth++;
          else if (c === closeBracket)
            depth--;
        }
        pos++;
      }
      if (depth !== 0) {
        throw new Error(`Unexpected end of JSON input at position ${pos} (unclosed ${openBracket})`);
      }
      results.push(JSON.parse(input.slice(startPos, pos)));
    } else if (char === '"') {
      let isEscaped = false;
      pos++;
      while (pos < len) {
        const c = input[pos];
        if (isEscaped) {
          isEscaped = false;
        } else if (c === "\\") {
          isEscaped = true;
        } else if (c === '"') {
          pos++;
          break;
        }
        pos++;
      }
      results.push(JSON.parse(input.slice(startPos, pos)));
    } else if (char === "-" || char >= "0" && char <= "9") {
      while (pos < len && /[\d.eE+-]/.test(input[pos]))
        pos++;
      results.push(JSON.parse(input.slice(startPos, pos)));
    } else if (input.slice(pos, pos + 4) === "true") {
      results.push(true);
      pos += 4;
    } else if (input.slice(pos, pos + 5) === "false") {
      results.push(false);
      pos += 5;
    } else if (input.slice(pos, pos + 4) === "null") {
      results.push(null);
      pos += 4;
    } else {
      const context = input.slice(pos, pos + 10);
      throw new Error(`Invalid JSON at position ${startPos}: unexpected '${context.split(/\s/)[0]}'`);
    }
  }
  return results;
}
__name(parseJsonStream, "parseJsonStream");
var jqHelp = {
  name: "jq",
  summary: "command-line JSON processor",
  usage: "jq [OPTIONS] FILTER [FILE]",
  options: [
    "-r, --raw-output  output strings without quotes",
    "-c, --compact     compact output (no pretty printing)",
    "-e, --exit-status set exit status based on output",
    "-s, --slurp       read entire input into array",
    "-n, --null-input  don't read any input",
    "-j, --join-output don't print newlines after each output",
    "-a, --ascii       force ASCII output",
    "-S, --sort-keys   sort object keys",
    "-C, --color       colorize output (ignored)",
    "-M, --monochrome  monochrome output (ignored)",
    "    --tab         use tabs for indentation",
    "    --help        display this help and exit"
  ]
};
function formatValue(v, compact, raw, sortKeys, useTab, indent = 0) {
  if (v === null)
    return "null";
  if (v === void 0)
    return "null";
  if (typeof v === "boolean")
    return String(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v))
      return "null";
    return String(v);
  }
  if (typeof v === "string")
    return raw ? v : JSON.stringify(v);
  const indentStr = useTab ? "	" : "  ";
  if (Array.isArray(v)) {
    if (v.length === 0)
      return "[]";
    if (compact) {
      return `[${v.map((x) => formatValue(x, true, false, sortKeys, useTab)).join(",")}]`;
    }
    const items = v.map((x) => indentStr.repeat(indent + 1) + formatValue(x, false, false, sortKeys, useTab, indent + 1));
    return `[
${items.join(",\n")}
${indentStr.repeat(indent)}]`;
  }
  if (typeof v === "object") {
    let keys = Object.keys(v);
    if (sortKeys)
      keys = keys.sort();
    if (keys.length === 0)
      return "{}";
    if (compact) {
      return `{${keys.map((k) => `${JSON.stringify(k)}:${formatValue(v[k], true, false, sortKeys, useTab)}`).join(",")}}`;
    }
    const items = keys.map((k) => {
      const val = formatValue(v[k], false, false, sortKeys, useTab, indent + 1);
      return `${indentStr.repeat(indent + 1)}${JSON.stringify(k)}: ${val}`;
    });
    return `{
${items.join(",\n")}
${indentStr.repeat(indent)}}`;
  }
  return String(v);
}
__name(formatValue, "formatValue");
var jqCommand = {
  name: "jq",
  async execute(args, ctx) {
    if (hasHelpFlag(args))
      return showHelp(jqHelp);
    let raw = false;
    let compact = false;
    let exitStatus = false;
    let slurp = false;
    let nullInput = false;
    let joinOutput = false;
    let sortKeys = false;
    let useTab = false;
    let filter = ".";
    let filterSet = false;
    const files = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-r" || a === "--raw-output")
        raw = true;
      else if (a === "-c" || a === "--compact-output")
        compact = true;
      else if (a === "-e" || a === "--exit-status")
        exitStatus = true;
      else if (a === "-s" || a === "--slurp")
        slurp = true;
      else if (a === "-n" || a === "--null-input")
        nullInput = true;
      else if (a === "-j" || a === "--join-output")
        joinOutput = true;
      else if (a === "-a" || a === "--ascii") {
      } else if (a === "-S" || a === "--sort-keys")
        sortKeys = true;
      else if (a === "-C" || a === "--color") {
      } else if (a === "-M" || a === "--monochrome") {
      } else if (a === "--tab")
        useTab = true;
      else if (a === "-")
        files.push("-");
      else if (a.startsWith("--"))
        return unknownOption("jq", a);
      else if (a.startsWith("-")) {
        for (const c of a.slice(1)) {
          if (c === "r")
            raw = true;
          else if (c === "c")
            compact = true;
          else if (c === "e")
            exitStatus = true;
          else if (c === "s")
            slurp = true;
          else if (c === "n")
            nullInput = true;
          else if (c === "j")
            joinOutput = true;
          else if (c === "a") {
          } else if (c === "S")
            sortKeys = true;
          else if (c === "C") {
          } else if (c === "M") {
          } else
            return unknownOption("jq", `-${c}`);
        }
      } else if (!filterSet) {
        filter = a;
        filterSet = true;
      } else {
        files.push(a);
      }
    }
    let inputs = [];
    if (nullInput) {
    } else if (files.length === 0 || files.length === 1 && files[0] === "-") {
      inputs.push({ source: "stdin", content: ctx.stdin });
    } else {
      const result = await readFiles(ctx, files, {
        cmdName: "jq",
        stopOnError: true
      });
      if (result.exitCode !== 0) {
        return {
          stdout: "",
          stderr: result.stderr,
          exitCode: 2
          // jq uses exit code 2 for file errors
        };
      }
      inputs = result.files.map((f) => ({
        source: f.filename || "stdin",
        content: f.content
      }));
    }
    try {
      const ast = parse(filter);
      let values = [];
      const evalOptions = {
        limits: ctx.limits ? { maxIterations: ctx.limits.maxJqIterations } : void 0,
        env: ctx.env
      };
      if (nullInput) {
        values = evaluate(null, ast, evalOptions);
      } else if (slurp) {
        const items = [];
        for (const { content } of inputs) {
          const trimmed = content.trim();
          if (trimmed) {
            items.push(...parseJsonStream(trimmed));
          }
        }
        values = evaluate(items, ast, evalOptions);
      } else {
        for (const { content } of inputs) {
          const trimmed = content.trim();
          if (!trimmed)
            continue;
          const jsonValues = parseJsonStream(trimmed);
          for (const jsonValue of jsonValues) {
            values.push(...evaluate(jsonValue, ast, evalOptions));
          }
        }
      }
      const formatted = values.map((v) => formatValue(v, compact, raw, sortKeys, useTab));
      const separator = joinOutput ? "" : "\n";
      const output = formatted.join(separator);
      const exitCode = exitStatus && (values.length === 0 || values.every((v) => v === null || v === void 0 || v === false)) ? 1 : 0;
      return {
        stdout: output ? joinOutput ? output : `${output}
` : "",
        stderr: "",
        exitCode
      };
    } catch (e) {
      if (e instanceof ExecutionLimitError) {
        return {
          stdout: "",
          stderr: `jq: ${e.message}
`,
          exitCode: ExecutionLimitError.EXIT_CODE
        };
      }
      const msg = e.message;
      if (msg.includes("Unknown function")) {
        return {
          stdout: "",
          stderr: `jq: error: ${msg}
`,
          exitCode: 3
        };
      }
      return {
        stdout: "",
        stderr: `jq: parse error: ${msg}
`,
        exitCode: 5
      };
    }
  }
};
export {
  jqCommand
};
