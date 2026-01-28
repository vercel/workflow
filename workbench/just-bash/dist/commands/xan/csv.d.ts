/**
 * CSV parsing and formatting utilities for xan command
 */
import type { CommandContext, ExecResult } from "../../types.js";
export interface CsvRow {
    [key: string]: string | number | boolean | null;
}
export type CsvData = CsvRow[];
/** Parse CSV input string to array of row objects */
export declare function parseCsv(input: string): {
    headers: string[];
    data: CsvData;
};
/** Format array of row objects back to CSV string */
export declare function formatCsv(headers: string[], data: CsvData): string;
/** Read CSV input from file or stdin */
export declare function readCsvInput(args: string[], ctx: CommandContext): Promise<{
    headers: string[];
    data: CsvData;
    error?: ExecResult;
}>;
