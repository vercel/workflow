/**
 * Aggregation functions for xan command
 */
import { evaluate } from "../query-engine/index.js";
import { parseMoonblade } from "./moonblade-parser.js";
import { moonbladeToJq } from "./moonblade-to-jq.js";
/**
 * Parse aggregation expression: "func(expr) as alias" or "func(expr)"
 * Handles nested parentheses in expressions like sum(add(a, b))
 */
export function parseAggExpr(expr) {
    const specs = [];
    let i = 0;
    while (i < expr.length) {
        // Skip whitespace and commas
        while (i < expr.length && (expr[i] === " " || expr[i] === ","))
            i++;
        if (i >= expr.length)
            break;
        // Parse function name
        const funcStart = i;
        while (i < expr.length && /\w/.test(expr[i]))
            i++;
        const func = expr.slice(funcStart, i);
        // Skip whitespace
        while (i < expr.length && expr[i] === " ")
            i++;
        // Expect opening paren
        if (expr[i] !== "(")
            break;
        i++; // skip (
        // Parse expression inside parens (handling nested parens)
        let parenDepth = 1;
        const exprStart = i;
        while (i < expr.length && parenDepth > 0) {
            if (expr[i] === "(")
                parenDepth++;
            else if (expr[i] === ")")
                parenDepth--;
            if (parenDepth > 0)
                i++;
        }
        const innerExpr = expr.slice(exprStart, i).trim();
        i++; // skip )
        // Skip whitespace
        while (i < expr.length && expr[i] === " ")
            i++;
        // Check for "as alias"
        let alias = "";
        if (expr.slice(i, i + 3).toLowerCase() === "as ") {
            i += 3;
            while (i < expr.length && expr[i] === " ")
                i++;
            const aliasStart = i;
            while (i < expr.length && /\w/.test(expr[i]))
                i++;
            alias = expr.slice(aliasStart, i);
        }
        // Default alias preserves original syntax
        if (!alias) {
            alias = innerExpr ? `${func}(${innerExpr})` : `${func}()`;
        }
        specs.push({ func, expr: innerExpr, alias });
    }
    return specs;
}
/** Check if expression is a simple column reference */
function isSimpleColumn(expr) {
    return /^\w+$/.test(expr);
}
/** Evaluate a moonblade expression for a row */
function evalExpr(row, expr, evalOptions) {
    const ast = moonbladeToJq(parseMoonblade(expr));
    const results = evaluate(row, ast, evalOptions);
    return results.length > 0 ? results[0] : null;
}
/** Compute aggregation on data */
export function computeAgg(data, spec, evalOptions = {}) {
    const { func, expr } = spec;
    // Special case: count() with no expression
    if (func === "count" && !expr) {
        return data.length;
    }
    // Get values - either simple column access or expression evaluation
    let values;
    if (isSimpleColumn(expr)) {
        values = data
            .map((r) => r[expr])
            .filter((v) => v !== null && v !== undefined);
    }
    else {
        // Complex expression - evaluate for each row
        values = data
            .map((r) => evalExpr(r, expr, evalOptions))
            .filter((v) => v !== null && v !== undefined);
    }
    switch (func) {
        case "count": {
            // count(expr) - count rows where expression is truthy
            if (isSimpleColumn(expr)) {
                return values.length;
            }
            // For expressions like count(n > 2), count truthy values
            return values.filter((v) => !!v).length;
        }
        case "sum": {
            const nums = values.map((v) => typeof v === "number" ? v : Number.parseFloat(String(v)));
            return nums.reduce((a, b) => a + b, 0);
        }
        case "mean":
        case "avg": {
            const nums = values.map((v) => typeof v === "number" ? v : Number.parseFloat(String(v)));
            return nums.length > 0
                ? nums.reduce((a, b) => a + b, 0) / nums.length
                : 0;
        }
        case "min": {
            const nums = values.map((v) => typeof v === "number" ? v : Number.parseFloat(String(v)));
            return nums.length > 0 ? Math.min(...nums) : null;
        }
        case "max": {
            const nums = values.map((v) => typeof v === "number" ? v : Number.parseFloat(String(v)));
            return nums.length > 0 ? Math.max(...nums) : null;
        }
        case "first":
            return values.length > 0 ? values[0] : null;
        case "last":
            return values.length > 0
                ? values[values.length - 1]
                : null;
        case "median": {
            const nums = values
                .map((v) => (typeof v === "number" ? v : Number.parseFloat(String(v))))
                .filter((n) => !Number.isNaN(n))
                .sort((a, b) => a - b);
            if (nums.length === 0)
                return null;
            const mid = Math.floor(nums.length / 2);
            if (nums.length % 2 === 0) {
                return (nums[mid - 1] + nums[mid]) / 2;
            }
            return nums[mid];
        }
        case "mode": {
            const counts = new Map();
            for (const v of values) {
                const key = String(v);
                counts.set(key, (counts.get(key) || 0) + 1);
            }
            let maxCount = 0;
            let mode = null;
            for (const [val, count] of counts) {
                if (count > maxCount) {
                    maxCount = count;
                    mode = val;
                }
            }
            return mode;
        }
        case "cardinality": {
            const unique = new Set(values.map((v) => String(v)));
            return unique.size;
        }
        case "values": {
            return values.map((v) => String(v)).join("|");
        }
        case "distinct_values": {
            const unique = [...new Set(values.map((v) => String(v)))].sort();
            return unique.join("|");
        }
        case "all": {
            // all(expr) - check if all rows have truthy value for expression
            if (data.length === 0)
                return true;
            for (const row of data) {
                const result = evalExpr(row, expr, evalOptions);
                if (!result)
                    return false;
            }
            return true;
        }
        case "any": {
            // any(expr) - check if any row has truthy value for expression
            for (const row of data) {
                const result = evalExpr(row, expr, evalOptions);
                if (result)
                    return true;
            }
            return false;
        }
        default:
            return null;
    }
}
/** Build aggregation result row */
export function buildAggRow(data, specs, evalOptions = {}) {
    const row = {};
    for (const spec of specs) {
        row[spec.alias] = computeAgg(data, spec, evalOptions);
    }
    return row;
}
