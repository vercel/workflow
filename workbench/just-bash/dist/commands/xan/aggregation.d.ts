/**
 * Aggregation functions for xan command
 */
import { type EvaluateOptions } from "../query-engine/index.js";
import type { CsvData, CsvRow } from "./csv.js";
/** Aggregation specification from parsed expression */
export interface AggSpec {
    func: string;
    expr: string;
    alias: string;
}
/**
 * Parse aggregation expression: "func(expr) as alias" or "func(expr)"
 * Handles nested parentheses in expressions like sum(add(a, b))
 */
export declare function parseAggExpr(expr: string): AggSpec[];
/** Compute aggregation on data */
export declare function computeAgg(data: CsvData, spec: AggSpec, evalOptions?: EvaluateOptions): number | string | boolean | null;
/** Build aggregation result row */
export declare function buildAggRow(data: CsvData, specs: AggSpec[], evalOptions?: EvaluateOptions): CsvRow;
