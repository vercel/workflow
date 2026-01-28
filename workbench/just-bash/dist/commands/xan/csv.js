/**
 * CSV parsing and formatting utilities for xan command
 */
import Papa from "papaparse";
/** Parse CSV input string to array of row objects */
export function parseCsv(input) {
    const result = Papa.parse(input.trim(), {
        header: true,
        dynamicTyping: true,
        skipEmptyLines: true,
    });
    return {
        headers: result.meta.fields || [],
        data: result.data,
    };
}
/** Format array of row objects back to CSV string */
export function formatCsv(headers, data) {
    if (data.length === 0) {
        return `${headers.join(",")}\n`;
    }
    // papaparse may produce \r\n, normalize to \n
    const csv = Papa.unparse(data, { columns: headers });
    return `${csv.replace(/\r\n/g, "\n")}\n`;
}
/** Read CSV input from file or stdin */
export async function readCsvInput(args, ctx) {
    const file = args.find((a) => !a.startsWith("-"));
    let input;
    if (!file || file === "-") {
        input = ctx.stdin;
    }
    else {
        try {
            const path = ctx.fs.resolvePath(ctx.cwd, file);
            input = await ctx.fs.readFile(path);
        }
        catch {
            return {
                headers: [],
                data: [],
                error: {
                    stdout: "",
                    stderr: `xan: ${file}: No such file or directory\n`,
                    exitCode: 1,
                },
            };
        }
    }
    const { headers, data } = parseCsv(input);
    return { headers, data };
}
