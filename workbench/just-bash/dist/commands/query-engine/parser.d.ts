/**
 * Query expression parser
 *
 * Tokenizes and parses jq-style filter expressions into an AST.
 * Used by jq, yq, and other query-based commands.
 */
export type { ArrayNode, AstNode, BinaryOpNode, BreakNode, CallNode, CommaNode, CondNode, DefNode, DestructurePattern, FieldNode, ForeachNode, IdentityNode, IndexNode, IterateNode, LabelNode, LiteralNode, ObjectNode, OptionalNode, ParenNode, PipeNode, RecurseNode, ReduceNode, SliceNode, StringInterpNode, Token, TokenType, TryNode, UnaryOpNode, UpdateOpNode, VarBindNode, VarRefNode, } from "./parser-types.js";
import type { AstNode } from "./parser-types.js";
export declare function parse(input: string): AstNode;
