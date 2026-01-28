/**
 * Format parsing and output for yq command
 *
 * Supports YAML, JSON, XML, INI, CSV, and TOML formats with conversion between them.
 */
import { XMLBuilder, XMLParser } from "fast-xml-parser";
import * as ini from "ini";
import Papa from "papaparse";
import * as TOML from "smol-toml";
import YAML from "yaml";
const validInputFormats = [
    "yaml",
    "xml",
    "json",
    "ini",
    "csv",
    "toml",
];
const validOutputFormats = [
    "yaml",
    "json",
    "xml",
    "ini",
    "csv",
    "toml",
];
/**
 * Type guard to validate input format strings at runtime
 */
export function isValidInputFormat(value) {
    return (typeof value === "string" &&
        validInputFormats.includes(value));
}
/**
 * Type guard to validate output format strings at runtime
 */
export function isValidOutputFormat(value) {
    return (typeof value === "string" &&
        validOutputFormats.includes(value));
}
export const defaultFormatOptions = {
    inputFormat: "yaml",
    outputFormat: "yaml",
    raw: false,
    compact: false,
    prettyPrint: false,
    indent: 2,
    xmlAttributePrefix: "+@",
    xmlContentName: "+content",
    csvDelimiter: "",
    csvHeader: true,
};
/**
 * Extract file extension (browser-compatible alternative to node:path extname)
 */
function getExtension(filename) {
    const lastDot = filename.lastIndexOf(".");
    const lastSlash = Math.max(filename.lastIndexOf("/"), filename.lastIndexOf("\\"));
    if (lastDot <= lastSlash + 1)
        return "";
    return filename.slice(lastDot);
}
/**
 * Detect input format from file extension
 */
export function detectFormatFromExtension(filename) {
    const ext = getExtension(filename).toLowerCase();
    switch (ext) {
        case ".yaml":
        case ".yml":
            return "yaml";
        case ".json":
            return "json";
        case ".xml":
            return "xml";
        case ".ini":
            return "ini";
        case ".csv":
        case ".tsv":
            return "csv";
        case ".toml":
            return "toml";
        default:
            return null;
    }
}
/**
 * Parse CSV into array of objects (if header) or array of arrays
 */
function parseCsv(input, delimiter, hasHeader) {
    const result = Papa.parse(input, {
        delimiter: delimiter || undefined, // undefined triggers auto-detection
        header: hasHeader,
        dynamicTyping: true,
        skipEmptyLines: true,
    });
    return result.data;
}
/**
 * Format data as CSV
 */
function formatCsv(value, delimiter) {
    if (!Array.isArray(value)) {
        value = [value];
    }
    // Use comma as default for output (empty means auto-detect for input only)
    return Papa.unparse(value, { delimiter: delimiter || "," });
}
/**
 * Parse input data from the given format into a QueryValue
 */
export function parseInput(input, options) {
    const trimmed = input.trim();
    if (!trimmed)
        return null;
    switch (options.inputFormat) {
        case "yaml":
            return YAML.parse(trimmed);
        case "json":
            return JSON.parse(trimmed);
        case "xml": {
            const parser = new XMLParser({
                ignoreAttributes: false,
                attributeNamePrefix: options.xmlAttributePrefix,
                textNodeName: options.xmlContentName,
                // Keep values as strings to match real yq behavior
                parseAttributeValue: false,
                parseTagValue: false,
                trimValues: true,
                // Transform empty tags to null to match real yq
                tagValueProcessor: (_name, val) => (val === "" ? null : val),
            });
            return parser.parse(trimmed);
        }
        case "ini":
            return ini.parse(trimmed);
        case "csv":
            return parseCsv(trimmed, options.csvDelimiter, options.csvHeader);
        case "toml":
            return TOML.parse(trimmed);
        default: {
            const _exhaustive = options.inputFormat;
            throw new Error(`Invalid input format: ${_exhaustive}`);
        }
    }
}
/**
 * Parse all YAML documents from input (for slurp mode)
 */
export function parseAllYamlDocuments(input) {
    const docs = YAML.parseAllDocuments(input);
    return docs.map((doc) => doc.toJSON());
}
/**
 * Extract front-matter from content
 * Front-matter is YAML/TOML/JSON at the start of a file between --- or +++ delimiters
 * Returns { frontMatter: parsed data, content: remaining content } or null if no front-matter
 */
export function extractFrontMatter(input) {
    const trimmed = input.trimStart();
    // YAML front-matter: starts with ---
    if (trimmed.startsWith("---")) {
        const endMatch = trimmed.slice(3).match(/\n---(\n|$)/);
        if (endMatch && endMatch.index !== undefined) {
            const yamlContent = trimmed.slice(3, endMatch.index + 3);
            const remaining = trimmed.slice(endMatch.index + 3 + endMatch[0].length);
            return {
                frontMatter: YAML.parse(yamlContent),
                content: remaining,
            };
        }
    }
    // TOML front-matter: starts with +++
    if (trimmed.startsWith("+++")) {
        const endMatch = trimmed.slice(3).match(/\n\+\+\+(\n|$)/);
        if (endMatch && endMatch.index !== undefined) {
            const tomlContent = trimmed.slice(3, endMatch.index + 3);
            const remaining = trimmed.slice(endMatch.index + 3 + endMatch[0].length);
            return {
                frontMatter: TOML.parse(tomlContent),
                content: remaining,
            };
        }
    }
    // JSON front-matter: starts with {{{ (less common)
    if (trimmed.startsWith("{{{")) {
        const endMatch = trimmed.slice(3).match(/\n}}}(\n|$)/);
        if (endMatch && endMatch.index !== undefined) {
            const jsonContent = trimmed.slice(3, endMatch.index + 3);
            const remaining = trimmed.slice(endMatch.index + 3 + endMatch[0].length);
            return {
                frontMatter: JSON.parse(jsonContent),
                content: remaining,
            };
        }
    }
    return null;
}
/**
 * Format a QueryValue for output in the given format
 */
export function formatOutput(value, options) {
    if (value === undefined)
        return "";
    switch (options.outputFormat) {
        case "yaml":
            return YAML.stringify(value, {
                indent: options.indent,
            }).trimEnd();
        case "json": {
            if (options.raw && typeof value === "string") {
                return value;
            }
            if (options.compact) {
                return JSON.stringify(value);
            }
            return JSON.stringify(value, null, options.indent);
        }
        case "xml": {
            const builder = new XMLBuilder({
                ignoreAttributes: false,
                attributeNamePrefix: options.xmlAttributePrefix,
                textNodeName: options.xmlContentName,
                format: options.prettyPrint || !options.compact,
                indentBy: " ".repeat(options.indent),
            });
            return builder.build(value);
        }
        case "ini": {
            if (!value || typeof value !== "object" || Array.isArray(value)) {
                return "";
            }
            return ini.stringify(value);
        }
        case "csv":
            return formatCsv(value, options.csvDelimiter);
        case "toml": {
            if (!value || typeof value !== "object" || Array.isArray(value)) {
                return "";
            }
            return TOML.stringify(value);
        }
        default:
            throw new Error(`Unknown output format: ${options.outputFormat}`);
    }
}
