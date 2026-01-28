/**
 * Moonblade expression parser for xan
 *
 * Parses moonblade expressions (xan's expression language) and transforms
 * them to jq AST for evaluation by the shared query engine.
 *
 * Grammar based on xan's grammar.pest
 */
export type MoonbladeExpr = {
    type: "int";
    value: number;
} | {
    type: "float";
    value: number;
} | {
    type: "string";
    value: string;
} | {
    type: "bool";
    value: boolean;
} | {
    type: "null";
} | {
    type: "identifier";
    name: string;
    unsure: boolean;
} | {
    type: "underscore";
} | {
    type: "func";
    name: string;
    args: Array<{
        name?: string;
        expr: MoonbladeExpr;
    }>;
} | {
    type: "list";
    elements: MoonbladeExpr[];
} | {
    type: "map";
    entries: Array<{
        key: string;
        value: MoonbladeExpr;
    }>;
} | {
    type: "regex";
    pattern: string;
    caseInsensitive: boolean;
} | {
    type: "slice";
    start?: MoonbladeExpr;
    end?: MoonbladeExpr;
} | {
    type: "lambda";
    params: string[];
    body: MoonbladeExpr;
} | {
    type: "lambdaBinding";
    name: string;
} | {
    type: "pipeline";
    exprs: MoonbladeExpr[];
};
export interface NamedExpr {
    expr: MoonbladeExpr;
    name: string | string[];
}
export interface Aggregation {
    aggName: string;
    funcName: string;
    args: MoonbladeExpr[];
}
/**
 * Parse named expressions like: "expr1, expr2 as name, expr3 as (a, b)"
 */
export declare function parseNamedExpressions(input: string): NamedExpr[];
/**
 * Parse a moonblade expression string into AST
 */
export declare function parseMoonblade(input: string): MoonbladeExpr;
