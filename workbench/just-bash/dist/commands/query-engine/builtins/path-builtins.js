/**
 * Path-related jq builtins
 *
 * Handles path manipulation functions like getpath, setpath, delpaths, paths, etc.
 */
/**
 * Handle path builtins that need evaluate function for arguments.
 * Returns null if the builtin name is not a path builtin handled here.
 */
export function evalPathBuiltin(value, name, args, ctx, evaluate, isTruthy, setPath, deletePath, applyDel, collectPaths) {
    switch (name) {
        case "getpath": {
            if (args.length === 0)
                return [null];
            const paths = evaluate(value, args[0], ctx);
            // Handle multiple paths (generator argument)
            const results = [];
            for (const pathVal of paths) {
                const path = pathVal;
                let current = value;
                for (const key of path) {
                    if (current === null || current === undefined) {
                        current = null;
                        break;
                    }
                    if (Array.isArray(current) && typeof key === "number") {
                        current = current[key];
                    }
                    else if (typeof current === "object" && typeof key === "string") {
                        current = current[key];
                    }
                    else {
                        current = null;
                        break;
                    }
                }
                results.push(current);
            }
            return results;
        }
        case "setpath": {
            if (args.length < 2)
                return [null];
            const paths = evaluate(value, args[0], ctx);
            const path = paths[0];
            const vals = evaluate(value, args[1], ctx);
            const newVal = vals[0];
            return [setPath(value, path, newVal)];
        }
        case "delpaths": {
            if (args.length === 0)
                return [value];
            const pathLists = evaluate(value, args[0], ctx);
            const paths = pathLists[0];
            let result = value;
            for (const path of paths.sort((a, b) => b.length - a.length)) {
                result = deletePath(result, path);
            }
            return [result];
        }
        case "path": {
            if (args.length === 0)
                return [[]];
            const paths = [];
            collectPaths(value, args[0], ctx, [], paths);
            return paths;
        }
        case "del": {
            if (args.length === 0)
                return [value];
            return [applyDel(value, args[0], ctx)];
        }
        case "pick": {
            if (args.length === 0)
                return [null];
            // pick uses path() to get paths, then builds an object with just those paths
            // Collect paths from each argument
            const allPaths = [];
            for (const arg of args) {
                collectPaths(value, arg, ctx, [], allPaths);
            }
            // Build result object with only the picked paths
            let result = null;
            for (const path of allPaths) {
                // Check for negative indices which are not allowed
                for (const key of path) {
                    if (typeof key === "number" && key < 0) {
                        throw new Error("Out of bounds negative array index");
                    }
                }
                // Get the value at this path from the input
                let current = value;
                for (const key of path) {
                    if (current === null || current === undefined)
                        break;
                    if (Array.isArray(current) && typeof key === "number") {
                        current = current[key];
                    }
                    else if (typeof current === "object" && typeof key === "string") {
                        current = current[key];
                    }
                    else {
                        current = null;
                        break;
                    }
                }
                // Set the value in the result
                result = setPath(result, path, current);
            }
            return [result];
        }
        case "paths": {
            const paths = [];
            const walk = (v, path) => {
                if (v && typeof v === "object") {
                    if (Array.isArray(v)) {
                        for (let i = 0; i < v.length; i++) {
                            paths.push([...path, i]);
                            walk(v[i], [...path, i]);
                        }
                    }
                    else {
                        for (const key of Object.keys(v)) {
                            paths.push([...path, key]);
                            walk(v[key], [...path, key]);
                        }
                    }
                }
            };
            walk(value, []);
            if (args.length > 0) {
                return paths.filter((p) => {
                    let v = value;
                    for (const k of p) {
                        if (Array.isArray(v) && typeof k === "number") {
                            v = v[k];
                        }
                        else if (v && typeof v === "object" && typeof k === "string") {
                            v = v[k];
                        }
                        else {
                            return false;
                        }
                    }
                    const results = evaluate(v, args[0], ctx);
                    return results.some(isTruthy);
                });
            }
            return paths;
        }
        case "leaf_paths": {
            const paths = [];
            const walk = (v, path) => {
                if (v === null || typeof v !== "object") {
                    paths.push(path);
                }
                else if (Array.isArray(v)) {
                    for (let i = 0; i < v.length; i++) {
                        walk(v[i], [...path, i]);
                    }
                }
                else {
                    for (const key of Object.keys(v)) {
                        walk(v[key], [...path, key]);
                    }
                }
            };
            walk(value, []);
            // Return each path as a separate output (like paths does)
            return paths;
        }
        default:
            return null;
    }
}
