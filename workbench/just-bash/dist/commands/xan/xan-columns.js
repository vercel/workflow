/**
 * Column operation commands: select, drop, rename, enum
 */
import { parseColumnSpec } from "./column-selection.js";
import { formatCsv, readCsvInput } from "./csv.js";
export async function cmdSelect(args, ctx) {
    // First positional arg is column spec, rest are files
    let colSpec = "";
    const fileArgs = [];
    for (const arg of args) {
        if (arg.startsWith("-"))
            continue;
        if (!colSpec) {
            colSpec = arg;
        }
        else {
            fileArgs.push(arg);
        }
    }
    if (!colSpec) {
        return {
            stdout: "",
            stderr: "xan select: no columns specified\n",
            exitCode: 1,
        };
    }
    const { headers, data, error } = await readCsvInput(fileArgs, ctx);
    if (error)
        return error;
    // Use parseColumnSpec to handle names, indices, and ranges
    const newHeaders = parseColumnSpec(colSpec, headers);
    const newData = data.map((row) => {
        const newRow = {};
        for (const col of newHeaders) {
            newRow[col] = row[col];
        }
        return newRow;
    });
    return { stdout: formatCsv(newHeaders, newData), stderr: "", exitCode: 0 };
}
export async function cmdDrop(args, ctx) {
    // First positional arg is column spec, rest are files
    let colSpec = "";
    const fileArgs = [];
    for (const arg of args) {
        if (arg.startsWith("-"))
            continue;
        if (!colSpec) {
            colSpec = arg;
        }
        else {
            fileArgs.push(arg);
        }
    }
    if (!colSpec) {
        return {
            stdout: "",
            stderr: "xan drop: no columns specified\n",
            exitCode: 1,
        };
    }
    const { headers, data, error } = await readCsvInput(fileArgs, ctx);
    if (error)
        return error;
    // Use parseColumnSpec to resolve indices and ranges to column names
    const dropCols = new Set(parseColumnSpec(colSpec, headers));
    const newHeaders = headers.filter((h) => !dropCols.has(h));
    const newData = data.map((row) => {
        const newRow = {};
        for (const col of newHeaders) {
            newRow[col] = row[col];
        }
        return newRow;
    });
    return { stdout: formatCsv(newHeaders, newData), stderr: "", exitCode: 0 };
}
export async function cmdRename(args, ctx) {
    // xan rename NEW_NAMES [-s cols] FILE
    // If -s is provided, rename specific columns
    // Otherwise, rename all columns (NEW_NAMES is comma-separated)
    let newNames = "";
    let selectCols = "";
    const fileArgs = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-s" && i + 1 < args.length) {
            selectCols = args[++i];
        }
        else if (!arg.startsWith("-")) {
            if (!newNames) {
                newNames = arg;
            }
            else {
                fileArgs.push(arg);
            }
        }
    }
    if (!newNames) {
        return {
            stdout: "",
            stderr: "xan rename: no new name(s) specified\n",
            exitCode: 1,
        };
    }
    const { headers, data, error } = await readCsvInput(fileArgs, ctx);
    if (error)
        return error;
    let newHeaders;
    if (selectCols) {
        // Rename specific columns
        const oldCols = selectCols.split(",");
        const newNamesList = newNames.split(",");
        const renames = new Map();
        for (let i = 0; i < oldCols.length && i < newNamesList.length; i++) {
            renames.set(oldCols[i], newNamesList[i]);
        }
        newHeaders = headers.map((h) => renames.get(h) || h);
    }
    else {
        // Rename all columns (or first N if fewer new names)
        const newNamesList = newNames.split(",");
        newHeaders = headers.map((h, i) => i < newNamesList.length ? newNamesList[i] : h);
    }
    const newData = data.map((row) => {
        const newRow = {};
        for (let i = 0; i < headers.length; i++) {
            newRow[newHeaders[i]] = row[headers[i]];
        }
        return newRow;
    });
    return { stdout: formatCsv(newHeaders, newData), stderr: "", exitCode: 0 };
}
export async function cmdEnum(args, ctx) {
    let colName = "index";
    const filteredArgs = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "-c" && i + 1 < args.length) {
            colName = args[++i];
        }
        else {
            filteredArgs.push(args[i]);
        }
    }
    const { headers, data, error } = await readCsvInput(filteredArgs, ctx);
    if (error)
        return error;
    const newHeaders = [colName, ...headers];
    const newData = data.map((row, idx) => {
        const newRow = { [colName]: idx };
        for (const h of headers) {
            newRow[h] = row[h];
        }
        return newRow;
    });
    return { stdout: formatCsv(newHeaders, newData), stderr: "", exitCode: 0 };
}
