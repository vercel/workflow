/**
 * Expansion Parser
 *
 * Handles parsing of parameter expansions, arithmetic expansions, etc.
 */
import { type WordPart } from "../ast/types.js";
import type { Parser } from "./parser.js";
export declare function parseWordParts(p: Parser, value: string, quoted?: boolean, singleQuoted?: boolean, isAssignment?: boolean, hereDoc?: boolean, 
/** When true, single quotes are treated as literal characters, not quote delimiters */
singleQuotesAreLiteral?: boolean, 
/** When true, brace expansion is disabled (used in [[ ]] conditionals) */
noBraceExpansion?: boolean, 
/** When true, all backslash escapes create Escaped nodes (for regex patterns in [[ =~ ]]) */
regexPattern?: boolean, 
/** When true, \} is treated as escaped } (used in parameter expansion default values) */
inParameterExpansion?: boolean): WordPart[];
