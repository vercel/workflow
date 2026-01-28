/**
 * AWK Variable and Array Operations
 *
 * Handles user variables, built-in variables, and arrays.
 */
import { setFieldSeparator } from "./fields.js";
import { toAwkString, toNumber } from "./type-coercion.js";
/**
 * Get a variable value. Handles built-in variables.
 */
export function getVariable(ctx, name) {
    switch (name) {
        case "FS":
            return ctx.FS;
        case "OFS":
            return ctx.OFS;
        case "ORS":
            return ctx.ORS;
        case "OFMT":
            return ctx.OFMT;
        case "NR":
            return ctx.NR;
        case "NF":
            return ctx.NF;
        case "FNR":
            return ctx.FNR;
        case "FILENAME":
            return ctx.FILENAME;
        case "RSTART":
            return ctx.RSTART;
        case "RLENGTH":
            return ctx.RLENGTH;
        case "SUBSEP":
            return ctx.SUBSEP;
        case "ARGC":
            return ctx.ARGC;
    }
    return ctx.vars[name] ?? "";
}
/**
 * Set a variable value. Handles built-in variables with special behavior.
 */
export function setVariable(ctx, name, value) {
    switch (name) {
        case "FS":
            setFieldSeparator(ctx, toAwkString(value));
            return;
        case "OFS":
            ctx.OFS = toAwkString(value);
            return;
        case "ORS":
            ctx.ORS = toAwkString(value);
            return;
        case "OFMT":
            ctx.OFMT = toAwkString(value);
            return;
        case "NR":
            ctx.NR = Math.floor(toNumber(value));
            return;
        case "NF": {
            const newNF = Math.floor(toNumber(value));
            if (newNF < ctx.NF) {
                ctx.fields = ctx.fields.slice(0, newNF);
                ctx.line = ctx.fields.join(ctx.OFS);
            }
            else if (newNF > ctx.NF) {
                while (ctx.fields.length < newNF) {
                    ctx.fields.push("");
                }
                ctx.line = ctx.fields.join(ctx.OFS);
            }
            ctx.NF = newNF;
            return;
        }
        case "FNR":
            ctx.FNR = Math.floor(toNumber(value));
            return;
        case "FILENAME":
            ctx.FILENAME = toAwkString(value);
            return;
        case "RSTART":
            ctx.RSTART = Math.floor(toNumber(value));
            return;
        case "RLENGTH":
            ctx.RLENGTH = Math.floor(toNumber(value));
            return;
        case "SUBSEP":
            ctx.SUBSEP = toAwkString(value);
            return;
    }
    ctx.vars[name] = value;
}
/**
 * Resolve array name through aliases (for function parameter passing).
 */
function resolveArrayName(ctx, array) {
    // Follow alias chain to get the real array name
    let resolved = array;
    const seen = new Set();
    let alias = ctx.arrayAliases.get(resolved);
    while (alias !== undefined && !seen.has(resolved)) {
        seen.add(resolved);
        resolved = alias;
        alias = ctx.arrayAliases.get(resolved);
    }
    return resolved;
}
/**
 * Get an array element value.
 */
export function getArrayElement(ctx, array, key) {
    // Handle built-in ARGV array
    if (array === "ARGV") {
        return ctx.ARGV[key] ?? "";
    }
    // Handle built-in ENVIRON array
    if (array === "ENVIRON") {
        return ctx.ENVIRON[key] ?? "";
    }
    // Resolve aliases for function parameter passing
    const resolvedArray = resolveArrayName(ctx, array);
    return ctx.arrays[resolvedArray]?.[key] ?? "";
}
/**
 * Set an array element value.
 */
export function setArrayElement(ctx, array, key, value) {
    // Resolve aliases for function parameter passing
    const resolvedArray = resolveArrayName(ctx, array);
    if (!ctx.arrays[resolvedArray]) {
        ctx.arrays[resolvedArray] = {};
    }
    ctx.arrays[resolvedArray][key] = value;
}
/**
 * Check if an array element exists.
 */
export function hasArrayElement(ctx, array, key) {
    if (array === "ARGV") {
        return ctx.ARGV[key] !== undefined;
    }
    if (array === "ENVIRON") {
        return ctx.ENVIRON[key] !== undefined;
    }
    // Resolve aliases for function parameter passing
    const resolvedArray = resolveArrayName(ctx, array);
    return ctx.arrays[resolvedArray]?.[key] !== undefined;
}
/**
 * Delete an array element.
 */
export function deleteArrayElement(ctx, array, key) {
    // Resolve aliases for function parameter passing
    const resolvedArray = resolveArrayName(ctx, array);
    if (ctx.arrays[resolvedArray]) {
        delete ctx.arrays[resolvedArray][key];
    }
}
/**
 * Delete an entire array.
 */
export function deleteArray(ctx, array) {
    // Resolve aliases for function parameter passing
    const resolvedArray = resolveArrayName(ctx, array);
    delete ctx.arrays[resolvedArray];
}
