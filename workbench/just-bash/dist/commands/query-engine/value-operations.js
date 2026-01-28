/**
 * Query Value Utilities
 *
 * Utility functions for working with jq/query values.
 */
/**
 * Check if a value is truthy in jq semantics.
 * In jq: false and null are falsy, everything else is truthy.
 */
export function isTruthy(v) {
    return v !== false && v !== null;
}
/**
 * Deep equality check for query values.
 */
export function deepEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}
/**
 * Compare two values for sorting.
 * Returns negative if a < b, positive if a > b, 0 if equal.
 */
export function compare(a, b) {
    if (typeof a === "number" && typeof b === "number")
        return a - b;
    if (typeof a === "string" && typeof b === "string")
        return a.localeCompare(b);
    return 0;
}
/**
 * Deep merge two objects.
 * Values from b override values from a, except nested objects are merged recursively.
 */
export function deepMerge(a, b) {
    const result = { ...a };
    for (const key of Object.keys(b)) {
        if (key in result &&
            result[key] &&
            typeof result[key] === "object" &&
            !Array.isArray(result[key]) &&
            b[key] &&
            typeof b[key] === "object" &&
            !Array.isArray(b[key])) {
            result[key] = deepMerge(result[key], b[key]);
        }
        else {
            result[key] = b[key];
        }
    }
    return result;
}
/**
 * Calculate the nesting depth of a value (array or object).
 */
export function getValueDepth(value, maxCheck = 3000) {
    let depth = 0;
    let current = value;
    while (depth < maxCheck) {
        if (Array.isArray(current)) {
            if (current.length === 0)
                return depth + 1;
            current = current[0];
            depth++;
        }
        else if (current !== null && typeof current === "object") {
            const keys = Object.keys(current);
            if (keys.length === 0)
                return depth + 1;
            current = current[keys[0]];
            depth++;
        }
        else {
            return depth;
        }
    }
    return depth;
}
/**
 * Compare two values using jq's comparison semantics.
 * jq sorts by type first (null < bool < number < string < array < object),
 * then by value within type.
 */
export function compareJq(a, b) {
    const typeOrder = (v) => {
        if (v === null)
            return 0;
        if (typeof v === "boolean")
            return 1;
        if (typeof v === "number")
            return 2;
        if (typeof v === "string")
            return 3;
        if (Array.isArray(v))
            return 4;
        if (typeof v === "object")
            return 5;
        return 6;
    };
    const ta = typeOrder(a);
    const tb = typeOrder(b);
    if (ta !== tb)
        return ta - tb;
    if (typeof a === "number" && typeof b === "number")
        return a - b;
    if (typeof a === "string" && typeof b === "string")
        return a.localeCompare(b);
    if (typeof a === "boolean" && typeof b === "boolean")
        return (a ? 1 : 0) - (b ? 1 : 0);
    if (Array.isArray(a) && Array.isArray(b)) {
        for (let i = 0; i < Math.min(a.length, b.length); i++) {
            const cmp = compareJq(a[i], b[i]);
            if (cmp !== 0)
                return cmp;
        }
        return a.length - b.length;
    }
    // Objects: compare by sorted keys, then values
    if (a && b && typeof a === "object" && typeof b === "object") {
        const aObj = a;
        const bObj = b;
        const aKeys = Object.keys(aObj).sort();
        const bKeys = Object.keys(bObj).sort();
        // First compare keys
        for (let i = 0; i < Math.min(aKeys.length, bKeys.length); i++) {
            const keyCmp = aKeys[i].localeCompare(bKeys[i]);
            if (keyCmp !== 0)
                return keyCmp;
        }
        if (aKeys.length !== bKeys.length)
            return aKeys.length - bKeys.length;
        // Then compare values for each key
        for (const key of aKeys) {
            const cmp = compareJq(aObj[key], bObj[key]);
            if (cmp !== 0)
                return cmp;
        }
    }
    return 0;
}
/**
 * Check if value a contains value b using jq's containment semantics.
 */
export function containsDeep(a, b) {
    if (deepEqual(a, b))
        return true;
    // jq: string contains substring check
    if (typeof a === "string" && typeof b === "string") {
        return a.includes(b);
    }
    if (Array.isArray(a) && Array.isArray(b)) {
        return b.every((bItem) => a.some((aItem) => containsDeep(aItem, bItem)));
    }
    if (a &&
        b &&
        typeof a === "object" &&
        typeof b === "object" &&
        !Array.isArray(a) &&
        !Array.isArray(b)) {
        const aObj = a;
        const bObj = b;
        return Object.keys(bObj).every((k) => k in aObj && containsDeep(aObj[k], bObj[k]));
    }
    return false;
}
