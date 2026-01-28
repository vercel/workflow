export type Expression = {
    type: "name";
    pattern: string;
    ignoreCase?: boolean;
} | {
    type: "path";
    pattern: string;
    ignoreCase?: boolean;
} | {
    type: "regex";
    pattern: string;
    ignoreCase?: boolean;
} | {
    type: "type";
    fileType: "f" | "d";
} | {
    type: "empty";
} | {
    type: "mtime";
    days: number;
    comparison: "exact" | "more" | "less";
} | {
    type: "newer";
    refPath: string;
} | {
    type: "size";
    value: number;
    unit: SizeUnit;
    comparison: "exact" | "more" | "less";
} | {
    type: "perm";
    mode: number;
    matchType: "exact" | "all" | "any";
} | {
    type: "prune";
} | {
    type: "print";
} | {
    type: "not";
    expr: Expression;
} | {
    type: "and";
    left: Expression;
    right: Expression;
} | {
    type: "or";
    left: Expression;
    right: Expression;
};
export type SizeUnit = "c" | "k" | "M" | "G" | "b";
export type FindAction = {
    type: "exec";
    command: string[];
    batchMode: boolean;
} | {
    type: "print";
} | {
    type: "print0";
} | {
    type: "printf";
    format: string;
} | {
    type: "delete";
};
export interface EvalContext {
    name: string;
    relativePath: string;
    isFile: boolean;
    isDirectory: boolean;
    isEmpty: boolean;
    mtime: number;
    size: number;
    mode: number;
    newerRefTimes: Map<string, number>;
    depth?: number;
    startingPoint?: string;
}
export interface EvalResult {
    matches: boolean;
    pruned: boolean;
    printed: boolean;
}
export interface ParseResult {
    expr: Expression | null;
    pathIndex: number;
    error?: string;
    actions: FindAction[];
}
