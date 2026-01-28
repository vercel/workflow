/**
 * Lightweight argument parser for command implementations.
 *
 * Handles common patterns:
 * - Boolean flags: -n, --number
 * - Combined short flags: -rn (same as -r -n)
 * - Value options: -k VALUE, -kVALUE, --key=VALUE, --key VALUE
 * - Positional arguments
 * - Unknown option detection
 */
import { unknownOption } from "../commands/help.js";
/**
 * Parse command arguments according to the provided definitions.
 *
 * @param cmdName - Command name for error messages
 * @param args - Arguments to parse
 * @param defs - Argument definitions
 * @returns Parsed arguments or error result
 *
 * @example
 * const defs = {
 *   reverse: { short: "r", long: "reverse", type: "boolean" as const },
 *   count: { short: "n", long: "lines", type: "number" as const, default: 10 },
 * };
 * const result = parseArgs("head", args, defs);
 * if (!result.ok) return result.error;
 * const { flags, positional } = result.result;
 */
export function parseArgs(cmdName, args, defs) {
    // Build lookup maps: map short/long options to {name, type}
    const shortToInfo = new Map();
    const longToInfo = new Map();
    for (const [name, def] of Object.entries(defs)) {
        const info = { name, type: def.type };
        if (def.short)
            shortToInfo.set(def.short, info);
        if (def.long)
            longToInfo.set(def.long, info);
    }
    // Initialize with defaults
    // Boolean flags default to false, but string/number flags without
    // explicit defaults remain undefined (allowing callers to detect if set)
    const flags = {};
    for (const [name, def] of Object.entries(defs)) {
        if (def.default !== undefined) {
            flags[name] = def.default;
        }
        else if (def.type === "boolean") {
            flags[name] = false;
        }
        // String and number types without defaults remain undefined
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
            // Long option
            const eqIndex = arg.indexOf("=");
            let optName;
            let optValue;
            if (eqIndex !== -1) {
                optName = arg.slice(2, eqIndex);
                optValue = arg.slice(eqIndex + 1);
            }
            else {
                optName = arg.slice(2);
            }
            const info = longToInfo.get(optName);
            if (!info) {
                return { ok: false, error: unknownOption(cmdName, arg) };
            }
            const { name, type } = info;
            if (type === "boolean") {
                flags[name] = true;
            }
            else {
                // Need a value
                if (optValue === undefined) {
                    if (i + 1 >= args.length) {
                        return {
                            ok: false,
                            error: {
                                stdout: "",
                                stderr: `${cmdName}: option '--${optName}' requires an argument\n`,
                                exitCode: 1,
                            },
                        };
                    }
                    optValue = args[++i];
                }
                flags[name] = type === "number" ? parseInt(optValue, 10) : optValue;
            }
        }
        else {
            // Short option(s)
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
                }
                else {
                    // Value option - rest of string or next arg
                    let optValue;
                    if (j + 1 < chars.length) {
                        // Value is attached: -n10
                        optValue = chars.slice(j + 1);
                    }
                    else if (i + 1 < args.length) {
                        // Value is next arg: -n 10
                        optValue = args[++i];
                    }
                    else {
                        return {
                            ok: false,
                            error: {
                                stdout: "",
                                stderr: `${cmdName}: option requires an argument -- '${c}'\n`,
                                exitCode: 1,
                            },
                        };
                    }
                    flags[name] = type === "number" ? parseInt(optValue, 10) : optValue;
                    break; // Rest of chars consumed as value
                }
            }
        }
    }
    return {
        ok: true,
        result: {
            flags: flags,
            positional,
        },
    };
}
