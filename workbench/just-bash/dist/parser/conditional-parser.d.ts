/**
 * Conditional Expression Parser
 *
 * Handles parsing of [[ ... ]] conditional commands.
 */
import type { ConditionalExpressionNode } from "../ast/types.js";
import type { Parser } from "./parser.js";
export declare function parseConditionalExpression(p: Parser): ConditionalExpressionNode;
