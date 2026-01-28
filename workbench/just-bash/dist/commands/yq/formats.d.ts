/**
 * Format parsing and output for yq command
 *
 * Supports YAML, JSON, XML, INI, CSV, and TOML formats with conversion between them.
 */
import type { QueryValue } from "../query-engine/index.js";
export type InputFormat = "yaml" | "xml" | "json" | "ini" | "csv" | "toml";
export type OutputFormat = "yaml" | "json" | "xml" | "ini" | "csv" | "toml";
/**
 * Type guard to validate input format strings at runtime
 */
export declare function isValidInputFormat(value: unknown): value is InputFormat;
/**
 * Type guard to validate output format strings at runtime
 */
export declare function isValidOutputFormat(value: unknown): value is OutputFormat;
export interface FormatOptions {
    /** Input format (default: yaml) */
    inputFormat: InputFormat;
    /** Output format (default: yaml) */
    outputFormat: OutputFormat;
    /** Output raw strings without quotes (json only) */
    raw: boolean;
    /** Compact output (json only) */
    compact: boolean;
    /** Pretty print output */
    prettyPrint: boolean;
    /** Indentation level */
    indent: number;
    /** XML attribute prefix (default: +@) */
    xmlAttributePrefix: string;
    /** XML text content name (default: +content) */
    xmlContentName: string;
    /** CSV delimiter (empty = auto-detect) */
    csvDelimiter: string;
    /** CSV has header row */
    csvHeader: boolean;
}
export declare const defaultFormatOptions: FormatOptions;
/**
 * Detect input format from file extension
 */
export declare function detectFormatFromExtension(filename: string): InputFormat | null;
/**
 * Parse input data from the given format into a QueryValue
 */
export declare function parseInput(input: string, options: FormatOptions): QueryValue;
/**
 * Parse all YAML documents from input (for slurp mode)
 */
export declare function parseAllYamlDocuments(input: string): QueryValue[];
/**
 * Extract front-matter from content
 * Front-matter is YAML/TOML/JSON at the start of a file between --- or +++ delimiters
 * Returns { frontMatter: parsed data, content: remaining content } or null if no front-matter
 */
export declare function extractFrontMatter(input: string): {
    frontMatter: QueryValue;
    content: string;
} | null;
/**
 * Format a QueryValue for output in the given format
 */
export declare function formatOutput(value: QueryValue, options: FormatOptions): string;
