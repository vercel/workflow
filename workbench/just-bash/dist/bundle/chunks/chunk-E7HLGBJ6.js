import {
  ExecutionLimitError
} from "./chunk-KRBYMBZY.js";
import {
  __name
} from "./chunk-Y7IWVHJ4.js";

// dist/commands/query-engine/builtins/array-builtins.js
function evalArrayBuiltin(value, name, args, ctx, evaluate2, evaluateWithPartialResults2, compareJq2, isTruthy2, containsDeep2, ExecutionLimitError2) {
  switch (name) {
    case "sort":
      if (Array.isArray(value))
        return [[...value].sort(compareJq2)];
      return [null];
    case "sort_by": {
      if (!Array.isArray(value) || args.length === 0)
        return [null];
      const sorted = [...value].sort((a, b) => {
        const aKey = evaluate2(a, args[0], ctx)[0];
        const bKey = evaluate2(b, args[0], ctx)[0];
        return compareJq2(aKey, bKey);
      });
      return [sorted];
    }
    case "bsearch": {
      if (!Array.isArray(value)) {
        const typeName = value === null ? "null" : typeof value === "object" ? "object" : typeof value;
        throw new Error(`${typeName} (${JSON.stringify(value)}) cannot be searched from`);
      }
      if (args.length === 0)
        return [null];
      const targets = evaluate2(value, args[0], ctx);
      return targets.map((target) => {
        let lo = 0;
        let hi = value.length;
        while (lo < hi) {
          const mid = lo + hi >>> 1;
          const cmp = compareJq2(value[mid], target);
          if (cmp < 0) {
            lo = mid + 1;
          } else {
            hi = mid;
          }
        }
        if (lo < value.length && compareJq2(value[lo], target) === 0) {
          return lo;
        }
        return -lo - 1;
      });
    }
    case "unique_by": {
      if (!Array.isArray(value) || args.length === 0)
        return [null];
      const seen = /* @__PURE__ */ new Map();
      for (const item of value) {
        const keyVal = evaluate2(item, args[0], ctx)[0];
        const keyStr = JSON.stringify(keyVal);
        if (!seen.has(keyStr)) {
          seen.set(keyStr, { item, key: keyVal });
        }
      }
      const entries = [...seen.values()];
      entries.sort((a, b) => compareJq2(a.key, b.key));
      return [entries.map((e) => e.item)];
    }
    case "group_by": {
      if (!Array.isArray(value) || args.length === 0)
        return [null];
      const groups = /* @__PURE__ */ new Map();
      for (const item of value) {
        const key = JSON.stringify(evaluate2(item, args[0], ctx)[0]);
        if (!groups.has(key))
          groups.set(key, []);
        groups.get(key)?.push(item);
      }
      return [[...groups.values()]];
    }
    case "max":
      if (Array.isArray(value) && value.length > 0) {
        return [value.reduce((a, b) => compareJq2(a, b) > 0 ? a : b)];
      }
      return [null];
    case "max_by": {
      if (!Array.isArray(value) || value.length === 0 || args.length === 0)
        return [null];
      return [
        value.reduce((a, b) => {
          const aKey = evaluate2(a, args[0], ctx)[0];
          const bKey = evaluate2(b, args[0], ctx)[0];
          return compareJq2(aKey, bKey) > 0 ? a : b;
        })
      ];
    }
    case "min":
      if (Array.isArray(value) && value.length > 0) {
        return [value.reduce((a, b) => compareJq2(a, b) < 0 ? a : b)];
      }
      return [null];
    case "min_by": {
      if (!Array.isArray(value) || value.length === 0 || args.length === 0)
        return [null];
      return [
        value.reduce((a, b) => {
          const aKey = evaluate2(a, args[0], ctx)[0];
          const bKey = evaluate2(b, args[0], ctx)[0];
          return compareJq2(aKey, bKey) < 0 ? a : b;
        })
      ];
    }
    case "add": {
      const addValues = /* @__PURE__ */ __name((arr) => {
        const filtered = arr.filter((x) => x !== null);
        if (filtered.length === 0)
          return null;
        if (filtered.every((x) => typeof x === "number")) {
          return filtered.reduce((a, b) => a + b, 0);
        }
        if (filtered.every((x) => typeof x === "string")) {
          return filtered.join("");
        }
        if (filtered.every((x) => Array.isArray(x))) {
          return filtered.flat();
        }
        if (filtered.every((x) => x && typeof x === "object" && !Array.isArray(x))) {
          return Object.assign({}, ...filtered);
        }
        return null;
      }, "addValues");
      if (args.length >= 1) {
        const collected = evaluate2(value, args[0], ctx);
        return [addValues(collected)];
      }
      if (Array.isArray(value)) {
        return [addValues(value)];
      }
      return [null];
    }
    case "any": {
      if (args.length >= 2) {
        try {
          const genValues = evaluateWithPartialResults2(value, args[0], ctx);
          for (const v of genValues) {
            const cond = evaluate2(v, args[1], ctx);
            if (cond.some(isTruthy2))
              return [true];
          }
        } catch (e) {
          if (e instanceof ExecutionLimitError2)
            throw e;
        }
        return [false];
      }
      if (args.length === 1) {
        if (Array.isArray(value)) {
          return [
            value.some((item) => isTruthy2(evaluate2(item, args[0], ctx)[0]))
          ];
        }
        return [false];
      }
      if (Array.isArray(value))
        return [value.some(isTruthy2)];
      return [false];
    }
    case "all": {
      if (args.length >= 2) {
        try {
          const genValues = evaluateWithPartialResults2(value, args[0], ctx);
          for (const v of genValues) {
            const cond = evaluate2(v, args[1], ctx);
            if (!cond.some(isTruthy2))
              return [false];
          }
        } catch (e) {
          if (e instanceof ExecutionLimitError2)
            throw e;
        }
        return [true];
      }
      if (args.length === 1) {
        if (Array.isArray(value)) {
          return [
            value.every((item) => isTruthy2(evaluate2(item, args[0], ctx)[0]))
          ];
        }
        return [true];
      }
      if (Array.isArray(value))
        return [value.every(isTruthy2)];
      return [true];
    }
    case "select": {
      if (args.length === 0)
        return [value];
      const conds = evaluate2(value, args[0], ctx);
      return conds.some(isTruthy2) ? [value] : [];
    }
    case "map": {
      if (args.length === 0 || !Array.isArray(value))
        return [null];
      const results = value.flatMap((item) => evaluate2(item, args[0], ctx));
      return [results];
    }
    case "map_values": {
      if (args.length === 0)
        return [null];
      if (Array.isArray(value)) {
        return [value.flatMap((item) => evaluate2(item, args[0], ctx))];
      }
      if (value && typeof value === "object") {
        const result = {};
        for (const [k, v] of Object.entries(value)) {
          const mapped = evaluate2(v, args[0], ctx);
          if (mapped.length > 0)
            result[k] = mapped[0];
        }
        return [result];
      }
      return [null];
    }
    case "has": {
      if (args.length === 0)
        return [false];
      const keys = evaluate2(value, args[0], ctx);
      const key = keys[0];
      if (Array.isArray(value) && typeof key === "number") {
        return [key >= 0 && key < value.length];
      }
      if (value && typeof value === "object" && typeof key === "string") {
        return [key in value];
      }
      return [false];
    }
    case "in": {
      if (args.length === 0)
        return [false];
      const objs = evaluate2(value, args[0], ctx);
      const obj = objs[0];
      if (Array.isArray(obj) && typeof value === "number") {
        return [value >= 0 && value < obj.length];
      }
      if (obj && typeof obj === "object" && typeof value === "string") {
        return [value in obj];
      }
      return [false];
    }
    case "contains": {
      if (args.length === 0)
        return [false];
      const others = evaluate2(value, args[0], ctx);
      return [containsDeep2(value, others[0])];
    }
    case "inside": {
      if (args.length === 0)
        return [false];
      const others = evaluate2(value, args[0], ctx);
      return [containsDeep2(others[0], value)];
    }
    default:
      return null;
  }
}
__name(evalArrayBuiltin, "evalArrayBuiltin");

// dist/commands/query-engine/builtins/control-builtins.js
function evalControlBuiltin(value, name, args, ctx, evaluate2, evaluateWithPartialResults2, isTruthy2, ExecutionLimitError2) {
  switch (name) {
    case "first":
      if (args.length > 0) {
        try {
          const results = evaluateWithPartialResults2(value, args[0], ctx);
          return results.length > 0 ? [results[0]] : [];
        } catch (e) {
          if (e instanceof ExecutionLimitError2)
            throw e;
          return [];
        }
      }
      if (Array.isArray(value) && value.length > 0)
        return [value[0]];
      return [null];
    case "last":
      if (args.length > 0) {
        const results = evaluate2(value, args[0], ctx);
        return results.length > 0 ? [results[results.length - 1]] : [];
      }
      if (Array.isArray(value) && value.length > 0)
        return [value[value.length - 1]];
      return [null];
    case "nth": {
      if (args.length < 1)
        return [null];
      const ns = evaluate2(value, args[0], ctx);
      if (args.length > 1) {
        for (const nv of ns) {
          const n = nv;
          if (n < 0) {
            throw new Error("nth doesn't support negative indices");
          }
        }
        let results;
        try {
          results = evaluateWithPartialResults2(value, args[1], ctx);
        } catch (e) {
          if (e instanceof ExecutionLimitError2)
            throw e;
          results = [];
        }
        return ns.flatMap((nv) => {
          const n = nv;
          return n < results.length ? [results[n]] : [];
        });
      }
      if (Array.isArray(value)) {
        return ns.flatMap((nv) => {
          const n = nv;
          if (n < 0) {
            throw new Error("nth doesn't support negative indices");
          }
          return n < value.length ? [value[n]] : [null];
        });
      }
      return [null];
    }
    case "range": {
      if (args.length === 0)
        return [];
      const startsVals = evaluate2(value, args[0], ctx);
      if (args.length === 1) {
        const result2 = [];
        for (const n of startsVals) {
          const num = n;
          for (let i = 0; i < num; i++)
            result2.push(i);
        }
        return result2;
      }
      const endsVals = evaluate2(value, args[1], ctx);
      if (args.length === 2) {
        const result2 = [];
        for (const s of startsVals) {
          for (const e of endsVals) {
            const start = s;
            const end = e;
            for (let i = start; i < end; i++)
              result2.push(i);
          }
        }
        return result2;
      }
      const stepsVals = evaluate2(value, args[2], ctx);
      const result = [];
      for (const s of startsVals) {
        for (const e of endsVals) {
          for (const st of stepsVals) {
            const start = s;
            const end = e;
            const step = st;
            if (step === 0)
              continue;
            if (step > 0) {
              for (let i = start; i < end; i += step)
                result.push(i);
            } else {
              for (let i = start; i > end; i += step)
                result.push(i);
            }
          }
        }
      }
      return result;
    }
    case "limit": {
      if (args.length < 2)
        return [];
      const ns = evaluate2(value, args[0], ctx);
      return ns.flatMap((nv) => {
        const n = nv;
        if (n < 0) {
          throw new Error("limit doesn't support negative count");
        }
        if (n === 0)
          return [];
        let results;
        try {
          results = evaluateWithPartialResults2(value, args[1], ctx);
        } catch (e) {
          if (e instanceof ExecutionLimitError2)
            throw e;
          results = [];
        }
        return results.slice(0, n);
      });
    }
    case "isempty": {
      if (args.length < 1)
        return [true];
      try {
        const results = evaluateWithPartialResults2(value, args[0], ctx);
        return [results.length === 0];
      } catch (e) {
        if (e instanceof ExecutionLimitError2)
          throw e;
        return [true];
      }
    }
    case "isvalid": {
      if (args.length < 1)
        return [true];
      try {
        const results = evaluate2(value, args[0], ctx);
        return [results.length > 0];
      } catch (e) {
        if (e instanceof ExecutionLimitError2)
          throw e;
        return [false];
      }
    }
    case "skip": {
      if (args.length < 2)
        return [];
      const ns = evaluate2(value, args[0], ctx);
      return ns.flatMap((nv) => {
        const n = nv;
        if (n < 0) {
          throw new Error("skip doesn't support negative count");
        }
        const results = evaluate2(value, args[1], ctx);
        return results.slice(n);
      });
    }
    case "until": {
      if (args.length < 2)
        return [value];
      let current = value;
      const maxIterations = ctx.limits.maxIterations;
      for (let i = 0; i < maxIterations; i++) {
        const conds = evaluate2(current, args[0], ctx);
        if (conds.some(isTruthy2))
          return [current];
        const next = evaluate2(current, args[1], ctx);
        if (next.length === 0)
          return [current];
        current = next[0];
      }
      throw new ExecutionLimitError2(`jq until: too many iterations (${maxIterations}), increase executionLimits.maxJqIterations`, "iterations");
    }
    case "while": {
      if (args.length < 2)
        return [value];
      const results = [];
      let current = value;
      const maxIterations = ctx.limits.maxIterations;
      for (let i = 0; i < maxIterations; i++) {
        const conds = evaluate2(current, args[0], ctx);
        if (!conds.some(isTruthy2))
          break;
        results.push(current);
        const next = evaluate2(current, args[1], ctx);
        if (next.length === 0)
          break;
        current = next[0];
      }
      if (results.length >= maxIterations) {
        throw new ExecutionLimitError2(`jq while: too many iterations (${maxIterations}), increase executionLimits.maxJqIterations`, "iterations");
      }
      return results;
    }
    case "repeat": {
      if (args.length === 0)
        return [value];
      const results = [];
      let current = value;
      const maxIterations = ctx.limits.maxIterations;
      for (let i = 0; i < maxIterations; i++) {
        results.push(current);
        const next = evaluate2(current, args[0], ctx);
        if (next.length === 0)
          break;
        current = next[0];
      }
      if (results.length >= maxIterations) {
        throw new ExecutionLimitError2(`jq repeat: too many iterations (${maxIterations}), increase executionLimits.maxJqIterations`, "iterations");
      }
      return results;
    }
    default:
      return null;
  }
}
__name(evalControlBuiltin, "evalControlBuiltin");

// dist/commands/query-engine/builtins/date-builtins.js
function evalDateBuiltin(value, name, args, ctx, evaluate2) {
  switch (name) {
    case "now":
      return [Date.now() / 1e3];
    case "gmtime": {
      if (typeof value !== "number")
        return [null];
      const date = new Date(value * 1e3);
      const year = date.getUTCFullYear();
      const month = date.getUTCMonth();
      const day = date.getUTCDate();
      const hour = date.getUTCHours();
      const minute = date.getUTCMinutes();
      const second = date.getUTCSeconds();
      const weekday = date.getUTCDay();
      const startOfYear = Date.UTC(year, 0, 1);
      const yearday = Math.floor((date.getTime() - startOfYear) / (24 * 60 * 60 * 1e3));
      return [[year, month, day, hour, minute, second, weekday, yearday]];
    }
    case "mktime": {
      if (!Array.isArray(value)) {
        throw new Error("mktime requires parsed datetime inputs");
      }
      const [year, month, day, hour = 0, minute = 0, second = 0] = value;
      if (typeof year !== "number" || typeof month !== "number") {
        throw new Error("mktime requires parsed datetime inputs");
      }
      const dateVal = Date.UTC(year, month, day ?? 1, hour ?? 0, minute ?? 0, second ?? 0);
      return [Math.floor(dateVal / 1e3)];
    }
    case "strftime": {
      if (args.length === 0)
        return [null];
      const fmtVals = evaluate2(value, args[0], ctx);
      const fmt = fmtVals[0];
      if (typeof fmt !== "string") {
        throw new Error("strftime/1 requires a string format");
      }
      let date;
      if (typeof value === "number") {
        date = new Date(value * 1e3);
      } else if (Array.isArray(value)) {
        const [year, month, day, hour = 0, minute = 0, second = 0] = value;
        if (typeof year !== "number" || typeof month !== "number") {
          throw new Error("strftime/1 requires parsed datetime inputs");
        }
        date = new Date(Date.UTC(year, month, day ?? 1, hour ?? 0, minute ?? 0, second ?? 0));
      } else {
        throw new Error("strftime/1 requires parsed datetime inputs");
      }
      const dayNames = [
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday"
      ];
      const monthNames = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December"
      ];
      const pad = /* @__PURE__ */ __name((n, w = 2) => String(n).padStart(w, "0"), "pad");
      const result = fmt.replace(/%Y/g, String(date.getUTCFullYear())).replace(/%m/g, pad(date.getUTCMonth() + 1)).replace(/%d/g, pad(date.getUTCDate())).replace(/%H/g, pad(date.getUTCHours())).replace(/%M/g, pad(date.getUTCMinutes())).replace(/%S/g, pad(date.getUTCSeconds())).replace(/%A/g, dayNames[date.getUTCDay()]).replace(/%B/g, monthNames[date.getUTCMonth()]).replace(/%Z/g, "UTC").replace(/%%/g, "%");
      return [result];
    }
    case "strptime": {
      if (args.length === 0)
        return [null];
      if (typeof value !== "string") {
        throw new Error("strptime/1 requires a string input");
      }
      const fmtVals = evaluate2(value, args[0], ctx);
      const fmt = fmtVals[0];
      if (typeof fmt !== "string") {
        throw new Error("strptime/1 requires a string format");
      }
      if (fmt === "%Y-%m-%dT%H:%M:%SZ") {
        const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/);
        if (match) {
          const [, year, month, day, hour, minute, second] = match.map(Number);
          const date2 = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
          const weekday = date2.getUTCDay();
          const startOfYear = Date.UTC(year, 0, 1);
          const yearday = Math.floor((date2.getTime() - startOfYear) / (24 * 60 * 60 * 1e3));
          return [
            [year, month - 1, day, hour, minute, second, weekday, yearday]
          ];
        }
      }
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) {
        const year = date.getUTCFullYear();
        const month = date.getUTCMonth();
        const day = date.getUTCDate();
        const hour = date.getUTCHours();
        const minute = date.getUTCMinutes();
        const second = date.getUTCSeconds();
        const weekday = date.getUTCDay();
        const startOfYear = Date.UTC(year, 0, 1);
        const yearday = Math.floor((date.getTime() - startOfYear) / (24 * 60 * 60 * 1e3));
        return [[year, month, day, hour, minute, second, weekday, yearday]];
      }
      throw new Error(`Cannot parse date: ${value}`);
    }
    case "fromdate": {
      if (typeof value !== "string") {
        throw new Error("fromdate requires a string input");
      }
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        throw new Error(`date "${value}" does not match format "%Y-%m-%dT%H:%M:%SZ"`);
      }
      return [Math.floor(date.getTime() / 1e3)];
    }
    case "todate": {
      if (typeof value !== "number") {
        throw new Error("todate requires a number input");
      }
      const date = new Date(value * 1e3);
      return [date.toISOString().replace(/\.\d{3}Z$/, "Z")];
    }
    default:
      return null;
  }
}
__name(evalDateBuiltin, "evalDateBuiltin");

// dist/commands/query-engine/value-operations.js
function isTruthy(v) {
  return v !== false && v !== null;
}
__name(isTruthy, "isTruthy");
function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
__name(deepEqual, "deepEqual");
function compare(a, b) {
  if (typeof a === "number" && typeof b === "number")
    return a - b;
  if (typeof a === "string" && typeof b === "string")
    return a.localeCompare(b);
  return 0;
}
__name(compare, "compare");
function deepMerge(a, b) {
  const result = { ...a };
  for (const key of Object.keys(b)) {
    if (key in result && result[key] && typeof result[key] === "object" && !Array.isArray(result[key]) && b[key] && typeof b[key] === "object" && !Array.isArray(b[key])) {
      result[key] = deepMerge(result[key], b[key]);
    } else {
      result[key] = b[key];
    }
  }
  return result;
}
__name(deepMerge, "deepMerge");
function getValueDepth(value, maxCheck = 3e3) {
  let depth = 0;
  let current = value;
  while (depth < maxCheck) {
    if (Array.isArray(current)) {
      if (current.length === 0)
        return depth + 1;
      current = current[0];
      depth++;
    } else if (current !== null && typeof current === "object") {
      const keys = Object.keys(current);
      if (keys.length === 0)
        return depth + 1;
      current = current[keys[0]];
      depth++;
    } else {
      return depth;
    }
  }
  return depth;
}
__name(getValueDepth, "getValueDepth");
function compareJq(a, b) {
  const typeOrder = /* @__PURE__ */ __name((v) => {
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
  }, "typeOrder");
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
  if (a && b && typeof a === "object" && typeof b === "object") {
    const aObj = a;
    const bObj = b;
    const aKeys = Object.keys(aObj).sort();
    const bKeys = Object.keys(bObj).sort();
    for (let i = 0; i < Math.min(aKeys.length, bKeys.length); i++) {
      const keyCmp = aKeys[i].localeCompare(bKeys[i]);
      if (keyCmp !== 0)
        return keyCmp;
    }
    if (aKeys.length !== bKeys.length)
      return aKeys.length - bKeys.length;
    for (const key of aKeys) {
      const cmp = compareJq(aObj[key], bObj[key]);
      if (cmp !== 0)
        return cmp;
    }
  }
  return 0;
}
__name(compareJq, "compareJq");
function containsDeep(a, b) {
  if (deepEqual(a, b))
    return true;
  if (typeof a === "string" && typeof b === "string") {
    return a.includes(b);
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return b.every((bItem) => a.some((aItem) => containsDeep(aItem, bItem)));
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const aObj = a;
    const bObj = b;
    return Object.keys(bObj).every((k) => k in aObj && containsDeep(aObj[k], bObj[k]));
  }
  return false;
}
__name(containsDeep, "containsDeep");

// dist/commands/query-engine/builtins/format-builtins.js
var DEFAULT_MAX_JQ_DEPTH = 2e3;
function evalFormatBuiltin(value, name, maxDepth) {
  switch (name) {
    case "@base64":
      if (typeof value === "string") {
        if (typeof Buffer !== "undefined") {
          return [Buffer.from(value, "utf-8").toString("base64")];
        }
        return [btoa(value)];
      }
      return [null];
    case "@base64d":
      if (typeof value === "string") {
        if (typeof Buffer !== "undefined") {
          return [Buffer.from(value, "base64").toString("utf-8")];
        }
        return [atob(value)];
      }
      return [null];
    case "@uri":
      if (typeof value === "string") {
        return [
          encodeURIComponent(value).replace(/!/g, "%21").replace(/'/g, "%27").replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\*/g, "%2A")
        ];
      }
      return [null];
    case "@urid":
      if (typeof value === "string") {
        return [decodeURIComponent(value)];
      }
      return [null];
    case "@csv": {
      if (!Array.isArray(value))
        return [null];
      const csvEscaped = value.map((v) => {
        if (v === null)
          return "";
        if (typeof v === "boolean")
          return v ? "true" : "false";
        if (typeof v === "number")
          return String(v);
        const s = String(v);
        if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
          return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
      });
      return [csvEscaped.join(",")];
    }
    case "@tsv": {
      if (!Array.isArray(value))
        return [null];
      return [
        value.map((v) => String(v ?? "").replace(/\t/g, "\\t").replace(/\n/g, "\\n")).join("	")
      ];
    }
    case "@json": {
      const effectiveMaxDepth = maxDepth ?? DEFAULT_MAX_JQ_DEPTH;
      if (getValueDepth(value, effectiveMaxDepth + 1) > effectiveMaxDepth) {
        return [null];
      }
      return [JSON.stringify(value)];
    }
    case "@html":
      if (typeof value === "string") {
        return [
          value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&apos;").replace(/"/g, "&quot;")
        ];
      }
      return [null];
    case "@sh":
      if (typeof value === "string") {
        return [`'${value.replace(/'/g, "'\\''")}'`];
      }
      return [null];
    case "@text":
      if (typeof value === "string")
        return [value];
      if (value === null || value === void 0)
        return [""];
      return [String(value)];
    default:
      return null;
  }
}
__name(evalFormatBuiltin, "evalFormatBuiltin");

// dist/commands/query-engine/builtins/index-builtins.js
function evalIndexBuiltin(value, name, args, ctx, evaluate2, deepEqual2) {
  switch (name) {
    case "index": {
      if (args.length === 0)
        return [null];
      const needles = evaluate2(value, args[0], ctx);
      return needles.map((needle) => {
        if (typeof value === "string" && typeof needle === "string") {
          if (needle === "" && value === "")
            return null;
          const idx = value.indexOf(needle);
          return idx >= 0 ? idx : null;
        }
        if (Array.isArray(value)) {
          if (Array.isArray(needle)) {
            for (let i = 0; i <= value.length - needle.length; i++) {
              let match = true;
              for (let j = 0; j < needle.length; j++) {
                if (!deepEqual2(value[i + j], needle[j])) {
                  match = false;
                  break;
                }
              }
              if (match)
                return i;
            }
            return null;
          }
          const idx = value.findIndex((x) => deepEqual2(x, needle));
          return idx >= 0 ? idx : null;
        }
        return null;
      });
    }
    case "rindex": {
      if (args.length === 0)
        return [null];
      const needles = evaluate2(value, args[0], ctx);
      return needles.map((needle) => {
        if (typeof value === "string" && typeof needle === "string") {
          const idx = value.lastIndexOf(needle);
          return idx >= 0 ? idx : null;
        }
        if (Array.isArray(value)) {
          if (Array.isArray(needle)) {
            for (let i = value.length - needle.length; i >= 0; i--) {
              let match = true;
              for (let j = 0; j < needle.length; j++) {
                if (!deepEqual2(value[i + j], needle[j])) {
                  match = false;
                  break;
                }
              }
              if (match)
                return i;
            }
            return null;
          }
          for (let i = value.length - 1; i >= 0; i--) {
            if (deepEqual2(value[i], needle))
              return i;
          }
          return null;
        }
        return null;
      });
    }
    case "indices": {
      if (args.length === 0)
        return [[]];
      const needles = evaluate2(value, args[0], ctx);
      return needles.map((needle) => {
        const result = [];
        if (typeof value === "string" && typeof needle === "string") {
          let idx = value.indexOf(needle);
          while (idx !== -1) {
            result.push(idx);
            idx = value.indexOf(needle, idx + 1);
          }
        } else if (Array.isArray(value)) {
          if (Array.isArray(needle)) {
            const needleLen = needle.length;
            if (needleLen === 0) {
              for (let i = 0; i <= value.length; i++)
                result.push(i);
            } else {
              for (let i = 0; i <= value.length - needleLen; i++) {
                let match = true;
                for (let j = 0; j < needleLen; j++) {
                  if (!deepEqual2(value[i + j], needle[j])) {
                    match = false;
                    break;
                  }
                }
                if (match)
                  result.push(i);
              }
            }
          } else {
            for (let i = 0; i < value.length; i++) {
              if (deepEqual2(value[i], needle))
                result.push(i);
            }
          }
        }
        return result;
      });
    }
    default:
      return null;
  }
}
__name(evalIndexBuiltin, "evalIndexBuiltin");

// dist/commands/query-engine/builtins/math-builtins.js
function evalMathBuiltin(value, name, args, ctx, evaluate2) {
  switch (name) {
    case "fabs":
    case "abs":
      if (typeof value === "number")
        return [Math.abs(value)];
      if (typeof value === "string")
        return [value];
      return [null];
    case "exp10":
      if (typeof value === "number")
        return [10 ** value];
      return [null];
    case "exp2":
      if (typeof value === "number")
        return [2 ** value];
      return [null];
    case "pow": {
      if (args.length < 2)
        return [null];
      const bases = evaluate2(value, args[0], ctx);
      const exps = evaluate2(value, args[1], ctx);
      const base = bases[0];
      const exp = exps[0];
      if (typeof base !== "number" || typeof exp !== "number")
        return [null];
      return [base ** exp];
    }
    case "atan2": {
      if (args.length < 2)
        return [null];
      const ys = evaluate2(value, args[0], ctx);
      const xs = evaluate2(value, args[1], ctx);
      const y = ys[0];
      const x = xs[0];
      if (typeof y !== "number" || typeof x !== "number")
        return [null];
      return [Math.atan2(y, x)];
    }
    case "hypot": {
      if (typeof value !== "number" || args.length === 0)
        return [null];
      const y = evaluate2(value, args[0], ctx)[0];
      return [Math.hypot(value, y)];
    }
    case "fma": {
      if (typeof value !== "number" || args.length < 2)
        return [null];
      const y = evaluate2(value, args[0], ctx)[0];
      const z = evaluate2(value, args[1], ctx)[0];
      return [value * y + z];
    }
    case "copysign": {
      if (typeof value !== "number" || args.length === 0)
        return [null];
      const y = evaluate2(value, args[0], ctx)[0];
      return [Math.sign(y) * Math.abs(value)];
    }
    case "drem":
    case "remainder": {
      if (typeof value !== "number" || args.length === 0)
        return [null];
      const y = evaluate2(value, args[0], ctx)[0];
      return [value - Math.round(value / y) * y];
    }
    case "fdim": {
      if (typeof value !== "number" || args.length === 0)
        return [null];
      const y = evaluate2(value, args[0], ctx)[0];
      return [Math.max(0, value - y)];
    }
    case "fmax": {
      if (typeof value !== "number" || args.length === 0)
        return [null];
      const y = evaluate2(value, args[0], ctx)[0];
      return [Math.max(value, y)];
    }
    case "fmin": {
      if (typeof value !== "number" || args.length === 0)
        return [null];
      const y = evaluate2(value, args[0], ctx)[0];
      return [Math.min(value, y)];
    }
    case "ldexp": {
      if (typeof value !== "number" || args.length === 0)
        return [null];
      const exp = evaluate2(value, args[0], ctx)[0];
      return [value * 2 ** exp];
    }
    case "scalbn":
    case "scalbln": {
      if (typeof value !== "number" || args.length === 0)
        return [null];
      const exp = evaluate2(value, args[0], ctx)[0];
      return [value * 2 ** exp];
    }
    case "nearbyint":
      if (typeof value === "number")
        return [Math.round(value)];
      return [null];
    case "logb":
      if (typeof value === "number")
        return [Math.floor(Math.log2(Math.abs(value)))];
      return [null];
    case "significand":
      if (typeof value === "number") {
        const exp = Math.floor(Math.log2(Math.abs(value)));
        return [value / 2 ** exp];
      }
      return [null];
    case "frexp":
      if (typeof value === "number") {
        if (value === 0)
          return [[0, 0]];
        const exp = Math.floor(Math.log2(Math.abs(value))) + 1;
        const mantissa = value / 2 ** exp;
        return [[mantissa, exp]];
      }
      return [null];
    case "modf":
      if (typeof value === "number") {
        const intPart = Math.trunc(value);
        const fracPart = value - intPart;
        return [[fracPart, intPart]];
      }
      return [null];
    default:
      return null;
  }
}
__name(evalMathBuiltin, "evalMathBuiltin");

// dist/commands/query-engine/builtins/navigation-builtins.js
function evalNavigationBuiltin(value, name, args, ctx, evaluate2, isTruthy2, getValueAtPath2, evalBuiltin2) {
  switch (name) {
    case "recurse": {
      if (args.length === 0) {
        const results2 = [];
        const walk2 = /* @__PURE__ */ __name((v) => {
          results2.push(v);
          if (Array.isArray(v)) {
            for (const item of v)
              walk2(item);
          } else if (v && typeof v === "object") {
            for (const key of Object.keys(v)) {
              walk2(v[key]);
            }
          }
        }, "walk");
        walk2(value);
        return results2;
      }
      const results = [];
      const condExpr = args.length >= 2 ? args[1] : null;
      const maxDepth = 1e4;
      let depth = 0;
      const walk = /* @__PURE__ */ __name((v) => {
        if (depth++ > maxDepth)
          return;
        if (condExpr) {
          const condResults = evaluate2(v, condExpr, ctx);
          if (!condResults.some(isTruthy2))
            return;
        }
        results.push(v);
        const next = evaluate2(v, args[0], ctx);
        for (const n of next) {
          if (n !== null && n !== void 0)
            walk(n);
        }
      }, "walk");
      walk(value);
      return results;
    }
    case "recurse_down":
      return evalBuiltin2(value, "recurse", args, ctx);
    case "walk": {
      if (args.length === 0)
        return [value];
      const seen = /* @__PURE__ */ new WeakSet();
      const walkFn = /* @__PURE__ */ __name((v) => {
        if (v && typeof v === "object") {
          if (seen.has(v))
            return v;
          seen.add(v);
        }
        let transformed;
        if (Array.isArray(v)) {
          transformed = v.map(walkFn);
        } else if (v && typeof v === "object") {
          const obj = {};
          for (const [k, val] of Object.entries(v)) {
            obj[k] = walkFn(val);
          }
          transformed = obj;
        } else {
          transformed = v;
        }
        const results = evaluate2(transformed, args[0], ctx);
        return results[0];
      }, "walkFn");
      return [walkFn(value)];
    }
    case "transpose": {
      if (!Array.isArray(value))
        return [null];
      if (value.length === 0)
        return [[]];
      const maxLen = Math.max(...value.map((row) => Array.isArray(row) ? row.length : 0));
      const result = [];
      for (let i = 0; i < maxLen; i++) {
        result.push(value.map((row) => Array.isArray(row) ? row[i] : null));
      }
      return [result];
    }
    case "combinations": {
      if (args.length > 0) {
        const ns = evaluate2(value, args[0], ctx);
        const n = ns[0];
        if (!Array.isArray(value) || n < 0)
          return [];
        if (n === 0)
          return [[]];
        const results2 = [];
        const generate2 = /* @__PURE__ */ __name((current, depth) => {
          if (depth === n) {
            results2.push([...current]);
            return;
          }
          for (const item of value) {
            current.push(item);
            generate2(current, depth + 1);
            current.pop();
          }
        }, "generate");
        generate2([], 0);
        return results2;
      }
      if (!Array.isArray(value))
        return [];
      if (value.length === 0)
        return [[]];
      for (const arr of value) {
        if (!Array.isArray(arr))
          return [];
      }
      const results = [];
      const generate = /* @__PURE__ */ __name((index, current) => {
        if (index === value.length) {
          results.push([...current]);
          return;
        }
        const arr = value[index];
        for (const item of arr) {
          current.push(item);
          generate(index + 1, current);
          current.pop();
        }
      }, "generate");
      generate(0, []);
      return results;
    }
    // Navigation operators
    case "parent": {
      if (ctx.root === void 0 || ctx.currentPath === void 0)
        return [];
      const path = ctx.currentPath;
      if (path.length === 0)
        return [];
      const levels = args.length > 0 ? evaluate2(value, args[0], ctx)[0] : 1;
      if (levels >= 0) {
        if (levels > path.length)
          return [];
        const parentPath = path.slice(0, path.length - levels);
        return [getValueAtPath2(ctx.root, parentPath)];
      } else {
        const targetLen = -levels - 1;
        if (targetLen >= path.length)
          return [value];
        const parentPath = path.slice(0, targetLen);
        return [getValueAtPath2(ctx.root, parentPath)];
      }
    }
    case "parents": {
      if (ctx.root === void 0 || ctx.currentPath === void 0)
        return [[]];
      const path = ctx.currentPath;
      const parents = [];
      for (let i = path.length - 1; i >= 0; i--) {
        parents.push(getValueAtPath2(ctx.root, path.slice(0, i)));
      }
      return [parents];
    }
    case "root":
      return ctx.root !== void 0 ? [ctx.root] : [];
    default:
      return null;
  }
}
__name(evalNavigationBuiltin, "evalNavigationBuiltin");

// dist/commands/query-engine/builtins/object-builtins.js
var DEFAULT_MAX_JQ_DEPTH2 = 2e3;
function evalObjectBuiltin(value, name, args, ctx, evaluate2) {
  switch (name) {
    case "keys":
      if (Array.isArray(value))
        return [value.map((_, i) => i)];
      if (value && typeof value === "object")
        return [Object.keys(value).sort()];
      return [null];
    case "keys_unsorted":
      if (Array.isArray(value))
        return [value.map((_, i) => i)];
      if (value && typeof value === "object")
        return [Object.keys(value)];
      return [null];
    case "length":
      if (typeof value === "string")
        return [value.length];
      if (Array.isArray(value))
        return [value.length];
      if (value && typeof value === "object")
        return [Object.keys(value).length];
      if (value === null)
        return [0];
      if (typeof value === "number")
        return [Math.abs(value)];
      return [null];
    case "utf8bytelength": {
      if (typeof value === "string")
        return [new TextEncoder().encode(value).length];
      const typeName = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
      const valueStr = typeName === "array" || typeName === "object" ? JSON.stringify(value) : String(value);
      throw new Error(`${typeName} (${valueStr}) only strings have UTF-8 byte length`);
    }
    case "to_entries":
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return [
          Object.entries(value).map(([key, val]) => ({ key, value: val }))
        ];
      }
      return [null];
    case "from_entries":
      if (Array.isArray(value)) {
        const result = {};
        for (const item of value) {
          if (item && typeof item === "object") {
            const obj = item;
            const key = obj.key ?? obj.Key ?? obj.name ?? obj.Name ?? obj.k;
            const val = obj.value ?? obj.Value ?? obj.v;
            if (key !== void 0)
              result[String(key)] = val;
          }
        }
        return [result];
      }
      return [null];
    case "with_entries": {
      if (args.length === 0)
        return [value];
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const entries = Object.entries(value).map(([key, val]) => ({
          key,
          value: val
        }));
        const mapped = entries.flatMap((e) => evaluate2(e, args[0], ctx));
        const result = {};
        for (const item of mapped) {
          if (item && typeof item === "object") {
            const obj = item;
            const key = obj.key ?? obj.name ?? obj.k;
            const val = obj.value ?? obj.v;
            if (key !== void 0)
              result[String(key)] = val;
          }
        }
        return [result];
      }
      return [null];
    }
    case "reverse":
      if (Array.isArray(value))
        return [[...value].reverse()];
      if (typeof value === "string")
        return [value.split("").reverse().join("")];
      return [null];
    case "flatten": {
      if (!Array.isArray(value))
        return [null];
      const depths = args.length > 0 ? evaluate2(value, args[0], ctx) : [Number.POSITIVE_INFINITY];
      return depths.map((d) => {
        const depth = d;
        if (depth < 0) {
          throw new Error("flatten depth must not be negative");
        }
        return value.flat(depth);
      });
    }
    case "unique":
      if (Array.isArray(value)) {
        const seen = /* @__PURE__ */ new Set();
        const result = [];
        for (const item of value) {
          const key = JSON.stringify(item);
          if (!seen.has(key)) {
            seen.add(key);
            result.push(item);
          }
        }
        return [result];
      }
      return [null];
    case "tojson":
    case "tojsonstream": {
      const maxDepth = ctx.limits.maxDepth ?? DEFAULT_MAX_JQ_DEPTH2;
      if (getValueDepth(value, maxDepth + 1) > maxDepth) {
        return [null];
      }
      return [JSON.stringify(value)];
    }
    case "fromjson": {
      if (typeof value === "string") {
        const trimmed = value.trim().toLowerCase();
        if (trimmed === "nan") {
          return [Number.NaN];
        }
        if (trimmed === "inf" || trimmed === "infinity") {
          return [Number.POSITIVE_INFINITY];
        }
        if (trimmed === "-inf" || trimmed === "-infinity") {
          return [Number.NEGATIVE_INFINITY];
        }
        try {
          return [JSON.parse(value)];
        } catch {
          throw new Error(`Invalid JSON: ${value}`);
        }
      }
      return [value];
    }
    case "tostring":
      if (typeof value === "string")
        return [value];
      return [JSON.stringify(value)];
    case "tonumber":
      if (typeof value === "number")
        return [value];
      if (typeof value === "string") {
        const n = Number(value);
        if (Number.isNaN(n)) {
          throw new Error(`${JSON.stringify(value)} cannot be parsed as a number`);
        }
        return [n];
      }
      throw new Error(`${typeof value} cannot be parsed as a number`);
    case "toboolean": {
      if (typeof value === "boolean")
        return [value];
      if (typeof value === "string") {
        if (value === "true")
          return [true];
        if (value === "false")
          return [false];
        throw new Error(`string (${JSON.stringify(value)}) cannot be parsed as a boolean`);
      }
      const typeName = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
      const valueStr = typeName === "array" || typeName === "object" ? JSON.stringify(value) : String(value);
      throw new Error(`${typeName} (${valueStr}) cannot be parsed as a boolean`);
    }
    case "tostream": {
      const results = [];
      const walk = /* @__PURE__ */ __name((v, path) => {
        if (v === null || typeof v !== "object") {
          results.push([path, v]);
        } else if (Array.isArray(v)) {
          if (v.length === 0) {
            results.push([path, []]);
          } else {
            for (let i = 0; i < v.length; i++) {
              walk(v[i], [...path, i]);
            }
          }
        } else {
          const keys = Object.keys(v);
          if (keys.length === 0) {
            results.push([path, {}]);
          } else {
            for (const key of keys) {
              walk(v[key], [...path, key]);
            }
          }
        }
      }, "walk");
      walk(value, []);
      results.push([[]]);
      return results;
    }
    case "fromstream": {
      if (args.length === 0)
        return [value];
      const streamItems = evaluate2(value, args[0], ctx);
      let result = null;
      for (const item of streamItems) {
        if (!Array.isArray(item))
          continue;
        if (item.length === 1 && Array.isArray(item[0]) && item[0].length === 0) {
          continue;
        }
        if (item.length !== 2)
          continue;
        const [path, val] = item;
        if (!Array.isArray(path))
          continue;
        if (path.length === 0) {
          result = val;
          continue;
        }
        if (result === null) {
          result = typeof path[0] === "number" ? [] : {};
        }
        let current = result;
        for (let i = 0; i < path.length - 1; i++) {
          const key = path[i];
          const nextKey = path[i + 1];
          if (Array.isArray(current) && typeof key === "number") {
            while (current.length <= key) {
              current.push(null);
            }
            if (current[key] === null) {
              current[key] = typeof nextKey === "number" ? [] : {};
            }
            current = current[key];
          } else if (current && typeof current === "object" && !Array.isArray(current)) {
            const obj = current;
            if (obj[String(key)] === null || obj[String(key)] === void 0) {
              obj[String(key)] = typeof nextKey === "number" ? [] : {};
            }
            current = obj[String(key)];
          }
        }
        const lastKey = path[path.length - 1];
        if (Array.isArray(current) && typeof lastKey === "number") {
          while (current.length <= lastKey) {
            current.push(null);
          }
          current[lastKey] = val;
        } else if (current && typeof current === "object" && !Array.isArray(current)) {
          current[String(lastKey)] = val;
        }
      }
      return [result];
    }
    case "truncate_stream": {
      const depth = typeof value === "number" ? Math.floor(value) : 0;
      if (args.length === 0)
        return [];
      const results = [];
      const streamItems = evaluate2(value, args[0], ctx);
      for (const item of streamItems) {
        if (!Array.isArray(item))
          continue;
        if (item.length === 1 && Array.isArray(item[0])) {
          const path = item[0];
          if (path.length > depth) {
            results.push([path.slice(depth)]);
          }
          continue;
        }
        if (item.length === 2 && Array.isArray(item[0])) {
          const path = item[0];
          const val = item[1];
          if (path.length > depth) {
            results.push([path.slice(depth), val]);
          }
        }
      }
      return results;
    }
    default:
      return null;
  }
}
__name(evalObjectBuiltin, "evalObjectBuiltin");

// dist/commands/query-engine/builtins/path-builtins.js
function evalPathBuiltin(value, name, args, ctx, evaluate2, isTruthy2, setPath2, deletePath2, applyDel2, collectPaths2) {
  switch (name) {
    case "getpath": {
      if (args.length === 0)
        return [null];
      const paths = evaluate2(value, args[0], ctx);
      const results = [];
      for (const pathVal of paths) {
        const path = pathVal;
        let current = value;
        for (const key of path) {
          if (current === null || current === void 0) {
            current = null;
            break;
          }
          if (Array.isArray(current) && typeof key === "number") {
            current = current[key];
          } else if (typeof current === "object" && typeof key === "string") {
            current = current[key];
          } else {
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
      const paths = evaluate2(value, args[0], ctx);
      const path = paths[0];
      const vals = evaluate2(value, args[1], ctx);
      const newVal = vals[0];
      return [setPath2(value, path, newVal)];
    }
    case "delpaths": {
      if (args.length === 0)
        return [value];
      const pathLists = evaluate2(value, args[0], ctx);
      const paths = pathLists[0];
      let result = value;
      for (const path of paths.sort((a, b) => b.length - a.length)) {
        result = deletePath2(result, path);
      }
      return [result];
    }
    case "path": {
      if (args.length === 0)
        return [[]];
      const paths = [];
      collectPaths2(value, args[0], ctx, [], paths);
      return paths;
    }
    case "del": {
      if (args.length === 0)
        return [value];
      return [applyDel2(value, args[0], ctx)];
    }
    case "pick": {
      if (args.length === 0)
        return [null];
      const allPaths = [];
      for (const arg of args) {
        collectPaths2(value, arg, ctx, [], allPaths);
      }
      let result = null;
      for (const path of allPaths) {
        for (const key of path) {
          if (typeof key === "number" && key < 0) {
            throw new Error("Out of bounds negative array index");
          }
        }
        let current = value;
        for (const key of path) {
          if (current === null || current === void 0)
            break;
          if (Array.isArray(current) && typeof key === "number") {
            current = current[key];
          } else if (typeof current === "object" && typeof key === "string") {
            current = current[key];
          } else {
            current = null;
            break;
          }
        }
        result = setPath2(result, path, current);
      }
      return [result];
    }
    case "paths": {
      const paths = [];
      const walk = /* @__PURE__ */ __name((v, path) => {
        if (v && typeof v === "object") {
          if (Array.isArray(v)) {
            for (let i = 0; i < v.length; i++) {
              paths.push([...path, i]);
              walk(v[i], [...path, i]);
            }
          } else {
            for (const key of Object.keys(v)) {
              paths.push([...path, key]);
              walk(v[key], [...path, key]);
            }
          }
        }
      }, "walk");
      walk(value, []);
      if (args.length > 0) {
        return paths.filter((p) => {
          let v = value;
          for (const k of p) {
            if (Array.isArray(v) && typeof k === "number") {
              v = v[k];
            } else if (v && typeof v === "object" && typeof k === "string") {
              v = v[k];
            } else {
              return false;
            }
          }
          const results = evaluate2(v, args[0], ctx);
          return results.some(isTruthy2);
        });
      }
      return paths;
    }
    case "leaf_paths": {
      const paths = [];
      const walk = /* @__PURE__ */ __name((v, path) => {
        if (v === null || typeof v !== "object") {
          paths.push(path);
        } else if (Array.isArray(v)) {
          for (let i = 0; i < v.length; i++) {
            walk(v[i], [...path, i]);
          }
        } else {
          for (const key of Object.keys(v)) {
            walk(v[key], [...path, key]);
          }
        }
      }, "walk");
      walk(value, []);
      return paths;
    }
    default:
      return null;
  }
}
__name(evalPathBuiltin, "evalPathBuiltin");

// dist/commands/query-engine/builtins/sql-builtins.js
function evalSqlBuiltin(value, name, args, ctx, evaluate2, deepEqual2) {
  switch (name) {
    case "IN": {
      if (args.length === 0)
        return [false];
      if (args.length === 1) {
        const streamVals = evaluate2(value, args[0], ctx);
        for (const v of streamVals) {
          if (deepEqual2(value, v))
            return [true];
        }
        return [false];
      }
      const stream1Vals = evaluate2(value, args[0], ctx);
      const stream2Vals = evaluate2(value, args[1], ctx);
      const stream2Set = new Set(stream2Vals.map((v) => JSON.stringify(v)));
      for (const v of stream1Vals) {
        if (stream2Set.has(JSON.stringify(v)))
          return [true];
      }
      return [false];
    }
    case "INDEX": {
      if (args.length === 0)
        return [{}];
      if (args.length === 1) {
        const streamVals2 = evaluate2(value, args[0], ctx);
        const result2 = {};
        for (const v of streamVals2) {
          const key = String(v);
          result2[key] = v;
        }
        return [result2];
      }
      if (args.length === 2) {
        const streamVals2 = evaluate2(value, args[0], ctx);
        const result2 = {};
        for (const v of streamVals2) {
          const keys = evaluate2(v, args[1], ctx);
          if (keys.length > 0) {
            const key = String(keys[0]);
            result2[key] = v;
          }
        }
        return [result2];
      }
      const streamVals = evaluate2(value, args[0], ctx);
      const result = {};
      for (const v of streamVals) {
        const keys = evaluate2(v, args[1], ctx);
        const vals = evaluate2(v, args[2], ctx);
        if (keys.length > 0 && vals.length > 0) {
          const key = String(keys[0]);
          result[key] = vals[0];
        }
      }
      return [result];
    }
    case "JOIN": {
      if (args.length < 2)
        return [null];
      const idx = evaluate2(value, args[0], ctx)[0];
      if (!idx || typeof idx !== "object" || Array.isArray(idx))
        return [null];
      const idxObj = idx;
      if (!Array.isArray(value))
        return [null];
      const results = [];
      for (const item of value) {
        const keys = evaluate2(item, args[1], ctx);
        const key = keys.length > 0 ? String(keys[0]) : "";
        const lookup = key in idxObj ? idxObj[key] : null;
        results.push([item, lookup]);
      }
      return [results];
    }
    default:
      return null;
  }
}
__name(evalSqlBuiltin, "evalSqlBuiltin");

// dist/commands/query-engine/builtins/string-builtins.js
function evalStringBuiltin(value, name, args, ctx, evaluate2) {
  switch (name) {
    case "join": {
      if (!Array.isArray(value))
        return [null];
      const seps = args.length > 0 ? evaluate2(value, args[0], ctx) : [""];
      for (const x of value) {
        if (Array.isArray(x) || x !== null && typeof x === "object") {
          throw new Error("cannot join: contains arrays or objects");
        }
      }
      return seps.map((sep) => value.map((x) => x === null ? "" : typeof x === "string" ? x : String(x)).join(String(sep)));
    }
    case "split": {
      if (typeof value !== "string" || args.length === 0)
        return [null];
      const seps = evaluate2(value, args[0], ctx);
      const sep = String(seps[0]);
      return [value.split(sep)];
    }
    case "splits": {
      if (typeof value !== "string" || args.length === 0)
        return [];
      const patterns = evaluate2(value, args[0], ctx);
      const pattern = String(patterns[0]);
      try {
        const flags = args.length > 1 ? String(evaluate2(value, args[1], ctx)[0]) : "g";
        const regex = new RegExp(pattern, flags.includes("g") ? flags : `${flags}g`);
        return value.split(regex);
      } catch {
        return [];
      }
    }
    case "scan": {
      if (typeof value !== "string" || args.length === 0)
        return [];
      const patterns = evaluate2(value, args[0], ctx);
      const pattern = String(patterns[0]);
      try {
        const flags = args.length > 1 ? String(evaluate2(value, args[1], ctx)[0]) : "";
        const regex = new RegExp(pattern, flags.includes("g") ? flags : `${flags}g`);
        const matches = [...value.matchAll(regex)];
        return matches.map((m) => {
          if (m.length > 1) {
            return m.slice(1);
          }
          return m[0];
        });
      } catch {
        return [];
      }
    }
    case "test": {
      if (typeof value !== "string" || args.length === 0)
        return [false];
      const patterns = evaluate2(value, args[0], ctx);
      const pattern = String(patterns[0]);
      try {
        const flags = args.length > 1 ? String(evaluate2(value, args[1], ctx)[0]) : "";
        return [new RegExp(pattern, flags).test(value)];
      } catch {
        return [false];
      }
    }
    case "match": {
      if (typeof value !== "string" || args.length === 0)
        return [null];
      const patterns = evaluate2(value, args[0], ctx);
      const pattern = String(patterns[0]);
      try {
        const flags = args.length > 1 ? String(evaluate2(value, args[1], ctx)[0]) : "";
        const re = new RegExp(pattern, `${flags}d`);
        const m = re.exec(value);
        if (!m)
          return [];
        const indices = m.indices;
        return [
          {
            offset: m.index,
            length: m[0].length,
            string: m[0],
            captures: m.slice(1).map((c, i) => {
              const captureIndices = indices?.[i + 1];
              return {
                offset: captureIndices?.[0] ?? null,
                length: c?.length ?? 0,
                string: c ?? "",
                name: null
              };
            })
          }
        ];
      } catch {
        return [null];
      }
    }
    case "capture": {
      if (typeof value !== "string" || args.length === 0)
        return [null];
      const patterns = evaluate2(value, args[0], ctx);
      const pattern = String(patterns[0]);
      try {
        const flags = args.length > 1 ? String(evaluate2(value, args[1], ctx)[0]) : "";
        const re = new RegExp(pattern, flags);
        const m = value.match(re);
        if (!m || !m.groups)
          return [{}];
        return [m.groups];
      } catch {
        return [null];
      }
    }
    case "sub": {
      if (typeof value !== "string" || args.length < 2)
        return [null];
      const patterns = evaluate2(value, args[0], ctx);
      const replacements = evaluate2(value, args[1], ctx);
      const pattern = String(patterns[0]);
      const replacement = String(replacements[0]);
      try {
        const flags = args.length > 2 ? String(evaluate2(value, args[2], ctx)[0]) : "";
        return [value.replace(new RegExp(pattern, flags), replacement)];
      } catch {
        return [value];
      }
    }
    case "gsub": {
      if (typeof value !== "string" || args.length < 2)
        return [null];
      const patterns = evaluate2(value, args[0], ctx);
      const replacements = evaluate2(value, args[1], ctx);
      const pattern = String(patterns[0]);
      const replacement = String(replacements[0]);
      try {
        const flags = args.length > 2 ? String(evaluate2(value, args[2], ctx)[0]) : "g";
        const effectiveFlags = flags.includes("g") ? flags : `${flags}g`;
        return [
          value.replace(new RegExp(pattern, effectiveFlags), replacement)
        ];
      } catch {
        return [value];
      }
    }
    case "ascii_downcase":
      if (typeof value === "string") {
        return [
          value.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32))
        ];
      }
      return [null];
    case "ascii_upcase":
      if (typeof value === "string") {
        return [
          value.replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 32))
        ];
      }
      return [null];
    case "ltrimstr": {
      if (typeof value !== "string" || args.length === 0)
        return [value];
      const prefixes = evaluate2(value, args[0], ctx);
      const prefix = String(prefixes[0]);
      return [value.startsWith(prefix) ? value.slice(prefix.length) : value];
    }
    case "rtrimstr": {
      if (typeof value !== "string" || args.length === 0)
        return [value];
      const suffixes = evaluate2(value, args[0], ctx);
      const suffix = String(suffixes[0]);
      if (suffix === "")
        return [value];
      return [value.endsWith(suffix) ? value.slice(0, -suffix.length) : value];
    }
    case "trimstr": {
      if (typeof value !== "string" || args.length === 0)
        return [value];
      const strs = evaluate2(value, args[0], ctx);
      const str = String(strs[0]);
      if (str === "")
        return [value];
      let result = value;
      if (result.startsWith(str))
        result = result.slice(str.length);
      if (result.endsWith(str))
        result = result.slice(0, -str.length);
      return [result];
    }
    case "trim":
      if (typeof value === "string")
        return [value.trim()];
      throw new Error("trim input must be a string");
    case "ltrim":
      if (typeof value === "string")
        return [value.trimStart()];
      throw new Error("trim input must be a string");
    case "rtrim":
      if (typeof value === "string")
        return [value.trimEnd()];
      throw new Error("trim input must be a string");
    case "startswith": {
      if (typeof value !== "string" || args.length === 0)
        return [false];
      const prefixes = evaluate2(value, args[0], ctx);
      return [value.startsWith(String(prefixes[0]))];
    }
    case "endswith": {
      if (typeof value !== "string" || args.length === 0)
        return [false];
      const suffixes = evaluate2(value, args[0], ctx);
      return [value.endsWith(String(suffixes[0]))];
    }
    case "ascii":
      if (typeof value === "string" && value.length > 0) {
        return [value.charCodeAt(0)];
      }
      return [null];
    case "explode":
      if (typeof value === "string") {
        return [Array.from(value).map((c) => c.codePointAt(0))];
      }
      return [null];
    case "implode":
      if (!Array.isArray(value)) {
        throw new Error("implode input must be an array");
      }
      {
        const REPLACEMENT_CHAR = 65533;
        const chars = value.map((cp) => {
          if (typeof cp === "string") {
            throw new Error(`string (${JSON.stringify(cp)}) can't be imploded, unicode codepoint needs to be numeric`);
          }
          if (typeof cp !== "number" || Number.isNaN(cp)) {
            throw new Error(`number (null) can't be imploded, unicode codepoint needs to be numeric`);
          }
          const code = Math.trunc(cp);
          if (code < 0 || code > 1114111) {
            return String.fromCodePoint(REPLACEMENT_CHAR);
          }
          if (code >= 55296 && code <= 57343) {
            return String.fromCodePoint(REPLACEMENT_CHAR);
          }
          return String.fromCodePoint(code);
        });
        return [chars.join("")];
      }
    default:
      return null;
  }
}
__name(evalStringBuiltin, "evalStringBuiltin");

// dist/commands/query-engine/builtins/type-builtins.js
function evalTypeBuiltin(value, name) {
  switch (name) {
    case "type":
      if (value === null)
        return ["null"];
      if (Array.isArray(value))
        return ["array"];
      if (typeof value === "boolean")
        return ["boolean"];
      if (typeof value === "number")
        return ["number"];
      if (typeof value === "string")
        return ["string"];
      if (typeof value === "object")
        return ["object"];
      return ["null"];
    case "infinite":
      return [Number.POSITIVE_INFINITY];
    case "nan":
      return [Number.NaN];
    case "isinfinite":
      return [typeof value === "number" && !Number.isFinite(value)];
    case "isnan":
      return [typeof value === "number" && Number.isNaN(value)];
    case "isnormal":
      return [
        typeof value === "number" && Number.isFinite(value) && value !== 0
      ];
    case "isfinite":
      return [typeof value === "number" && Number.isFinite(value)];
    case "numbers":
      return typeof value === "number" ? [value] : [];
    case "strings":
      return typeof value === "string" ? [value] : [];
    case "booleans":
      return typeof value === "boolean" ? [value] : [];
    case "nulls":
      return value === null ? [value] : [];
    case "arrays":
      return Array.isArray(value) ? [value] : [];
    case "objects":
      return value && typeof value === "object" && !Array.isArray(value) ? [value] : [];
    case "iterables":
      return Array.isArray(value) || value && typeof value === "object" && !Array.isArray(value) ? [value] : [];
    case "scalars":
      return !Array.isArray(value) && !(value && typeof value === "object") ? [value] : [];
    case "values":
      if (value === null)
        return [];
      return [value];
    case "not":
      if (value === false || value === null)
        return [true];
      return [false];
    case "null":
      return [null];
    case "true":
      return [true];
    case "false":
      return [false];
    case "empty":
      return [];
    default:
      return null;
  }
}
__name(evalTypeBuiltin, "evalTypeBuiltin");

// dist/commands/query-engine/path-operations.js
function setPath(value, path, newVal) {
  if (path.length === 0)
    return newVal;
  const [head, ...rest] = path;
  if (typeof head === "number") {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      throw new Error("Cannot index object with number");
    }
    const MAX_ARRAY_INDEX = 536870911;
    if (head > MAX_ARRAY_INDEX) {
      throw new Error("Array index too large");
    }
    if (head < 0) {
      throw new Error("Out of bounds negative array index");
    }
    const arr = Array.isArray(value) ? [...value] : [];
    while (arr.length <= head)
      arr.push(null);
    arr[head] = setPath(arr[head], rest, newVal);
    return arr;
  }
  if (Array.isArray(value)) {
    throw new Error("Cannot index array with string");
  }
  const obj = value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
  obj[head] = setPath(obj[head], rest, newVal);
  return obj;
}
__name(setPath, "setPath");
function deletePath(value, path) {
  if (path.length === 0)
    return null;
  if (path.length === 1) {
    const key = path[0];
    if (Array.isArray(value) && typeof key === "number") {
      const arr = [...value];
      arr.splice(key, 1);
      return arr;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const obj = { ...value };
      delete obj[String(key)];
      return obj;
    }
    return value;
  }
  const [head, ...rest] = path;
  if (Array.isArray(value) && typeof head === "number") {
    const arr = [...value];
    arr[head] = deletePath(arr[head], rest);
    return arr;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = { ...value };
    obj[String(head)] = deletePath(obj[String(head)], rest);
    return obj;
  }
  return value;
}
__name(deletePath, "deletePath");

// dist/commands/query-engine/evaluator.js
var BreakError = class _BreakError extends Error {
  static {
    __name(this, "BreakError");
  }
  label;
  partialResults;
  constructor(label, partialResults = []) {
    super(`break ${label}`);
    this.label = label;
    this.partialResults = partialResults;
    this.name = "BreakError";
  }
  withPrependedResults(results) {
    return new _BreakError(this.label, [...results, ...this.partialResults]);
  }
};
var JqError = class extends Error {
  static {
    __name(this, "JqError");
  }
  value;
  constructor(value) {
    super(typeof value === "string" ? value : JSON.stringify(value));
    this.value = value;
    this.name = "JqError";
  }
};
var DEFAULT_MAX_JQ_ITERATIONS = 1e4;
var DEFAULT_MAX_JQ_DEPTH3 = 2e3;
var SIMPLE_MATH_FUNCTIONS = {
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sqrt: Math.sqrt,
  log: Math.log,
  log10: Math.log10,
  log2: Math.log2,
  exp: Math.exp,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  asinh: Math.asinh,
  acosh: Math.acosh,
  atanh: Math.atanh,
  cbrt: Math.cbrt,
  expm1: Math.expm1,
  log1p: Math.log1p,
  trunc: Math.trunc
};
function createContext(options) {
  return {
    vars: /* @__PURE__ */ new Map(),
    limits: {
      maxIterations: options?.limits?.maxIterations ?? DEFAULT_MAX_JQ_ITERATIONS,
      maxDepth: options?.limits?.maxDepth ?? DEFAULT_MAX_JQ_DEPTH3
    },
    env: options?.env
  };
}
__name(createContext, "createContext");
function withVar(ctx, name, value) {
  const newVars = new Map(ctx.vars);
  newVars.set(name, value);
  return {
    vars: newVars,
    limits: ctx.limits,
    env: ctx.env,
    root: ctx.root,
    currentPath: ctx.currentPath,
    funcs: ctx.funcs,
    labels: ctx.labels
  };
}
__name(withVar, "withVar");
function bindPattern(ctx, pattern, value) {
  switch (pattern.type) {
    case "var":
      return withVar(ctx, pattern.name, value);
    case "array": {
      if (!Array.isArray(value))
        return null;
      let newCtx = ctx;
      for (let i = 0; i < pattern.elements.length; i++) {
        const elem = pattern.elements[i];
        const elemValue = i < value.length ? value[i] : null;
        const result = bindPattern(newCtx, elem, elemValue);
        if (result === null)
          return null;
        newCtx = result;
      }
      return newCtx;
    }
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return null;
      }
      const obj = value;
      let newCtx = ctx;
      for (const field of pattern.fields) {
        let key;
        if (typeof field.key === "string") {
          key = field.key;
        } else {
          const keyVals = evaluate(value, field.key, ctx);
          if (keyVals.length === 0)
            return null;
          key = String(keyVals[0]);
        }
        const fieldValue = key in obj ? obj[key] : null;
        if (field.keyVar) {
          newCtx = withVar(newCtx, field.keyVar, fieldValue);
        }
        const result = bindPattern(newCtx, field.pattern, fieldValue);
        if (result === null)
          return null;
        newCtx = result;
      }
      return newCtx;
    }
  }
}
__name(bindPattern, "bindPattern");
function getValueAtPath(root, path) {
  let v = root;
  for (const key of path) {
    if (v && typeof v === "object") {
      v = v[key];
    } else {
      return void 0;
    }
  }
  return v;
}
__name(getValueAtPath, "getValueAtPath");
function extractPathFromAst(ast) {
  if (ast.type === "Identity")
    return [];
  if (ast.type === "Field") {
    const basePath = ast.base ? extractPathFromAst(ast.base) : [];
    if (basePath === null)
      return null;
    return [...basePath, ast.name];
  }
  if (ast.type === "Index" && ast.index.type === "Literal") {
    const basePath = ast.base ? extractPathFromAst(ast.base) : [];
    if (basePath === null)
      return null;
    const idx = ast.index.value;
    if (typeof idx === "number" || typeof idx === "string") {
      return [...basePath, idx];
    }
    return null;
  }
  if (ast.type === "Pipe") {
    const leftPath = extractPathFromAst(ast.left);
    if (leftPath === null)
      return null;
    return applyPathTransform(leftPath, ast.right);
  }
  if (ast.type === "Call") {
    if (ast.name === "parent") {
      return null;
    }
    if (ast.name === "root") {
      return null;
    }
    if (ast.name === "first" && ast.args.length === 0) {
      return [0];
    }
    if (ast.name === "last" && ast.args.length === 0) {
      return [-1];
    }
  }
  return null;
}
__name(extractPathFromAst, "extractPathFromAst");
function applyPathTransform(basePath, ast) {
  if (ast.type === "Call") {
    if (ast.name === "parent") {
      let levels = 1;
      if (ast.args.length > 0 && ast.args[0].type === "Literal") {
        const arg = ast.args[0].value;
        if (typeof arg === "number")
          levels = arg;
      }
      if (levels >= 0) {
        return basePath.slice(0, Math.max(0, basePath.length - levels));
      } else {
        const targetLen = -levels - 1;
        return basePath.slice(0, Math.min(targetLen, basePath.length));
      }
    }
    if (ast.name === "root") {
      return [];
    }
  }
  if (ast.type === "Field") {
    const rightPath = extractPathFromAst(ast);
    if (rightPath !== null) {
      return [...basePath, ...rightPath];
    }
  }
  if (ast.type === "Index" && ast.index.type === "Literal") {
    const rightPath = extractPathFromAst(ast);
    if (rightPath !== null) {
      return [...basePath, ...rightPath];
    }
  }
  if (ast.type === "Pipe") {
    const afterLeft = applyPathTransform(basePath, ast.left);
    if (afterLeft === null)
      return null;
    return applyPathTransform(afterLeft, ast.right);
  }
  if (ast.type === "Identity") {
    return basePath;
  }
  return null;
}
__name(applyPathTransform, "applyPathTransform");
function evaluateWithPartialResults(value, ast, ctx) {
  if (ast.type === "Comma") {
    const results = [];
    try {
      results.push(...evaluate(value, ast.left, ctx));
    } catch (e) {
      if (e instanceof ExecutionLimitError)
        throw e;
      if (results.length > 0)
        return results;
      throw new Error("evaluation failed");
    }
    try {
      results.push(...evaluate(value, ast.right, ctx));
    } catch (e) {
      if (e instanceof ExecutionLimitError)
        throw e;
      return results;
    }
    return results;
  }
  return evaluate(value, ast, ctx);
}
__name(evaluateWithPartialResults, "evaluateWithPartialResults");
function evaluate(value, ast, ctxOrOptions) {
  let ctx = ctxOrOptions && "vars" in ctxOrOptions ? ctxOrOptions : createContext(ctxOrOptions);
  if (ctx.root === void 0) {
    ctx = { ...ctx, root: value, currentPath: [] };
  }
  switch (ast.type) {
    case "Identity":
      return [value];
    case "Field": {
      const bases = ast.base ? evaluate(value, ast.base, ctx) : [value];
      return bases.flatMap((v) => {
        if (v && typeof v === "object" && !Array.isArray(v)) {
          const result = v[ast.name];
          return [result === void 0 ? null : result];
        }
        if (v === null) {
          return [null];
        }
        const typeName = Array.isArray(v) ? "array" : typeof v;
        throw new Error(`Cannot index ${typeName} with string "${ast.name}"`);
      });
    }
    case "Index": {
      const bases = ast.base ? evaluate(value, ast.base, ctx) : [value];
      return bases.flatMap((v) => {
        const indices = evaluate(v, ast.index, ctx);
        return indices.flatMap((idx) => {
          if (typeof idx === "number" && Array.isArray(v)) {
            if (Number.isNaN(idx)) {
              return [null];
            }
            const truncated = Math.trunc(idx);
            const i = truncated < 0 ? v.length + truncated : truncated;
            return i >= 0 && i < v.length ? [v[i]] : [null];
          }
          if (typeof idx === "string" && v && typeof v === "object" && !Array.isArray(v)) {
            return [v[idx]];
          }
          return [null];
        });
      });
    }
    case "Slice": {
      const bases = ast.base ? evaluate(value, ast.base, ctx) : [value];
      return bases.flatMap((v) => {
        if (v === null)
          return [null];
        if (!Array.isArray(v) && typeof v !== "string") {
          throw new Error(`Cannot slice ${typeof v} (${JSON.stringify(v)})`);
        }
        const len = v.length;
        const starts = ast.start ? evaluate(value, ast.start, ctx) : [0];
        const ends = ast.end ? evaluate(value, ast.end, ctx) : [len];
        return starts.flatMap((s) => ends.map((e) => {
          const sNum = s;
          const eNum = e;
          const startRaw = Number.isNaN(sNum) ? 0 : Number.isInteger(sNum) ? sNum : Math.floor(sNum);
          const endRaw = Number.isNaN(eNum) ? len : Number.isInteger(eNum) ? eNum : Math.ceil(eNum);
          const start = normalizeIndex(startRaw, len);
          const end = normalizeIndex(endRaw, len);
          return Array.isArray(v) ? v.slice(start, end) : v.slice(start, end);
        }));
      });
    }
    case "Iterate": {
      const bases = ast.base ? evaluate(value, ast.base, ctx) : [value];
      return bases.flatMap((v) => {
        if (Array.isArray(v))
          return v;
        if (v && typeof v === "object")
          return Object.values(v);
        return [];
      });
    }
    case "Pipe": {
      const leftResults = evaluate(value, ast.left, ctx);
      const leftPath = extractPathFromAst(ast.left);
      const pipeResults = [];
      for (const v of leftResults) {
        try {
          if (leftPath !== null) {
            const newCtx = {
              ...ctx,
              currentPath: [...ctx.currentPath ?? [], ...leftPath]
            };
            pipeResults.push(...evaluate(v, ast.right, newCtx));
          } else {
            pipeResults.push(...evaluate(v, ast.right, ctx));
          }
        } catch (e) {
          if (e instanceof BreakError) {
            throw e.withPrependedResults(pipeResults);
          }
          throw e;
        }
      }
      return pipeResults;
    }
    case "Comma": {
      const leftResults = evaluate(value, ast.left, ctx);
      const rightResults = evaluate(value, ast.right, ctx);
      return [...leftResults, ...rightResults];
    }
    case "Literal":
      return [ast.value];
    case "Array": {
      if (!ast.elements)
        return [[]];
      const elements = evaluate(value, ast.elements, ctx);
      return [elements];
    }
    case "Object": {
      const results = [{}];
      for (const entry of ast.entries) {
        const keys = typeof entry.key === "string" ? [entry.key] : evaluate(value, entry.key, ctx);
        const values = evaluate(value, entry.value, ctx);
        const newResults = [];
        for (const obj of results) {
          for (const k of keys) {
            if (typeof k !== "string") {
              const typeName = k === null ? "null" : Array.isArray(k) ? "array" : typeof k;
              throw new Error(`Cannot use ${typeName} (${JSON.stringify(k)}) as object key`);
            }
            for (const v of values) {
              newResults.push({ ...obj, [k]: v });
            }
          }
        }
        results.length = 0;
        results.push(...newResults);
      }
      return results;
    }
    case "Paren":
      return evaluate(value, ast.expr, ctx);
    case "BinaryOp":
      return evalBinaryOp(value, ast.op, ast.left, ast.right, ctx);
    case "UnaryOp": {
      const operands = evaluate(value, ast.operand, ctx);
      return operands.map((v) => {
        if (ast.op === "-") {
          if (typeof v === "number")
            return -v;
          if (typeof v === "string") {
            const formatStr = /* @__PURE__ */ __name((s) => s.length > 5 ? `"${s.slice(0, 3)}...` : JSON.stringify(s), "formatStr");
            throw new Error(`string (${formatStr(v)}) cannot be negated`);
          }
          return null;
        }
        if (ast.op === "not")
          return !isTruthy(v);
        return null;
      });
    }
    case "Cond": {
      const conds = evaluate(value, ast.cond, ctx);
      return conds.flatMap((c) => {
        if (isTruthy(c)) {
          return evaluate(value, ast.then, ctx);
        }
        for (const elif of ast.elifs) {
          const elifConds = evaluate(value, elif.cond, ctx);
          if (elifConds.some(isTruthy)) {
            return evaluate(value, elif.then, ctx);
          }
        }
        if (ast.else) {
          return evaluate(value, ast.else, ctx);
        }
        return [value];
      });
    }
    case "Try": {
      try {
        return evaluate(value, ast.body, ctx);
      } catch (e) {
        if (ast.catch) {
          const errorVal = e instanceof JqError ? e.value : e instanceof Error ? e.message : String(e);
          return evaluate(errorVal, ast.catch, ctx);
        }
        return [];
      }
    }
    case "Call":
      return evalBuiltin(value, ast.name, ast.args, ctx);
    case "VarBind": {
      const values = evaluate(value, ast.value, ctx);
      return values.flatMap((v) => {
        let newCtx = null;
        const patternsToTry = [];
        if (ast.pattern) {
          patternsToTry.push(ast.pattern);
        } else if (ast.name) {
          patternsToTry.push({ type: "var", name: ast.name });
        }
        if (ast.alternatives) {
          patternsToTry.push(...ast.alternatives);
        }
        for (const pattern of patternsToTry) {
          newCtx = bindPattern(ctx, pattern, v);
          if (newCtx !== null) {
            break;
          }
        }
        if (newCtx === null) {
          return [];
        }
        return evaluate(value, ast.body, newCtx);
      });
    }
    case "VarRef": {
      if (ast.name === "$ENV") {
        return [ctx.env ?? {}];
      }
      const v = ctx.vars.get(ast.name);
      return v !== void 0 ? [v] : [null];
    }
    case "Recurse": {
      const results = [];
      const seen = /* @__PURE__ */ new WeakSet();
      const walk = /* @__PURE__ */ __name((val) => {
        if (val && typeof val === "object") {
          if (seen.has(val))
            return;
          seen.add(val);
        }
        results.push(val);
        if (Array.isArray(val)) {
          for (const item of val)
            walk(item);
        } else if (val && typeof val === "object") {
          for (const key of Object.keys(val)) {
            walk(val[key]);
          }
        }
      }, "walk");
      walk(value);
      return results;
    }
    case "Optional": {
      try {
        return evaluate(value, ast.expr, ctx);
      } catch {
        return [];
      }
    }
    case "StringInterp": {
      const parts = ast.parts.map((part) => {
        if (typeof part === "string")
          return part;
        const vals = evaluate(value, part, ctx);
        return vals.map((v) => typeof v === "string" ? v : JSON.stringify(v)).join("");
      });
      return [parts.join("")];
    }
    case "UpdateOp": {
      return [applyUpdate(value, ast.path, ast.op, ast.value, ctx)];
    }
    case "Reduce": {
      const items = evaluate(value, ast.expr, ctx);
      let accumulator = evaluate(value, ast.init, ctx)[0];
      const maxDepth = ctx.limits.maxDepth ?? DEFAULT_MAX_JQ_DEPTH3;
      for (const item of items) {
        let newCtx;
        if (ast.pattern) {
          newCtx = bindPattern(ctx, ast.pattern, item);
          if (newCtx === null)
            continue;
        } else {
          newCtx = withVar(ctx, ast.varName, item);
        }
        accumulator = evaluate(accumulator, ast.update, newCtx)[0];
        if (getValueDepth(accumulator, maxDepth + 1) > maxDepth) {
          return [null];
        }
      }
      return [accumulator];
    }
    case "Foreach": {
      const items = evaluate(value, ast.expr, ctx);
      let state = evaluate(value, ast.init, ctx)[0];
      const foreachResults = [];
      for (const item of items) {
        try {
          let newCtx;
          if (ast.pattern) {
            newCtx = bindPattern(ctx, ast.pattern, item);
            if (newCtx === null)
              continue;
          } else {
            newCtx = withVar(ctx, ast.varName, item);
          }
          state = evaluate(state, ast.update, newCtx)[0];
          if (ast.extract) {
            const extracted = evaluate(state, ast.extract, newCtx);
            foreachResults.push(...extracted);
          } else {
            foreachResults.push(state);
          }
        } catch (e) {
          if (e instanceof BreakError) {
            throw e.withPrependedResults(foreachResults);
          }
          throw e;
        }
      }
      return foreachResults;
    }
    case "Label": {
      try {
        return evaluate(value, ast.body, {
          ...ctx,
          labels: /* @__PURE__ */ new Set([...ctx.labels ?? [], ast.name])
        });
      } catch (e) {
        if (e instanceof BreakError && e.label === ast.name) {
          return e.partialResults;
        }
        throw e;
      }
    }
    case "Break": {
      throw new BreakError(ast.name);
    }
    case "Def": {
      const newFuncs = new Map(ctx.funcs ?? []);
      const funcKey = `${ast.name}/${ast.params.length}`;
      newFuncs.set(funcKey, {
        params: ast.params,
        body: ast.funcBody,
        closure: new Map(ctx.funcs ?? [])
      });
      const newCtx = { ...ctx, funcs: newFuncs };
      return evaluate(value, ast.body, newCtx);
    }
    default: {
      const _exhaustive = ast;
      throw new Error(`Unknown AST node type: ${_exhaustive.type}`);
    }
  }
}
__name(evaluate, "evaluate");
function normalizeIndex(idx, len) {
  if (idx < 0)
    return Math.max(0, len + idx);
  return Math.min(idx, len);
}
__name(normalizeIndex, "normalizeIndex");
function applyUpdate(root, pathExpr, op, valueExpr, ctx) {
  function computeNewValue(current, newVal) {
    switch (op) {
      case "=":
        return newVal;
      case "|=": {
        const results = evaluate(current, valueExpr, ctx);
        return results[0] ?? null;
      }
      case "+=":
        if (typeof current === "number" && typeof newVal === "number")
          return current + newVal;
        if (typeof current === "string" && typeof newVal === "string")
          return current + newVal;
        if (Array.isArray(current) && Array.isArray(newVal))
          return [...current, ...newVal];
        if (current && newVal && typeof current === "object" && typeof newVal === "object") {
          return { ...current, ...newVal };
        }
        return newVal;
      case "-=":
        if (typeof current === "number" && typeof newVal === "number")
          return current - newVal;
        return current;
      case "*=":
        if (typeof current === "number" && typeof newVal === "number")
          return current * newVal;
        return current;
      case "/=":
        if (typeof current === "number" && typeof newVal === "number")
          return current / newVal;
        return current;
      case "%=":
        if (typeof current === "number" && typeof newVal === "number")
          return current % newVal;
        return current;
      case "//=":
        return current === null || current === false ? newVal : current;
      default:
        return newVal;
    }
  }
  __name(computeNewValue, "computeNewValue");
  function updateRecursive(val, path, transform) {
    switch (path.type) {
      case "Identity":
        return transform(val);
      case "Field": {
        if (path.base) {
          return updateRecursive(val, path.base, (baseVal) => {
            if (baseVal && typeof baseVal === "object" && !Array.isArray(baseVal)) {
              const obj = { ...baseVal };
              obj[path.name] = transform(obj[path.name]);
              return obj;
            }
            return baseVal;
          });
        }
        if (val && typeof val === "object" && !Array.isArray(val)) {
          const obj = { ...val };
          obj[path.name] = transform(obj[path.name]);
          return obj;
        }
        return val;
      }
      case "Index": {
        const indices = evaluate(root, path.index, ctx);
        let idx = indices[0];
        if (typeof idx === "number" && Number.isNaN(idx)) {
          throw new Error("Cannot set array element at NaN index");
        }
        if (typeof idx === "number" && !Number.isInteger(idx)) {
          idx = Math.trunc(idx);
        }
        if (path.base) {
          return updateRecursive(val, path.base, (baseVal) => {
            if (typeof idx === "number" && Array.isArray(baseVal)) {
              const arr = [...baseVal];
              const i = idx < 0 ? arr.length + idx : idx;
              if (i >= 0) {
                while (arr.length <= i)
                  arr.push(null);
                arr[i] = transform(arr[i]);
              }
              return arr;
            }
            if (typeof idx === "string" && baseVal && typeof baseVal === "object" && !Array.isArray(baseVal)) {
              const obj = { ...baseVal };
              obj[idx] = transform(obj[idx]);
              return obj;
            }
            return baseVal;
          });
        }
        if (typeof idx === "number") {
          const MAX_ARRAY_INDEX = 536870911;
          if (idx > MAX_ARRAY_INDEX) {
            throw new Error("Array index too large");
          }
          if (idx < 0 && (!val || !Array.isArray(val))) {
            throw new Error("Out of bounds negative array index");
          }
          if (Array.isArray(val)) {
            const arr = [...val];
            const i = idx < 0 ? arr.length + idx : idx;
            if (i >= 0) {
              while (arr.length <= i)
                arr.push(null);
              arr[i] = transform(arr[i]);
            }
            return arr;
          }
          if (val === null || val === void 0) {
            const arr = [];
            while (arr.length <= idx)
              arr.push(null);
            arr[idx] = transform(null);
            return arr;
          }
          return val;
        }
        if (typeof idx === "string" && val && typeof val === "object" && !Array.isArray(val)) {
          const obj = { ...val };
          obj[idx] = transform(obj[idx]);
          return obj;
        }
        return val;
      }
      case "Iterate": {
        const applyToContainer = /* @__PURE__ */ __name((container) => {
          if (Array.isArray(container)) {
            return container.map((item) => transform(item));
          }
          if (container && typeof container === "object") {
            const obj = {};
            for (const [k, v] of Object.entries(container)) {
              obj[k] = transform(v);
            }
            return obj;
          }
          return container;
        }, "applyToContainer");
        if (path.base) {
          return updateRecursive(val, path.base, applyToContainer);
        }
        return applyToContainer(val);
      }
      case "Pipe": {
        const leftResult = updateRecursive(val, path.left, (x) => x);
        return updateRecursive(leftResult, path.right, transform);
      }
      default:
        return transform(val);
    }
  }
  __name(updateRecursive, "updateRecursive");
  const transformer = /* @__PURE__ */ __name((current) => {
    if (op === "|=") {
      return computeNewValue(current, current);
    }
    const newVals = evaluate(root, valueExpr, ctx);
    return computeNewValue(current, newVals[0] ?? null);
  }, "transformer");
  return updateRecursive(root, pathExpr, transformer);
}
__name(applyUpdate, "applyUpdate");
function applyDel(root, pathExpr, ctx) {
  function setAtPath(obj, pathNode, newVal) {
    switch (pathNode.type) {
      case "Identity":
        return newVal;
      case "Field": {
        if (pathNode.base) {
          const nested = evaluate(obj, pathNode.base, ctx)[0];
          const modified = setAtPath(nested, { type: "Field", name: pathNode.name }, newVal);
          return setAtPath(obj, pathNode.base, modified);
        }
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
          return { ...obj, [pathNode.name]: newVal };
        }
        return obj;
      }
      case "Index": {
        if (pathNode.base) {
          const nested = evaluate(obj, pathNode.base, ctx)[0];
          const modified = setAtPath(nested, { type: "Index", index: pathNode.index }, newVal);
          return setAtPath(obj, pathNode.base, modified);
        }
        const indices = evaluate(root, pathNode.index, ctx);
        const idx = indices[0];
        if (typeof idx === "number" && Array.isArray(obj)) {
          const arr = [...obj];
          const i = idx < 0 ? arr.length + idx : idx;
          if (i >= 0 && i < arr.length) {
            arr[i] = newVal;
          }
          return arr;
        }
        if (typeof idx === "string" && obj && typeof obj === "object" && !Array.isArray(obj)) {
          return { ...obj, [idx]: newVal };
        }
        return obj;
      }
      default:
        return obj;
    }
  }
  __name(setAtPath, "setAtPath");
  function deleteAt(val, path) {
    switch (path.type) {
      case "Identity":
        return null;
      case "Field": {
        if (path.base) {
          const nested = evaluate(val, path.base, ctx)[0];
          if (nested === null || nested === void 0) {
            return val;
          }
          const modified = deleteAt(nested, { type: "Field", name: path.name });
          return setAtPath(val, path.base, modified);
        }
        if (val && typeof val === "object" && !Array.isArray(val)) {
          const obj = { ...val };
          delete obj[path.name];
          return obj;
        }
        return val;
      }
      case "Index": {
        if (path.base) {
          const nested = evaluate(val, path.base, ctx)[0];
          if (nested === null || nested === void 0) {
            return val;
          }
          const modified = deleteAt(nested, {
            type: "Index",
            index: path.index
          });
          return setAtPath(val, path.base, modified);
        }
        const indices = evaluate(root, path.index, ctx);
        const idx = indices[0];
        if (typeof idx === "number" && Array.isArray(val)) {
          const arr = [...val];
          const i = idx < 0 ? arr.length + idx : idx;
          if (i >= 0 && i < arr.length) {
            arr.splice(i, 1);
          }
          return arr;
        }
        if (typeof idx === "string" && val && typeof val === "object" && !Array.isArray(val)) {
          const obj = { ...val };
          delete obj[idx];
          return obj;
        }
        return val;
      }
      case "Iterate": {
        if (Array.isArray(val)) {
          return [];
        }
        if (val && typeof val === "object") {
          return {};
        }
        return val;
      }
      case "Pipe": {
        let setAt2 = function(obj, pathNode, newVal) {
          switch (pathNode.type) {
            case "Identity":
              return newVal;
            case "Field": {
              if (obj && typeof obj === "object" && !Array.isArray(obj)) {
                return { ...obj, [pathNode.name]: newVal };
              }
              return obj;
            }
            case "Index": {
              const indices = evaluate(root, pathNode.index, ctx);
              const idx = indices[0];
              if (typeof idx === "number" && Array.isArray(obj)) {
                const arr = [...obj];
                const i = idx < 0 ? arr.length + idx : idx;
                if (i >= 0 && i < arr.length) {
                  arr[i] = newVal;
                }
                return arr;
              }
              if (typeof idx === "string" && obj && typeof obj === "object" && !Array.isArray(obj)) {
                return { ...obj, [idx]: newVal };
              }
              return obj;
            }
            case "Pipe": {
              const innerVal = evaluate(obj, pathNode.left, ctx)[0];
              const modified2 = setAt2(innerVal, pathNode.right, newVal);
              return setAt2(obj, pathNode.left, modified2);
            }
            default:
              return obj;
          }
        };
        var setAt = setAt2;
        __name(setAt2, "setAt");
        const leftPath = path.left;
        const rightPath = path.right;
        const nested = evaluate(val, leftPath, ctx)[0];
        if (nested === null || nested === void 0) {
          return val;
        }
        const modified = deleteAt(nested, rightPath);
        return setAt2(val, leftPath, modified);
      }
      default:
        return val;
    }
  }
  __name(deleteAt, "deleteAt");
  return deleteAt(root, pathExpr);
}
__name(applyDel, "applyDel");
function evalBinaryOp(value, op, left, right, ctx) {
  if (op === "and") {
    const leftVals2 = evaluate(value, left, ctx);
    return leftVals2.flatMap((l) => {
      if (!isTruthy(l))
        return [false];
      const rightVals2 = evaluate(value, right, ctx);
      return rightVals2.map((r) => isTruthy(r));
    });
  }
  if (op === "or") {
    const leftVals2 = evaluate(value, left, ctx);
    return leftVals2.flatMap((l) => {
      if (isTruthy(l))
        return [true];
      const rightVals2 = evaluate(value, right, ctx);
      return rightVals2.map((r) => isTruthy(r));
    });
  }
  if (op === "//") {
    const leftVals2 = evaluate(value, left, ctx);
    const nonNull = leftVals2.filter((v) => v !== null && v !== void 0 && v !== false);
    if (nonNull.length > 0)
      return nonNull;
    return evaluate(value, right, ctx);
  }
  const leftVals = evaluate(value, left, ctx);
  const rightVals = evaluate(value, right, ctx);
  return leftVals.flatMap((l) => rightVals.map((r) => {
    switch (op) {
      case "+":
        if (l === null)
          return r;
        if (r === null)
          return l;
        if (typeof l === "number" && typeof r === "number")
          return l + r;
        if (typeof l === "string" && typeof r === "string")
          return l + r;
        if (Array.isArray(l) && Array.isArray(r))
          return [...l, ...r];
        if (l && r && typeof l === "object" && typeof r === "object" && !Array.isArray(l) && !Array.isArray(r)) {
          return { ...l, ...r };
        }
        return null;
      case "-":
        if (typeof l === "number" && typeof r === "number")
          return l - r;
        if (Array.isArray(l) && Array.isArray(r)) {
          const rSet = new Set(r.map((x) => JSON.stringify(x)));
          return l.filter((x) => !rSet.has(JSON.stringify(x)));
        }
        if (typeof l === "string" && typeof r === "string") {
          const formatStr = /* @__PURE__ */ __name((s) => s.length > 10 ? `"${s.slice(0, 10)}...` : JSON.stringify(s), "formatStr");
          throw new Error(`string (${formatStr(l)}) and string (${formatStr(r)}) cannot be subtracted`);
        }
        return null;
      case "*":
        if (typeof l === "number" && typeof r === "number")
          return l * r;
        if (typeof l === "string" && typeof r === "number")
          return l.repeat(r);
        if (l && r && typeof l === "object" && typeof r === "object" && !Array.isArray(l) && !Array.isArray(r)) {
          return deepMerge(l, r);
        }
        return null;
      case "/":
        if (typeof l === "number" && typeof r === "number") {
          if (r === 0) {
            throw new Error(`number (${l}) and number (${r}) cannot be divided because the divisor is zero`);
          }
          return l / r;
        }
        if (typeof l === "string" && typeof r === "string")
          return l.split(r);
        return null;
      case "%":
        if (typeof l === "number" && typeof r === "number") {
          if (r === 0) {
            throw new Error(`number (${l}) and number (${r}) cannot be divided (remainder) because the divisor is zero`);
          }
          if (!Number.isFinite(l) && !Number.isNaN(l)) {
            if (!Number.isFinite(r) && !Number.isNaN(r)) {
              return l < 0 && r > 0 ? -1 : 0;
            }
            return 0;
          }
          return l % r;
        }
        return null;
      case "==":
        return deepEqual(l, r);
      case "!=":
        return !deepEqual(l, r);
      case "<":
        return compare(l, r) < 0;
      case "<=":
        return compare(l, r) <= 0;
      case ">":
        return compare(l, r) > 0;
      case ">=":
        return compare(l, r) >= 0;
      default:
        return null;
    }
  }));
}
__name(evalBinaryOp, "evalBinaryOp");
function evalBuiltin(value, name, args, ctx) {
  const simpleMathFn = SIMPLE_MATH_FUNCTIONS[name];
  if (simpleMathFn) {
    if (typeof value === "number")
      return [simpleMathFn(value)];
    return [null];
  }
  const mathResult = evalMathBuiltin(value, name, args, ctx, evaluate);
  if (mathResult !== null)
    return mathResult;
  const stringResult = evalStringBuiltin(value, name, args, ctx, evaluate);
  if (stringResult !== null)
    return stringResult;
  const dateResult = evalDateBuiltin(value, name, args, ctx, evaluate);
  if (dateResult !== null)
    return dateResult;
  const formatResult = evalFormatBuiltin(value, name, ctx.limits.maxDepth);
  if (formatResult !== null)
    return formatResult;
  const typeResult = evalTypeBuiltin(value, name);
  if (typeResult !== null)
    return typeResult;
  const objectResult = evalObjectBuiltin(value, name, args, ctx, evaluate);
  if (objectResult !== null)
    return objectResult;
  const arrayResult = evalArrayBuiltin(value, name, args, ctx, evaluate, evaluateWithPartialResults, compareJq, isTruthy, containsDeep, ExecutionLimitError);
  if (arrayResult !== null)
    return arrayResult;
  const pathResult = evalPathBuiltin(value, name, args, ctx, evaluate, isTruthy, setPath, deletePath, applyDel, collectPaths);
  if (pathResult !== null)
    return pathResult;
  const indexResult = evalIndexBuiltin(value, name, args, ctx, evaluate, deepEqual);
  if (indexResult !== null)
    return indexResult;
  const controlResult = evalControlBuiltin(value, name, args, ctx, evaluate, evaluateWithPartialResults, isTruthy, ExecutionLimitError);
  if (controlResult !== null)
    return controlResult;
  const navigationResult = evalNavigationBuiltin(value, name, args, ctx, evaluate, isTruthy, getValueAtPath, evalBuiltin);
  if (navigationResult !== null)
    return navigationResult;
  const sqlResult = evalSqlBuiltin(value, name, args, ctx, evaluate, deepEqual);
  if (sqlResult !== null)
    return sqlResult;
  switch (name) {
    // keys, keys_unsorted, length, utf8bytelength, type, to_entries, from_entries,
    // with_entries, reverse, flatten, unique, tojson, tojsonstream, fromjson,
    // tostring, tonumber, toboolean, tostream, fromstream, truncate_stream
    // handled by evalObjectBuiltin
    //
    // sort, sort_by, bsearch, unique_by, group_by, max, max_by, min, min_by,
    // add, any, all, select, map, map_values, has, in, contains, inside
    // handled by evalArrayBuiltin
    //
    // getpath, setpath, delpaths, path, del, pick, paths, leaf_paths
    // handled by evalPathBuiltin
    //
    // index, rindex, indices handled by evalIndexBuiltin
    //
    // first, last, nth, range, limit, isempty, isvalid, skip, until, while, repeat
    // handled by evalControlBuiltin
    //
    // recurse, recurse_down, walk, transpose, combinations, parent, parents, root
    // handled by evalNavigationBuiltin
    //
    // IN, INDEX, JOIN handled by evalSqlBuiltin
    case "builtins":
      return [
        [
          "add/0",
          "all/0",
          "all/1",
          "all/2",
          "any/0",
          "any/1",
          "any/2",
          "arrays/0",
          "ascii/0",
          "ascii_downcase/0",
          "ascii_upcase/0",
          "booleans/0",
          "bsearch/1",
          "builtins/0",
          "combinations/0",
          "combinations/1",
          "contains/1",
          "debug/0",
          "del/1",
          "delpaths/1",
          "empty/0",
          "env/0",
          "error/0",
          "error/1",
          "explode/0",
          "first/0",
          "first/1",
          "flatten/0",
          "flatten/1",
          "floor/0",
          "from_entries/0",
          "fromdate/0",
          "fromjson/0",
          "getpath/1",
          "gmtime/0",
          "group_by/1",
          "gsub/2",
          "gsub/3",
          "has/1",
          "implode/0",
          "IN/1",
          "IN/2",
          "INDEX/1",
          "INDEX/2",
          "index/1",
          "indices/1",
          "infinite/0",
          "inside/1",
          "isempty/1",
          "isnan/0",
          "isnormal/0",
          "isvalid/1",
          "iterables/0",
          "join/1",
          "keys/0",
          "keys_unsorted/0",
          "last/0",
          "last/1",
          "length/0",
          "limit/2",
          "ltrimstr/1",
          "map/1",
          "map_values/1",
          "match/1",
          "match/2",
          "max/0",
          "max_by/1",
          "min/0",
          "min_by/1",
          "mktime/0",
          "modulemeta/1",
          "nan/0",
          "not/0",
          "nth/1",
          "nth/2",
          "null/0",
          "nulls/0",
          "numbers/0",
          "objects/0",
          "path/1",
          "paths/0",
          "paths/1",
          "pick/1",
          "range/1",
          "range/2",
          "range/3",
          "recurse/0",
          "recurse/1",
          "recurse_down/0",
          "repeat/1",
          "reverse/0",
          "rindex/1",
          "rtrimstr/1",
          "scalars/0",
          "scan/1",
          "scan/2",
          "select/1",
          "setpath/2",
          "skip/2",
          "sort/0",
          "sort_by/1",
          "split/1",
          "splits/1",
          "splits/2",
          "sqrt/0",
          "startswith/1",
          "strftime/1",
          "strings/0",
          "strptime/1",
          "sub/2",
          "sub/3",
          "test/1",
          "test/2",
          "to_entries/0",
          "toboolean/0",
          "todate/0",
          "tojson/0",
          "tostream/0",
          "fromstream/1",
          "truncate_stream/1",
          "tonumber/0",
          "tostring/0",
          "transpose/0",
          "trim/0",
          "ltrim/0",
          "rtrim/0",
          "type/0",
          "unique/0",
          "unique_by/1",
          "until/2",
          "utf8bytelength/0",
          "values/0",
          "walk/1",
          "while/2",
          "with_entries/1"
        ]
      ];
    // empty, not, null, true, false handled by evalTypeBuiltin
    case "error": {
      const msg = args.length > 0 ? evaluate(value, args[0], ctx)[0] : value;
      throw new JqError(msg);
    }
    // first, last, nth, range handled by evalControlBuiltin
    // sort, sort_by, bsearch, unique_by, group_by, max, max_by, min, min_by,
    // add, any, all, select, map, map_values, has, in, contains, inside
    // handled by evalArrayBuiltin
    // getpath, setpath, delpaths, path, del, pick, paths, leaf_paths
    // handled by evalPathBuiltin
    // index, rindex, indices handled by evalIndexBuiltin
    case "env":
      return [ctx.env ?? {}];
    // recurse, recurse_down, walk, transpose, combinations, parent, parents, root
    // handled by evalNavigationBuiltin
    //
    // limit, isempty, isvalid, skip, until, while, repeat
    // handled by evalControlBuiltin
    case "debug":
      return [value];
    case "input_line_number":
      return [1];
    // parents, root handled by evalNavigationBuiltin
    // IN, INDEX, JOIN handled by evalSqlBuiltin
    default: {
      const funcKey = `${name}/${args.length}`;
      const userFunc = ctx.funcs?.get(funcKey);
      if (userFunc) {
        const baseFuncs = userFunc.closure ?? ctx.funcs ?? /* @__PURE__ */ new Map();
        const newFuncs = new Map(baseFuncs);
        newFuncs.set(funcKey, userFunc);
        for (let i = 0; i < userFunc.params.length; i++) {
          const paramName = userFunc.params[i];
          const argExpr = args[i];
          if (argExpr) {
            const argVals = evaluate(value, argExpr, ctx);
            let bodyNode;
            if (argVals.length === 0) {
              bodyNode = { type: "Call", name: "empty", args: [] };
            } else if (argVals.length === 1) {
              bodyNode = { type: "Literal", value: argVals[0] };
            } else {
              bodyNode = {
                type: "Literal",
                value: argVals[argVals.length - 1]
              };
              for (let j = argVals.length - 2; j >= 0; j--) {
                bodyNode = {
                  type: "Comma",
                  left: { type: "Literal", value: argVals[j] },
                  right: bodyNode
                };
              }
            }
            newFuncs.set(`${paramName}/0`, { params: [], body: bodyNode });
          }
        }
        const newCtx = { ...ctx, funcs: newFuncs };
        return evaluate(value, userFunc.body, newCtx);
      }
      throw new Error(`Unknown function: ${name}`);
    }
  }
}
__name(evalBuiltin, "evalBuiltin");
function collectPaths(value, expr, ctx, currentPath, paths) {
  if (expr.type === "Comma") {
    const comma = expr;
    collectPaths(value, comma.left, ctx, currentPath, paths);
    collectPaths(value, comma.right, ctx, currentPath, paths);
    return;
  }
  const staticPath = extractPathFromAst(expr);
  if (staticPath !== null) {
    paths.push([...currentPath, ...staticPath]);
    return;
  }
  if (expr.type === "Iterate") {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        paths.push([...currentPath, i]);
      }
    } else if (value && typeof value === "object") {
      for (const key of Object.keys(value)) {
        paths.push([...currentPath, key]);
      }
    }
    return;
  }
  if (expr.type === "Recurse") {
    const walkPaths = /* @__PURE__ */ __name((v, path) => {
      paths.push([...currentPath, ...path]);
      if (v && typeof v === "object") {
        if (Array.isArray(v)) {
          for (let i = 0; i < v.length; i++) {
            walkPaths(v[i], [...path, i]);
          }
        } else {
          for (const key of Object.keys(v)) {
            walkPaths(v[key], [...path, key]);
          }
        }
      }
    }, "walkPaths");
    walkPaths(value, []);
    return;
  }
  if (expr.type === "Pipe") {
    const leftPath = extractPathFromAst(expr.left);
    if (leftPath !== null) {
      const leftResults = evaluate(value, expr.left, ctx);
      for (const lv of leftResults) {
        collectPaths(lv, expr.right, ctx, [...currentPath, ...leftPath], paths);
      }
      return;
    }
  }
  const results = evaluate(value, expr, ctx);
  if (results.length > 0) {
    paths.push(currentPath);
  }
}
__name(collectPaths, "collectPaths");

// dist/commands/query-engine/parser.js
var KEYWORDS = {
  and: "AND",
  or: "OR",
  not: "NOT",
  if: "IF",
  // biome-ignore lint/suspicious/noThenProperty: jq keyword
  then: "THEN",
  elif: "ELIF",
  else: "ELSE",
  end: "END",
  as: "AS",
  try: "TRY",
  catch: "CATCH",
  true: "TRUE",
  false: "FALSE",
  null: "NULL",
  reduce: "REDUCE",
  foreach: "FOREACH",
  label: "LABEL",
  break: "BREAK",
  def: "DEF"
};
function tokenize(input) {
  const tokens = [];
  let pos = 0;
  const peek = /* @__PURE__ */ __name((offset = 0) => input[pos + offset], "peek");
  const advance = /* @__PURE__ */ __name(() => input[pos++], "advance");
  const isEof = /* @__PURE__ */ __name(() => pos >= input.length, "isEof");
  const isDigit = /* @__PURE__ */ __name((c) => c >= "0" && c <= "9", "isDigit");
  const isAlpha = /* @__PURE__ */ __name((c) => c >= "a" && c <= "z" || c >= "A" && c <= "Z" || c === "_", "isAlpha");
  const isAlnum = /* @__PURE__ */ __name((c) => isAlpha(c) || isDigit(c), "isAlnum");
  while (!isEof()) {
    const start = pos;
    const c = advance();
    if (c === " " || c === "	" || c === "\n" || c === "\r") {
      continue;
    }
    if (c === "#") {
      while (!isEof() && peek() !== "\n")
        advance();
      continue;
    }
    if (c === "." && peek() === ".") {
      advance();
      tokens.push({ type: "DOTDOT", pos: start });
      continue;
    }
    if (c === "=" && peek() === "=") {
      advance();
      tokens.push({ type: "EQ", pos: start });
      continue;
    }
    if (c === "!" && peek() === "=") {
      advance();
      tokens.push({ type: "NE", pos: start });
      continue;
    }
    if (c === "<" && peek() === "=") {
      advance();
      tokens.push({ type: "LE", pos: start });
      continue;
    }
    if (c === ">" && peek() === "=") {
      advance();
      tokens.push({ type: "GE", pos: start });
      continue;
    }
    if (c === "/" && peek() === "/") {
      advance();
      if (peek() === "=") {
        advance();
        tokens.push({ type: "UPDATE_ALT", pos: start });
      } else {
        tokens.push({ type: "ALT", pos: start });
      }
      continue;
    }
    if (c === "+" && peek() === "=") {
      advance();
      tokens.push({ type: "UPDATE_ADD", pos: start });
      continue;
    }
    if (c === "-" && peek() === "=") {
      advance();
      tokens.push({ type: "UPDATE_SUB", pos: start });
      continue;
    }
    if (c === "*" && peek() === "=") {
      advance();
      tokens.push({ type: "UPDATE_MUL", pos: start });
      continue;
    }
    if (c === "/" && peek() === "=") {
      advance();
      tokens.push({ type: "UPDATE_DIV", pos: start });
      continue;
    }
    if (c === "%" && peek() === "=") {
      advance();
      tokens.push({ type: "UPDATE_MOD", pos: start });
      continue;
    }
    if (c === "=" && peek() !== "=") {
      tokens.push({ type: "ASSIGN", pos: start });
      continue;
    }
    if (c === ".") {
      tokens.push({ type: "DOT", pos: start });
      continue;
    }
    if (c === "|") {
      if (peek() === "=") {
        advance();
        tokens.push({ type: "UPDATE_PIPE", pos: start });
      } else {
        tokens.push({ type: "PIPE", pos: start });
      }
      continue;
    }
    if (c === ",") {
      tokens.push({ type: "COMMA", pos: start });
      continue;
    }
    if (c === ":") {
      tokens.push({ type: "COLON", pos: start });
      continue;
    }
    if (c === ";") {
      tokens.push({ type: "SEMICOLON", pos: start });
      continue;
    }
    if (c === "(") {
      tokens.push({ type: "LPAREN", pos: start });
      continue;
    }
    if (c === ")") {
      tokens.push({ type: "RPAREN", pos: start });
      continue;
    }
    if (c === "[") {
      tokens.push({ type: "LBRACKET", pos: start });
      continue;
    }
    if (c === "]") {
      tokens.push({ type: "RBRACKET", pos: start });
      continue;
    }
    if (c === "{") {
      tokens.push({ type: "LBRACE", pos: start });
      continue;
    }
    if (c === "}") {
      tokens.push({ type: "RBRACE", pos: start });
      continue;
    }
    if (c === "?") {
      tokens.push({ type: "QUESTION", pos: start });
      continue;
    }
    if (c === "+") {
      tokens.push({ type: "PLUS", pos: start });
      continue;
    }
    if (c === "-") {
      tokens.push({ type: "MINUS", pos: start });
      continue;
    }
    if (c === "*") {
      tokens.push({ type: "STAR", pos: start });
      continue;
    }
    if (c === "/") {
      tokens.push({ type: "SLASH", pos: start });
      continue;
    }
    if (c === "%") {
      tokens.push({ type: "PERCENT", pos: start });
      continue;
    }
    if (c === "<") {
      tokens.push({ type: "LT", pos: start });
      continue;
    }
    if (c === ">") {
      tokens.push({ type: "GT", pos: start });
      continue;
    }
    if (isDigit(c)) {
      let num = c;
      while (!isEof() && (isDigit(peek()) || peek() === "." || peek() === "e" || peek() === "E")) {
        if ((peek() === "e" || peek() === "E") && (input[pos + 1] === "+" || input[pos + 1] === "-")) {
          num += advance();
          num += advance();
        } else {
          num += advance();
        }
      }
      tokens.push({ type: "NUMBER", value: Number(num), pos: start });
      continue;
    }
    if (c === '"') {
      let str = "";
      while (!isEof() && peek() !== '"') {
        if (peek() === "\\") {
          advance();
          if (isEof())
            break;
          const escaped = advance();
          switch (escaped) {
            case "n":
              str += "\n";
              break;
            case "r":
              str += "\r";
              break;
            case "t":
              str += "	";
              break;
            case "\\":
              str += "\\";
              break;
            case '"':
              str += '"';
              break;
            case "(":
              str += "\\(";
              break;
            // Keep for string interpolation
            default:
              str += escaped;
          }
        } else {
          str += advance();
        }
      }
      if (!isEof())
        advance();
      tokens.push({ type: "STRING", value: str, pos: start });
      continue;
    }
    if (isAlpha(c) || c === "$" || c === "@") {
      let ident = c;
      while (!isEof() && isAlnum(peek())) {
        ident += advance();
      }
      const keyword = KEYWORDS[ident];
      if (keyword) {
        tokens.push({ type: keyword, pos: start });
      } else {
        tokens.push({ type: "IDENT", value: ident, pos: start });
      }
      continue;
    }
    throw new Error(`Unexpected character '${c}' at position ${start}`);
  }
  tokens.push({ type: "EOF", pos });
  return tokens;
}
__name(tokenize, "tokenize");
var Parser = class _Parser {
  static {
    __name(this, "Parser");
  }
  tokens;
  pos = 0;
  constructor(tokens) {
    this.tokens = tokens;
  }
  peek(offset = 0) {
    return this.tokens[this.pos + offset] ?? { type: "EOF", pos: -1 };
  }
  advance() {
    return this.tokens[this.pos++];
  }
  check(type) {
    return this.peek().type === type;
  }
  match(...types) {
    for (const type of types) {
      if (this.check(type)) {
        return this.advance();
      }
    }
    return null;
  }
  expect(type, msg) {
    if (!this.check(type)) {
      throw new Error(`${msg} at position ${this.peek().pos}, got ${this.peek().type}`);
    }
    return this.advance();
  }
  parse() {
    const expr = this.parseExpr();
    if (!this.check("EOF")) {
      throw new Error(`Unexpected token ${this.peek().type} at position ${this.peek().pos}`);
    }
    return expr;
  }
  parseExpr() {
    return this.parsePipe();
  }
  /**
   * Parse a destructuring pattern for variable binding
   * Patterns can be:
   *   $var              - simple variable
   *   [$a, $b, ...]     - array destructuring
   *   {key: $a, ...}    - object destructuring
   *   {$a, ...}         - shorthand object destructuring (key same as var name)
   */
  parsePattern() {
    if (this.match("LBRACKET")) {
      const elements = [];
      if (!this.check("RBRACKET")) {
        elements.push(this.parsePattern());
        while (this.match("COMMA")) {
          if (this.check("RBRACKET"))
            break;
          elements.push(this.parsePattern());
        }
      }
      this.expect("RBRACKET", "Expected ']' after array pattern");
      return { type: "array", elements };
    }
    if (this.match("LBRACE")) {
      const fields = [];
      if (!this.check("RBRACE")) {
        fields.push(this.parsePatternField());
        while (this.match("COMMA")) {
          if (this.check("RBRACE"))
            break;
          fields.push(this.parsePatternField());
        }
      }
      this.expect("RBRACE", "Expected '}' after object pattern");
      return { type: "object", fields };
    }
    const tok = this.expect("IDENT", "Expected variable name in pattern");
    const name = tok.value;
    if (!name.startsWith("$")) {
      throw new Error(`Variable name must start with $ at position ${tok.pos}`);
    }
    return { type: "var", name };
  }
  /**
   * Parse a single field in an object destructuring pattern
   */
  parsePatternField() {
    if (this.match("LPAREN")) {
      const keyExpr = this.parseExpr();
      this.expect("RPAREN", "Expected ')' after computed key");
      this.expect("COLON", "Expected ':' after computed key");
      const pattern = this.parsePattern();
      return { key: keyExpr, pattern };
    }
    const tok = this.peek();
    if (tok.type === "IDENT") {
      const name = tok.value;
      if (name.startsWith("$")) {
        this.advance();
        if (this.match("COLON")) {
          const pattern = this.parsePattern();
          return { key: name.slice(1), pattern, keyVar: name };
        }
        return { key: name.slice(1), pattern: { type: "var", name } };
      }
      this.advance();
      if (this.match("COLON")) {
        const pattern = this.parsePattern();
        return { key: name, pattern };
      }
      return { key: name, pattern: { type: "var", name: `$${name}` } };
    }
    throw new Error(`Expected field name in object pattern at position ${tok.pos}`);
  }
  parsePipe() {
    let left = this.parseComma();
    while (this.match("PIPE")) {
      const right = this.parseComma();
      left = { type: "Pipe", left, right };
    }
    return left;
  }
  parseComma() {
    let left = this.parseVarBind();
    while (this.match("COMMA")) {
      const right = this.parseVarBind();
      left = { type: "Comma", left, right };
    }
    return left;
  }
  parseVarBind() {
    const expr = this.parseUpdate();
    if (this.match("AS")) {
      const pattern = this.parsePattern();
      const alternatives = [];
      while (this.check("QUESTION") && this.peekAhead(1)?.type === "ALT") {
        this.advance();
        this.advance();
        alternatives.push(this.parsePattern());
      }
      this.expect("PIPE", "Expected '|' after variable binding");
      const body = this.parseExpr();
      if (pattern.type === "var" && alternatives.length === 0) {
        return { type: "VarBind", name: pattern.name, value: expr, body };
      }
      return {
        type: "VarBind",
        name: pattern.type === "var" ? pattern.name : "",
        value: expr,
        body,
        pattern: pattern.type !== "var" ? pattern : void 0,
        alternatives: alternatives.length > 0 ? alternatives : void 0
      };
    }
    return expr;
  }
  /**
   * Peek at a token N positions ahead (0 = current, 1 = next, etc.)
   */
  peekAhead(n) {
    const idx = this.pos + n;
    return idx < this.tokens.length ? this.tokens[idx] : void 0;
  }
  parseUpdate() {
    const left = this.parseAlt();
    const opMap = {
      ASSIGN: "=",
      UPDATE_ADD: "+=",
      UPDATE_SUB: "-=",
      UPDATE_MUL: "*=",
      UPDATE_DIV: "/=",
      UPDATE_MOD: "%=",
      UPDATE_ALT: "//=",
      UPDATE_PIPE: "|="
    };
    const tok = this.match("ASSIGN", "UPDATE_ADD", "UPDATE_SUB", "UPDATE_MUL", "UPDATE_DIV", "UPDATE_MOD", "UPDATE_ALT", "UPDATE_PIPE");
    if (tok) {
      const value = this.parseVarBind();
      return { type: "UpdateOp", op: opMap[tok.type], path: left, value };
    }
    return left;
  }
  parseAlt() {
    let left = this.parseOr();
    while (this.match("ALT")) {
      const right = this.parseOr();
      left = { type: "BinaryOp", op: "//", left, right };
    }
    return left;
  }
  parseOr() {
    let left = this.parseAnd();
    while (this.match("OR")) {
      const right = this.parseAnd();
      left = { type: "BinaryOp", op: "or", left, right };
    }
    return left;
  }
  parseAnd() {
    let left = this.parseNot();
    while (this.match("AND")) {
      const right = this.parseNot();
      left = { type: "BinaryOp", op: "and", left, right };
    }
    return left;
  }
  parseNot() {
    return this.parseComparison();
  }
  parseComparison() {
    let left = this.parseAddSub();
    const opMap = {
      EQ: "==",
      NE: "!=",
      LT: "<",
      LE: "<=",
      GT: ">",
      GE: ">="
    };
    const tok = this.match("EQ", "NE", "LT", "LE", "GT", "GE");
    if (tok) {
      const right = this.parseAddSub();
      left = { type: "BinaryOp", op: opMap[tok.type], left, right };
    }
    return left;
  }
  parseAddSub() {
    let left = this.parseMulDiv();
    while (true) {
      if (this.match("PLUS")) {
        const right = this.parseMulDiv();
        left = { type: "BinaryOp", op: "+", left, right };
      } else if (this.match("MINUS")) {
        const right = this.parseMulDiv();
        left = { type: "BinaryOp", op: "-", left, right };
      } else {
        break;
      }
    }
    return left;
  }
  parseMulDiv() {
    let left = this.parseUnary();
    while (true) {
      if (this.match("STAR")) {
        const right = this.parseUnary();
        left = { type: "BinaryOp", op: "*", left, right };
      } else if (this.match("SLASH")) {
        const right = this.parseUnary();
        left = { type: "BinaryOp", op: "/", left, right };
      } else if (this.match("PERCENT")) {
        const right = this.parseUnary();
        left = { type: "BinaryOp", op: "%", left, right };
      } else {
        break;
      }
    }
    return left;
  }
  parseUnary() {
    if (this.match("MINUS")) {
      const operand = this.parseUnary();
      return { type: "UnaryOp", op: "-", operand };
    }
    return this.parsePostfix();
  }
  parsePostfix() {
    let expr = this.parsePrimary();
    while (true) {
      if (this.match("QUESTION")) {
        expr = { type: "Optional", expr };
      } else if (this.check("DOT") && (this.peek(1).type === "IDENT" || this.peek(1).type === "STRING")) {
        this.advance();
        const token = this.advance();
        const name = token.value;
        expr = { type: "Field", name, base: expr };
      } else if (this.check("LBRACKET")) {
        this.advance();
        if (this.match("RBRACKET")) {
          expr = { type: "Iterate", base: expr };
        } else if (this.check("COLON")) {
          this.advance();
          const end = this.check("RBRACKET") ? void 0 : this.parseExpr();
          this.expect("RBRACKET", "Expected ']'");
          expr = { type: "Slice", end, base: expr };
        } else {
          const indexExpr = this.parseExpr();
          if (this.match("COLON")) {
            const end = this.check("RBRACKET") ? void 0 : this.parseExpr();
            this.expect("RBRACKET", "Expected ']'");
            expr = { type: "Slice", start: indexExpr, end, base: expr };
          } else {
            this.expect("RBRACKET", "Expected ']'");
            expr = { type: "Index", index: indexExpr, base: expr };
          }
        }
      } else {
        break;
      }
    }
    return expr;
  }
  parsePrimary() {
    if (this.match("DOTDOT")) {
      return { type: "Recurse" };
    }
    if (this.match("DOT")) {
      if (this.check("LBRACKET")) {
        this.advance();
        if (this.match("RBRACKET")) {
          return { type: "Iterate" };
        }
        if (this.check("COLON")) {
          this.advance();
          const end = this.check("RBRACKET") ? void 0 : this.parseExpr();
          this.expect("RBRACKET", "Expected ']'");
          return { type: "Slice", end };
        }
        const indexExpr = this.parseExpr();
        if (this.match("COLON")) {
          const end = this.check("RBRACKET") ? void 0 : this.parseExpr();
          this.expect("RBRACKET", "Expected ']'");
          return { type: "Slice", start: indexExpr, end };
        }
        this.expect("RBRACKET", "Expected ']'");
        return { type: "Index", index: indexExpr };
      }
      if (this.check("IDENT") || this.check("STRING")) {
        const name = this.advance().value;
        return { type: "Field", name };
      }
      return { type: "Identity" };
    }
    if (this.match("TRUE")) {
      return { type: "Literal", value: true };
    }
    if (this.match("FALSE")) {
      return { type: "Literal", value: false };
    }
    if (this.match("NULL")) {
      return { type: "Literal", value: null };
    }
    if (this.check("NUMBER")) {
      const tok = this.advance();
      return { type: "Literal", value: tok.value };
    }
    if (this.check("STRING")) {
      const tok = this.advance();
      const str = tok.value;
      if (str.includes("\\(")) {
        return this.parseStringInterpolation(str);
      }
      return { type: "Literal", value: str };
    }
    if (this.match("LBRACKET")) {
      if (this.match("RBRACKET")) {
        return { type: "Array" };
      }
      const elements = this.parseExpr();
      this.expect("RBRACKET", "Expected ']'");
      return { type: "Array", elements };
    }
    if (this.match("LBRACE")) {
      return this.parseObjectConstruction();
    }
    if (this.match("LPAREN")) {
      const expr = this.parseExpr();
      this.expect("RPAREN", "Expected ')'");
      return { type: "Paren", expr };
    }
    if (this.match("IF")) {
      return this.parseIf();
    }
    if (this.match("TRY")) {
      const body = this.parsePostfix();
      let catchExpr;
      if (this.match("CATCH")) {
        catchExpr = this.parsePostfix();
      }
      return { type: "Try", body, catch: catchExpr };
    }
    if (this.match("REDUCE")) {
      const expr = this.parseAddSub();
      this.expect("AS", "Expected 'as' after reduce expression");
      const pattern = this.parsePattern();
      this.expect("LPAREN", "Expected '(' after variable");
      const init = this.parseExpr();
      this.expect("SEMICOLON", "Expected ';' after init expression");
      const update = this.parseExpr();
      this.expect("RPAREN", "Expected ')' after update expression");
      const varName = pattern.type === "var" ? pattern.name : "";
      return {
        type: "Reduce",
        expr,
        varName,
        init,
        update,
        pattern: pattern.type !== "var" ? pattern : void 0
      };
    }
    if (this.match("FOREACH")) {
      const expr = this.parseAddSub();
      this.expect("AS", "Expected 'as' after foreach expression");
      const pattern = this.parsePattern();
      this.expect("LPAREN", "Expected '(' after variable");
      const init = this.parseExpr();
      this.expect("SEMICOLON", "Expected ';' after init expression");
      const update = this.parseExpr();
      let extract;
      if (this.match("SEMICOLON")) {
        extract = this.parseExpr();
      }
      this.expect("RPAREN", "Expected ')' after expressions");
      const varName = pattern.type === "var" ? pattern.name : "";
      return {
        type: "Foreach",
        expr,
        varName,
        init,
        update,
        extract,
        pattern: pattern.type !== "var" ? pattern : void 0
      };
    }
    if (this.match("LABEL")) {
      const labelToken = this.expect("IDENT", "Expected label name (e.g., $out)");
      const labelName = labelToken.value;
      if (!labelName.startsWith("$")) {
        throw new Error(`Label name must start with $ at position ${labelToken.pos}`);
      }
      this.expect("PIPE", "Expected '|' after label name");
      const labelBody = this.parseExpr();
      return { type: "Label", name: labelName, body: labelBody };
    }
    if (this.match("BREAK")) {
      const breakToken = this.expect("IDENT", "Expected label name to break to");
      const breakLabel = breakToken.value;
      if (!breakLabel.startsWith("$")) {
        throw new Error(`Break label must start with $ at position ${breakToken.pos}`);
      }
      return { type: "Break", name: breakLabel };
    }
    if (this.match("DEF")) {
      const nameToken = this.expect("IDENT", "Expected function name after def");
      const funcName = nameToken.value;
      const params = [];
      if (this.match("LPAREN")) {
        if (!this.check("RPAREN")) {
          const firstParam = this.expect("IDENT", "Expected parameter name");
          params.push(firstParam.value);
          while (this.match("SEMICOLON")) {
            const param = this.expect("IDENT", "Expected parameter name");
            params.push(param.value);
          }
        }
        this.expect("RPAREN", "Expected ')' after parameters");
      }
      this.expect("COLON", "Expected ':' after function name");
      const funcBody = this.parseExpr();
      this.expect("SEMICOLON", "Expected ';' after function body");
      const body = this.parseExpr();
      return { type: "Def", name: funcName, params, funcBody, body };
    }
    if (this.match("NOT")) {
      return { type: "Call", name: "not", args: [] };
    }
    if (this.check("IDENT")) {
      const tok = this.advance();
      const name = tok.value;
      if (name.startsWith("$")) {
        return { type: "VarRef", name };
      }
      if (this.match("LPAREN")) {
        const args = [];
        if (!this.check("RPAREN")) {
          args.push(this.parseExpr());
          while (this.match("SEMICOLON")) {
            args.push(this.parseExpr());
          }
        }
        this.expect("RPAREN", "Expected ')'");
        return { type: "Call", name, args };
      }
      return { type: "Call", name, args: [] };
    }
    throw new Error(`Unexpected token ${this.peek().type} at position ${this.peek().pos}`);
  }
  parseObjectConstruction() {
    const entries = [];
    if (!this.check("RBRACE")) {
      do {
        let key;
        let value;
        if (this.match("LPAREN")) {
          key = this.parseExpr();
          this.expect("RPAREN", "Expected ')'");
          this.expect("COLON", "Expected ':'");
          value = this.parseObjectValue();
        } else if (this.check("IDENT")) {
          const ident = this.advance().value;
          if (this.match("COLON")) {
            key = ident;
            value = this.parseObjectValue();
          } else {
            key = ident;
            value = { type: "Field", name: ident };
          }
        } else if (this.check("STRING")) {
          key = this.advance().value;
          this.expect("COLON", "Expected ':'");
          value = this.parseObjectValue();
        } else {
          throw new Error(`Expected object key at position ${this.peek().pos}`);
        }
        entries.push({ key, value });
      } while (this.match("COMMA"));
    }
    this.expect("RBRACE", "Expected '}'");
    return { type: "Object", entries };
  }
  // Parse object value - allows pipes but stops at comma or rbrace
  // Uses parsePipe level to avoid consuming comma as part of expression
  parseObjectValue() {
    let left = this.parseVarBind();
    while (this.match("PIPE")) {
      const right = this.parseVarBind();
      left = { type: "Pipe", left, right };
    }
    return left;
  }
  parseIf() {
    const cond = this.parseExpr();
    this.expect("THEN", "Expected 'then'");
    const then = this.parseExpr();
    const elifs = [];
    while (this.match("ELIF")) {
      const elifCond = this.parseExpr();
      this.expect("THEN", "Expected 'then' after elif");
      const elifThen = this.parseExpr();
      elifs.push({ cond: elifCond, then: elifThen });
    }
    let elseExpr;
    if (this.match("ELSE")) {
      elseExpr = this.parseExpr();
    }
    this.expect("END", "Expected 'end'");
    return { type: "Cond", cond, then, elifs, else: elseExpr };
  }
  parseStringInterpolation(str) {
    const parts = [];
    let current = "";
    let i = 0;
    while (i < str.length) {
      if (str[i] === "\\" && str[i + 1] === "(") {
        if (current) {
          parts.push(current);
          current = "";
        }
        i += 2;
        let depth = 1;
        let exprStr = "";
        while (i < str.length && depth > 0) {
          if (str[i] === "(")
            depth++;
          else if (str[i] === ")")
            depth--;
          if (depth > 0)
            exprStr += str[i];
          i++;
        }
        const tokens = tokenize(exprStr);
        const parser = new _Parser(tokens);
        parts.push(parser.parse());
      } else {
        current += str[i];
        i++;
      }
    }
    if (current) {
      parts.push(current);
    }
    return { type: "StringInterp", parts };
  }
};
function parse(input) {
  const tokens = tokenize(input);
  const parser = new Parser(tokens);
  return parser.parse();
}
__name(parse, "parse");

export {
  evaluate,
  parse
};
