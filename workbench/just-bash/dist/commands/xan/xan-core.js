/**
 * Core xan commands: headers, count, head, tail, slice, reverse
 */
import { formatCsv, readCsvInput } from "./csv.js";
export async function cmdHeaders(args, ctx) {
    const justNames = args.includes("-j") || args.includes("--just-names");
    const { headers, error } = await readCsvInput(args.filter((a) => a !== "-j" && a !== "--just-names"), ctx);
    if (error)
        return error;
    const output = justNames
        ? `${headers.map((h) => h).join("\n")}\n`
        : `${headers.map((h, i) => `${i}   ${h}`).join("\n")}\n`;
    return { stdout: output, stderr: "", exitCode: 0 };
}
export async function cmdCount(args, ctx) {
    const { data, error } = await readCsvInput(args, ctx);
    if (error)
        return error;
    return { stdout: `${data.length}\n`, stderr: "", exitCode: 0 };
}
export async function cmdHead(args, ctx) {
    let n = 10;
    const filteredArgs = [];
    for (let i = 0; i < args.length; i++) {
        if ((args[i] === "-l" || args[i] === "-n") && i + 1 < args.length) {
            n = Number.parseInt(args[++i], 10);
        }
        else {
            filteredArgs.push(args[i]);
        }
    }
    const { headers, data, error } = await readCsvInput(filteredArgs, ctx);
    if (error)
        return error;
    const rows = data.slice(0, n);
    return { stdout: formatCsv(headers, rows), stderr: "", exitCode: 0 };
}
export async function cmdTail(args, ctx) {
    let n = 10;
    const filteredArgs = [];
    for (let i = 0; i < args.length; i++) {
        if ((args[i] === "-l" || args[i] === "-n") && i + 1 < args.length) {
            n = Number.parseInt(args[++i], 10);
        }
        else {
            filteredArgs.push(args[i]);
        }
    }
    const { headers, data, error } = await readCsvInput(filteredArgs, ctx);
    if (error)
        return error;
    const rows = data.slice(-n);
    return { stdout: formatCsv(headers, rows), stderr: "", exitCode: 0 };
}
export async function cmdSlice(args, ctx) {
    let start;
    let end;
    let len;
    const fileArgs = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if ((arg === "-s" || arg === "--start") && i + 1 < args.length) {
            start = Number.parseInt(args[++i], 10);
        }
        else if ((arg === "-e" || arg === "--end") && i + 1 < args.length) {
            end = Number.parseInt(args[++i], 10);
        }
        else if ((arg === "-l" || arg === "--len") && i + 1 < args.length) {
            len = Number.parseInt(args[++i], 10);
        }
        else if (!arg.startsWith("-")) {
            fileArgs.push(arg);
        }
    }
    const { headers, data, error } = await readCsvInput(fileArgs, ctx);
    if (error)
        return error;
    const startIdx = start ?? 0;
    let endIdx;
    if (len !== undefined) {
        endIdx = startIdx + len;
    }
    else if (end !== undefined) {
        endIdx = end;
    }
    else {
        endIdx = data.length;
    }
    const rows = data.slice(startIdx, endIdx);
    return { stdout: formatCsv(headers, rows), stderr: "", exitCode: 0 };
}
export async function cmdReverse(args, ctx) {
    const { headers, data, error } = await readCsvInput(args, ctx);
    if (error)
        return error;
    const rows = [...data].reverse();
    return { stdout: formatCsv(headers, rows), stderr: "", exitCode: 0 };
}
