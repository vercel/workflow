import type { EvalContext, EvalResult, Expression } from "./types.js";
/**
 * Evaluate a find expression and return both match result and prune flag.
 * The prune flag is set when -prune is evaluated and returns true.
 */
export declare function evaluateExpressionWithPrune(expr: Expression, ctx: EvalContext): EvalResult;
/**
 * Check if an expression needs full stat metadata (size, mtime, mode)
 * vs just type info (isFile/isDirectory) which can come from dirent
 */
export declare function expressionNeedsStatMetadata(expr: Expression | null): boolean;
/**
 * Check if an expression uses -empty (needs directory entry count)
 */
export declare function expressionNeedsEmptyCheck(expr: Expression | null): boolean;
/**
 * Analyze a path expression for pruning opportunities.
 * For patterns like "*\/pulls\/*.json", we can skip descending into "pulls" subdirectories
 * since files must be directly inside "pulls".
 */
export interface PathPruningHint {
    /** If set, when in a directory with this name, don't descend into subdirs */
    terminalDirName: string | null;
    /** If set, files must have this extension (e.g., ".json") */
    requiredExtension: string | null;
}
/**
 * Extract path pruning hints from an expression tree.
 * Returns hints that can be used to skip unnecessary directory traversal.
 */
export declare function extractPathPruningHints(expr: Expression | null): PathPruningHint;
export declare function collectNewerRefs(expr: Expression | null): string[];
/**
 * Context for early prune evaluation (before readdir).
 * Only includes info available without reading directory contents or stat.
 */
export interface EarlyEvalContext {
    name: string;
    relativePath: string;
    isFile: boolean;
    isDirectory: boolean;
}
/**
 * Check if an expression is "simple" - only uses name/path/regex/type/prune/print.
 * Simple expressions can be evaluated without creating EvalContext objects.
 */
export declare function isSimpleExpression(expr: Expression | null): boolean;
/**
 * Fast-path evaluator for simple expressions.
 * Avoids creating EvalContext objects by taking arguments directly.
 * Only use this when isSimpleExpression() returns true.
 */
export declare function evaluateSimpleExpression(expr: Expression, name: string, relativePath: string, isFile: boolean, isDirectory: boolean): EvalResult;
/**
 * Check if an expression contains -prune and can potentially be evaluated
 * early (before readdir) to avoid unnecessary I/O.
 */
export declare function expressionHasPrune(expr: Expression | null): boolean;
/**
 * Evaluate an expression for early prune detection.
 * Returns { shouldPrune: true } if we should skip reading this directory.
 * Returns { shouldPrune: false } if we can't determine or shouldn't prune.
 *
 * This is used to avoid reading directory contents when we know we'll prune.
 * For expressions that need stat info, we conservatively return false.
 */
export declare function evaluateForEarlyPrune(expr: Expression | null, ctx: EarlyEvalContext): {
    shouldPrune: boolean;
};
