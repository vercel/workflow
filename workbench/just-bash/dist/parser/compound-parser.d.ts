/**
 * Compound Command Parser
 *
 * Handles parsing of compound commands: if, for, while, until, case, subshell, group.
 */
import { type CaseNode, type CStyleForNode, type ForNode, type GroupNode, type IfNode, type SubshellNode, type UntilNode, type WhileNode } from "../ast/types.js";
import type { Parser } from "./parser.js";
export declare function parseIf(p: Parser, options?: {
    skipRedirections?: boolean;
}): IfNode;
export declare function parseFor(p: Parser, options?: {
    skipRedirections?: boolean;
}): ForNode | CStyleForNode;
export declare function parseWhile(p: Parser, options?: {
    skipRedirections?: boolean;
}): WhileNode;
export declare function parseUntil(p: Parser, options?: {
    skipRedirections?: boolean;
}): UntilNode;
export declare function parseCase(p: Parser, options?: {
    skipRedirections?: boolean;
}): CaseNode;
export declare function parseSubshell(p: Parser, options?: {
    skipRedirections?: boolean;
}): SubshellNode | CStyleForNode;
export declare function parseGroup(p: Parser, options?: {
    skipRedirections?: boolean;
}): GroupNode;
