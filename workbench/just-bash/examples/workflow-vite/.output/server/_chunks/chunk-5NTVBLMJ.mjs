import { u as unknownOption } from "./chunk-HAN5425M.mjs";
import { _ as __name } from "../index.mjs";
function parseArgs(cmdName, args, defs) {
  const shortToInfo = /* @__PURE__ */ new Map();
  const longToInfo = /* @__PURE__ */ new Map();
  for (const [name, def] of Object.entries(defs)) {
    const info = { name, type: def.type };
    if (def.short)
      shortToInfo.set(def.short, info);
    if (def.long)
      longToInfo.set(def.long, info);
  }
  const flags = {};
  for (const [name, def] of Object.entries(defs)) {
    if (def.default !== void 0) {
      flags[name] = def.default;
    } else if (def.type === "boolean") {
      flags[name] = false;
    }
  }
  const positional = [];
  let stopParsing = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (stopParsing || !arg.startsWith("-") || arg === "-") {
      positional.push(arg);
      continue;
    }
    if (arg === "--") {
      stopParsing = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const eqIndex = arg.indexOf("=");
      let optName;
      let optValue;
      if (eqIndex !== -1) {
        optName = arg.slice(2, eqIndex);
        optValue = arg.slice(eqIndex + 1);
      } else {
        optName = arg.slice(2);
      }
      const info = longToInfo.get(optName);
      if (!info) {
        return { ok: false, error: unknownOption(cmdName, arg) };
      }
      const { name, type } = info;
      if (type === "boolean") {
        flags[name] = true;
      } else {
        if (optValue === void 0) {
          if (i + 1 >= args.length) {
            return {
              ok: false,
              error: {
                stdout: "",
                stderr: `${cmdName}: option '--${optName}' requires an argument
`,
                exitCode: 1
              }
            };
          }
          optValue = args[++i];
        }
        flags[name] = type === "number" ? parseInt(optValue, 10) : optValue;
      }
    } else {
      const chars = arg.slice(1);
      for (let j = 0; j < chars.length; j++) {
        const c = chars[j];
        const info = shortToInfo.get(c);
        if (!info) {
          return { ok: false, error: unknownOption(cmdName, `-${c}`) };
        }
        const { name, type } = info;
        if (type === "boolean") {
          flags[name] = true;
        } else {
          let optValue;
          if (j + 1 < chars.length) {
            optValue = chars.slice(j + 1);
          } else if (i + 1 < args.length) {
            optValue = args[++i];
          } else {
            return {
              ok: false,
              error: {
                stdout: "",
                stderr: `${cmdName}: option requires an argument -- '${c}'
`,
                exitCode: 1
              }
            };
          }
          flags[name] = type === "number" ? parseInt(optValue, 10) : optValue;
          break;
        }
      }
    }
  }
  return {
    ok: true,
    result: {
      flags,
      positional
    }
  };
}
__name(parseArgs, "parseArgs");
export {
  parseArgs as p
};
