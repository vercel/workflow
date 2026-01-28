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

// dist/commands/tr/tr.js
var trHelp = {
  name: "tr",
  summary: "translate or delete characters",
  usage: "tr [OPTION]... SET1 [SET2]",
  options: [
    "-c, -C, --complement   use the complement of SET1",
    "-d, --delete           delete characters in SET1",
    "-s, --squeeze-repeats  squeeze repeated characters",
    "    --help             display this help and exit"
  ],
  description: `SET syntax:
  a-z         character range
  [:alnum:]   all letters and digits
  [:alpha:]   all letters
  [:digit:]   all digits
  [:lower:]   all lowercase letters
  [:upper:]   all uppercase letters
  [:space:]   all whitespace
  [:blank:]   horizontal whitespace
  [:punct:]   all punctuation
  [:print:]   all printable characters
  [:graph:]   all printable characters except space
  [:cntrl:]   all control characters
  [:xdigit:]  all hexadecimal digits
  \\n, \\t, \\r  escape sequences`
};
var POSIX_CLASSES = {
  "[:alnum:]": "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  "[:alpha:]": "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
  "[:blank:]": " 	",
  "[:cntrl:]": Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join("").concat(String.fromCharCode(127)),
  "[:digit:]": "0123456789",
  "[:graph:]": Array.from({ length: 94 }, (_, i) => String.fromCharCode(33 + i)).join(""),
  "[:lower:]": "abcdefghijklmnopqrstuvwxyz",
  "[:print:]": Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join(""),
  "[:punct:]": "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~",
  "[:space:]": " 	\n\r\f\v",
  "[:upper:]": "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  "[:xdigit:]": "0123456789ABCDEFabcdef"
};
function expandRange(set) {
  let result = "";
  let i = 0;
  while (i < set.length) {
    if (set[i] === "[" && set[i + 1] === ":") {
      let found = false;
      for (const [className, chars] of Object.entries(POSIX_CLASSES)) {
        if (set.slice(i).startsWith(className)) {
          result += chars;
          i += className.length;
          found = true;
          break;
        }
      }
      if (found)
        continue;
    }
    if (set[i] === "\\" && i + 1 < set.length) {
      const next = set[i + 1];
      if (next === "n") {
        result += "\n";
      } else if (next === "t") {
        result += "	";
      } else if (next === "r") {
        result += "\r";
      } else {
        result += next;
      }
      i += 2;
      continue;
    }
    if (i + 2 < set.length && set[i + 1] === "-") {
      const start = set.charCodeAt(i);
      const end = set.charCodeAt(i + 2);
      for (let code = start; code <= end; code++) {
        result += String.fromCharCode(code);
      }
      i += 3;
      continue;
    }
    result += set[i];
    i++;
  }
  return result;
}
__name(expandRange, "expandRange");
var argDefs = {
  complement: { short: "c", long: "complement", type: "boolean" },
  complementUpper: { short: "C", type: "boolean" },
  delete: { short: "d", long: "delete", type: "boolean" },
  squeeze: { short: "s", long: "squeeze-repeats", type: "boolean" }
};
var trCommand = {
  name: "tr",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(trHelp);
    }
    const parsed = parseArgs("tr", args, argDefs);
    if (!parsed.ok)
      return parsed.error;
    const complementMode = parsed.result.flags.complement || parsed.result.flags.complementUpper;
    const deleteMode = parsed.result.flags.delete;
    const squeezeMode = parsed.result.flags.squeeze;
    const sets = parsed.result.positional;
    if (sets.length < 1) {
      return {
        stdout: "",
        stderr: "tr: missing operand\n",
        exitCode: 1
      };
    }
    if (!deleteMode && !squeezeMode && sets.length < 2) {
      return {
        stdout: "",
        stderr: "tr: missing operand after SET1\n",
        exitCode: 1
      };
    }
    const set1Raw = expandRange(sets[0]);
    const set2 = sets.length > 1 ? expandRange(sets[1]) : "";
    const content = ctx.stdin;
    const isInSet1 = /* @__PURE__ */ __name((char) => {
      const inSet = set1Raw.includes(char);
      return complementMode ? !inSet : inSet;
    }, "isInSet1");
    let output = "";
    if (deleteMode) {
      for (const char of content) {
        if (!isInSet1(char)) {
          output += char;
        }
      }
    } else if (squeezeMode && sets.length === 1) {
      let prev = "";
      for (const char of content) {
        if (isInSet1(char) && char === prev) {
          continue;
        }
        output += char;
        prev = char;
      }
    } else {
      if (complementMode) {
        const targetChar = set2.length > 0 ? set2[set2.length - 1] : "";
        for (const char of content) {
          if (!set1Raw.includes(char)) {
            output += targetChar;
          } else {
            output += char;
          }
        }
      } else {
        const translationMap = /* @__PURE__ */ new Map();
        for (let i = 0; i < set1Raw.length; i++) {
          const targetChar = i < set2.length ? set2[i] : set2[set2.length - 1];
          translationMap.set(set1Raw[i], targetChar);
        }
        for (const char of content) {
          output += translationMap.get(char) ?? char;
        }
      }
      if (squeezeMode) {
        let squeezed = "";
        let prev = "";
        for (const char of output) {
          if (set2.includes(char) && char === prev) {
            continue;
          }
          squeezed += char;
          prev = char;
        }
        output = squeezed;
      }
    }
    return { stdout: output, stderr: "", exitCode: 0 };
  }
};
export {
  trCommand
};
