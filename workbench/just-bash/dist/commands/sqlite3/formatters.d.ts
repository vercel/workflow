/**
 * Output formatters for sqlite3 command
 */
export type OutputMode = "list" | "csv" | "json" | "line" | "column" | "table" | "markdown" | "tabs" | "box" | "quote" | "html" | "ascii";
export interface FormatOptions {
    mode: OutputMode;
    header: boolean;
    separator: string;
    nullValue: string;
    newline: string;
}
/**
 * Format query results according to the specified options
 */
export declare function formatOutput(columns: string[], rows: unknown[][], options: FormatOptions): string;
