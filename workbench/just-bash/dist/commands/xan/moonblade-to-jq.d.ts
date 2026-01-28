/**
 * Transform moonblade AST to jq AST
 *
 * This module converts moonblade expressions (xan's expression language)
 * to jq AST for evaluation by the shared query engine.
 */
import type { AstNode } from "../query-engine/parser.js";
import type { MoonbladeExpr } from "./moonblade-parser.js";
/**
 * Transform moonblade AST to jq AST
 */
export declare function moonbladeToJq(expr: MoonbladeExpr, rowContext?: boolean): AstNode;
