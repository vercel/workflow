/**
 * Command Parser
 *
 * Handles parsing of simple commands, redirections, and assignments.
 */
import { type RedirectionNode, type SimpleCommandNode } from "../ast/types.js";
import type { Parser } from "./parser.js";
export declare function isRedirection(p: Parser): boolean;
export declare function parseRedirection(p: Parser): RedirectionNode;
export declare function parseSimpleCommand(p: Parser): SimpleCommandNode;
