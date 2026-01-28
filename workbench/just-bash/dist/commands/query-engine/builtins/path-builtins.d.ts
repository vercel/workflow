/**
 * Path-related jq builtins
 *
 * Handles path manipulation functions like getpath, setpath, delpaths, paths, etc.
 */
import type { EvalContext } from "../evaluator.js";
import type { AstNode } from "../parser.js";
import type { QueryValue } from "../value-operations.js";
type EvalFn = (value: QueryValue, ast: AstNode, ctx: EvalContext) => QueryValue[];
type IsTruthyFn = (v: QueryValue) => boolean;
type SetPathFn = (obj: QueryValue, path: (string | number)[], val: QueryValue) => QueryValue;
type DeletePathFn = (obj: QueryValue, path: (string | number)[]) => QueryValue;
type ApplyDelFn = (value: QueryValue, expr: AstNode, ctx: EvalContext) => QueryValue;
type CollectPathsFn = (value: QueryValue, expr: AstNode, ctx: EvalContext, currentPath: (string | number)[], paths: (string | number)[][]) => void;
/**
 * Handle path builtins that need evaluate function for arguments.
 * Returns null if the builtin name is not a path builtin handled here.
 */
export declare function evalPathBuiltin(value: QueryValue, name: string, args: AstNode[], ctx: EvalContext, evaluate: EvalFn, isTruthy: IsTruthyFn, setPath: SetPathFn, deletePath: DeletePathFn, applyDel: ApplyDelFn, collectPaths: CollectPathsFn): QueryValue[] | null;
export {};
