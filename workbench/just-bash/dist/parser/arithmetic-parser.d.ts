/**
 * Arithmetic Expression Parser
 *
 * Parses bash arithmetic expressions like:
 * - $((1 + 2))
 * - $((x++))
 * - $((a ? b : c))
 * - $((2#1010))
 *
 * All functions take a Parser instance as the first argument for shared state access.
 */
import type { ArithExpr, ArithmeticExpressionNode } from "../ast/types.js";
import { parseArithNumber } from "./arithmetic-primaries.js";
import type { Parser } from "./parser.js";
export { parseArithNumber };
/**
 * Parse an arithmetic expression string into an AST node
 */
export declare function parseArithmeticExpression(_p: Parser, input: string): ArithmeticExpressionNode;
export declare function parseArithExpr(p: Parser, input: string, pos: number): {
    expr: ArithExpr;
    pos: number;
};
