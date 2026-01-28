import {
  __name
} from "./chunk-Y7IWVHJ4.js";

// dist/utils/glob.js
var globRegexCache = /* @__PURE__ */ new Map();
function matchGlob(name, pattern, options) {
  const opts = typeof options === "boolean" ? { ignoreCase: options } : options ?? {};
  let cleanPattern = pattern;
  if (opts.stripQuotes) {
    if (cleanPattern.startsWith('"') && cleanPattern.endsWith('"') || cleanPattern.startsWith("'") && cleanPattern.endsWith("'")) {
      cleanPattern = cleanPattern.slice(1, -1);
    }
  }
  const cacheKey = opts.ignoreCase ? `i:${cleanPattern}` : cleanPattern;
  let re = globRegexCache.get(cacheKey);
  if (!re) {
    re = globToRegex(cleanPattern, opts.ignoreCase);
    globRegexCache.set(cacheKey, re);
  }
  return re.test(name);
}
__name(matchGlob, "matchGlob");
function globToRegex(pattern, ignoreCase) {
  let regex = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      regex += ".*";
    } else if (c === "?") {
      regex += ".";
    } else if (c === "[") {
      let j = i + 1;
      while (j < pattern.length && pattern[j] !== "]")
        j++;
      regex += pattern.slice(i, j + 1);
      i = j;
    } else if (c === "." || c === "+" || c === "^" || c === "$" || c === "{" || c === "}" || c === "(" || c === ")" || c === "|" || c === "\\") {
      regex += `\\${c}`;
    } else {
      regex += c;
    }
  }
  regex += "$";
  return new RegExp(regex, ignoreCase ? "i" : "");
}
__name(globToRegex, "globToRegex");

export {
  matchGlob
};
