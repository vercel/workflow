/**
 * Shared utilities for xan subcommands
 */
import type { AstNode } from "../query-engine/parser.js";
/**
 * Parse a moonblade expression and transform to jq AST
 */
export declare function parseMoonbladeExpr(expr: string): AstNode;
/**
 * Parse column specification which can include:
 * - Column names (e.g., "name,email")
 * - Column indices (e.g., "0,2")
 * - Numeric ranges (e.g., "0-2" means columns 0, 1, 2)
 * - Column name ranges (e.g., "name:email" means columns from name to email)
 * - Glob patterns (e.g., "vec_*", "*_count")
 * - Negation (e.g., "!name" excludes column)
 * Returns an array of column names
 */
export declare function parseColumnSpec(spec: string, headers: string[]): string[];
