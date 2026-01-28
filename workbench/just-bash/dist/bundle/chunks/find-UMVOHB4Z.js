import {
  matchGlob
} from "./chunk-YPYB6VZC.js";
import {
  applyWidth,
  parseWidthPrecision,
  processEscapes
} from "./chunk-NUDF4AYR.js";
import {
  hasHelpFlag,
  showHelp
} from "./chunk-HAN5425M.js";
import {
  __name
} from "./chunk-Y7IWVHJ4.js";

// dist/commands/find/matcher.js
function evaluateExpressionWithPrune(expr, ctx) {
  switch (expr.type) {
    case "name": {
      const pattern = expr.pattern;
      const extMatch = pattern.match(/^\*(\.[a-zA-Z0-9]+)$/);
      if (extMatch) {
        const requiredExt = extMatch[1];
        const name = ctx.name;
        if (expr.ignoreCase) {
          if (!name.toLowerCase().endsWith(requiredExt.toLowerCase())) {
            return { matches: false, pruned: false, printed: false };
          }
        } else {
          if (!name.endsWith(requiredExt)) {
            return { matches: false, pruned: false, printed: false };
          }
        }
        return { matches: true, pruned: false, printed: false };
      }
      return {
        matches: matchGlob(ctx.name, pattern, expr.ignoreCase),
        pruned: false,
        printed: false
      };
    }
    case "path": {
      const pattern = expr.pattern;
      const path = ctx.relativePath;
      const segments = pattern.split("/");
      for (let i = 0; i < segments.length - 1; i++) {
        const seg = segments[i];
        if (seg && seg !== "." && seg !== ".." && !seg.includes("*") && !seg.includes("?") && !seg.includes("[")) {
          const requiredSegment = `/${seg}/`;
          if (expr.ignoreCase) {
            if (!path.toLowerCase().includes(requiredSegment.toLowerCase())) {
              return { matches: false, pruned: false, printed: false };
            }
          } else {
            if (!path.includes(requiredSegment)) {
              return { matches: false, pruned: false, printed: false };
            }
          }
        }
      }
      const extMatch = pattern.match(/\*(\.[a-zA-Z0-9]+)$/);
      if (extMatch) {
        const requiredExt = extMatch[1];
        if (expr.ignoreCase) {
          if (!path.toLowerCase().endsWith(requiredExt.toLowerCase())) {
            return { matches: false, pruned: false, printed: false };
          }
        } else {
          if (!path.endsWith(requiredExt)) {
            return { matches: false, pruned: false, printed: false };
          }
        }
      }
      return {
        matches: matchGlob(path, pattern, expr.ignoreCase),
        pruned: false,
        printed: false
      };
    }
    case "regex": {
      try {
        const flags = expr.ignoreCase ? "i" : "";
        const regex = new RegExp(expr.pattern, flags);
        return {
          matches: regex.test(ctx.relativePath),
          pruned: false,
          printed: false
        };
      } catch {
        return { matches: false, pruned: false, printed: false };
      }
    }
    case "type":
      if (expr.fileType === "f")
        return { matches: ctx.isFile, pruned: false, printed: false };
      if (expr.fileType === "d")
        return { matches: ctx.isDirectory, pruned: false, printed: false };
      return { matches: false, pruned: false, printed: false };
    case "empty":
      return { matches: ctx.isEmpty, pruned: false, printed: false };
    case "mtime": {
      const now = Date.now();
      const fileAgeDays = (now - ctx.mtime) / (1e3 * 60 * 60 * 24);
      let matches;
      if (expr.comparison === "more") {
        matches = fileAgeDays > expr.days;
      } else if (expr.comparison === "less") {
        matches = fileAgeDays < expr.days;
      } else {
        matches = Math.floor(fileAgeDays) === expr.days;
      }
      return { matches, pruned: false, printed: false };
    }
    case "newer": {
      const refMtime = ctx.newerRefTimes.get(expr.refPath);
      if (refMtime === void 0)
        return { matches: false, pruned: false, printed: false };
      return { matches: ctx.mtime > refMtime, pruned: false, printed: false };
    }
    case "size": {
      let targetBytes = expr.value;
      switch (expr.unit) {
        case "c":
          targetBytes = expr.value;
          break;
        case "k":
          targetBytes = expr.value * 1024;
          break;
        case "M":
          targetBytes = expr.value * 1024 * 1024;
          break;
        case "G":
          targetBytes = expr.value * 1024 * 1024 * 1024;
          break;
        case "b":
          targetBytes = expr.value * 512;
          break;
      }
      let matches;
      if (expr.comparison === "more") {
        matches = ctx.size > targetBytes;
      } else if (expr.comparison === "less") {
        matches = ctx.size < targetBytes;
      } else if (expr.unit === "b") {
        const fileBlocks = Math.ceil(ctx.size / 512);
        matches = fileBlocks === expr.value;
      } else {
        matches = ctx.size === targetBytes;
      }
      return { matches, pruned: false, printed: false };
    }
    case "perm": {
      const fileMode = ctx.mode & 511;
      const targetMode = expr.mode & 511;
      let matches;
      if (expr.matchType === "exact") {
        matches = fileMode === targetMode;
      } else if (expr.matchType === "all") {
        matches = (fileMode & targetMode) === targetMode;
      } else {
        matches = (fileMode & targetMode) !== 0;
      }
      return { matches, pruned: false, printed: false };
    }
    case "prune":
      return { matches: true, pruned: true, printed: false };
    case "print":
      return { matches: true, pruned: false, printed: true };
    case "not": {
      const inner = evaluateExpressionWithPrune(expr.expr, ctx);
      return { matches: !inner.matches, pruned: inner.pruned, printed: false };
    }
    case "and": {
      const left = evaluateExpressionWithPrune(expr.left, ctx);
      if (!left.matches) {
        return { matches: false, pruned: left.pruned, printed: false };
      }
      const right = evaluateExpressionWithPrune(expr.right, ctx);
      return {
        matches: right.matches,
        pruned: left.pruned || right.pruned,
        printed: left.printed || right.printed
      };
    }
    case "or": {
      const left = evaluateExpressionWithPrune(expr.left, ctx);
      if (left.matches) {
        return left;
      }
      const right = evaluateExpressionWithPrune(expr.right, ctx);
      return {
        matches: right.matches,
        pruned: left.pruned || right.pruned,
        printed: right.printed
        // Only use right's printed since left didn't match
      };
    }
  }
}
__name(evaluateExpressionWithPrune, "evaluateExpressionWithPrune");
function expressionNeedsStatMetadata(expr) {
  if (!expr)
    return false;
  switch (expr.type) {
    // These only need name/path/type - available without stat
    case "name":
    case "path":
    case "regex":
    case "type":
    case "prune":
    case "print":
      return false;
    // These need stat metadata
    case "empty":
    // needs size for files
    case "mtime":
    case "newer":
    case "size":
    case "perm":
      return true;
    // Compound expressions - check children
    case "not":
      return expressionNeedsStatMetadata(expr.expr);
    case "and":
    case "or":
      return expressionNeedsStatMetadata(expr.left) || expressionNeedsStatMetadata(expr.right);
  }
}
__name(expressionNeedsStatMetadata, "expressionNeedsStatMetadata");
function expressionNeedsEmptyCheck(expr) {
  if (!expr)
    return false;
  switch (expr.type) {
    case "empty":
      return true;
    case "not":
      return expressionNeedsEmptyCheck(expr.expr);
    case "and":
    case "or":
      return expressionNeedsEmptyCheck(expr.left) || expressionNeedsEmptyCheck(expr.right);
    default:
      return false;
  }
}
__name(expressionNeedsEmptyCheck, "expressionNeedsEmptyCheck");
function extractPathPruningHints(expr) {
  const hint = {
    terminalDirName: null,
    requiredExtension: null
  };
  if (!expr)
    return hint;
  const pathExprs = collectPathExpressions(expr);
  const hasTypeFile = hasTypeFileFilter(expr);
  if (hasTypeFile && pathExprs.length === 1) {
    const pattern = pathExprs[0];
    const parts = pattern.split("/").filter((p) => p.length > 0);
    if (parts.length >= 2) {
      for (let i = parts.length - 2; i >= 0; i--) {
        const part = parts[i];
        if (!part.includes("*") && !part.includes("?") && !part.includes("[") && part !== "." && part !== "..") {
          const nextPart = parts[i + 1];
          if (nextPart && (nextPart.includes("*") || nextPart.includes("?"))) {
            hint.terminalDirName = part;
            const extMatch = nextPart.match(/^\*(\.[a-zA-Z0-9]+)$/);
            if (extMatch) {
              hint.requiredExtension = extMatch[1];
            }
          }
          break;
        }
      }
    }
  }
  return hint;
}
__name(extractPathPruningHints, "extractPathPruningHints");
function collectPathExpressions(expr) {
  const paths = [];
  const collect = /* @__PURE__ */ __name((e) => {
    if (e.type === "path") {
      paths.push(e.pattern);
    } else if (e.type === "not") {
      collect(e.expr);
    } else if (e.type === "and" || e.type === "or") {
      collect(e.left);
      collect(e.right);
    }
  }, "collect");
  collect(expr);
  return paths;
}
__name(collectPathExpressions, "collectPathExpressions");
function hasTypeFileFilter(expr) {
  const check = /* @__PURE__ */ __name((e) => {
    if (e.type === "type" && e.fileType === "f")
      return true;
    if (e.type === "not")
      return check(e.expr);
    if (e.type === "and")
      return check(e.left) || check(e.right);
    if (e.type === "or")
      return check(e.left) || check(e.right);
    return false;
  }, "check");
  return check(expr);
}
__name(hasTypeFileFilter, "hasTypeFileFilter");
function collectNewerRefs(expr) {
  const refs = [];
  const collect = /* @__PURE__ */ __name((e) => {
    if (!e)
      return;
    if (e.type === "newer") {
      refs.push(e.refPath);
    } else if (e.type === "not") {
      collect(e.expr);
    } else if (e.type === "and" || e.type === "or") {
      collect(e.left);
      collect(e.right);
    }
  }, "collect");
  collect(expr);
  return refs;
}
__name(collectNewerRefs, "collectNewerRefs");
function isSimpleExpression(expr) {
  if (!expr)
    return true;
  switch (expr.type) {
    // These only need name/path/type
    case "name":
    case "path":
    case "regex":
    case "type":
    case "prune":
    case "print":
      return true;
    // These need stat metadata or directory contents
    case "empty":
    case "mtime":
    case "newer":
    case "size":
    case "perm":
      return false;
    // Compound expressions - check children
    case "not":
      return isSimpleExpression(expr.expr);
    case "and":
    case "or":
      return isSimpleExpression(expr.left) && isSimpleExpression(expr.right);
  }
}
__name(isSimpleExpression, "isSimpleExpression");
function evaluateSimpleExpression(expr, name, relativePath, isFile, isDirectory) {
  switch (expr.type) {
    case "name": {
      const pattern = expr.pattern;
      const extMatch = pattern.match(/^\*(\.[a-zA-Z0-9]+)$/);
      if (extMatch) {
        const requiredExt = extMatch[1];
        if (expr.ignoreCase) {
          if (!name.toLowerCase().endsWith(requiredExt.toLowerCase())) {
            return { matches: false, pruned: false, printed: false };
          }
        } else {
          if (!name.endsWith(requiredExt)) {
            return { matches: false, pruned: false, printed: false };
          }
        }
        return { matches: true, pruned: false, printed: false };
      }
      return {
        matches: matchGlob(name, pattern, expr.ignoreCase),
        pruned: false,
        printed: false
      };
    }
    case "path": {
      const pattern = expr.pattern;
      const segments = pattern.split("/");
      for (let i = 0; i < segments.length - 1; i++) {
        const seg = segments[i];
        if (seg && seg !== "." && seg !== ".." && !seg.includes("*") && !seg.includes("?") && !seg.includes("[")) {
          const requiredSegment = `/${seg}/`;
          if (expr.ignoreCase) {
            if (!relativePath.toLowerCase().includes(requiredSegment.toLowerCase())) {
              return { matches: false, pruned: false, printed: false };
            }
          } else {
            if (!relativePath.includes(requiredSegment)) {
              return { matches: false, pruned: false, printed: false };
            }
          }
        }
      }
      const extMatch = pattern.match(/\*(\.[a-zA-Z0-9]+)$/);
      if (extMatch) {
        const requiredExt = extMatch[1];
        if (expr.ignoreCase) {
          if (!relativePath.toLowerCase().endsWith(requiredExt.toLowerCase())) {
            return { matches: false, pruned: false, printed: false };
          }
        } else {
          if (!relativePath.endsWith(requiredExt)) {
            return { matches: false, pruned: false, printed: false };
          }
        }
      }
      return {
        matches: matchGlob(relativePath, pattern, expr.ignoreCase),
        pruned: false,
        printed: false
      };
    }
    case "regex": {
      try {
        const flags = expr.ignoreCase ? "i" : "";
        const regex = new RegExp(expr.pattern, flags);
        return {
          matches: regex.test(relativePath),
          pruned: false,
          printed: false
        };
      } catch {
        return { matches: false, pruned: false, printed: false };
      }
    }
    case "type":
      if (expr.fileType === "f")
        return { matches: isFile, pruned: false, printed: false };
      if (expr.fileType === "d")
        return { matches: isDirectory, pruned: false, printed: false };
      return { matches: false, pruned: false, printed: false };
    case "prune":
      return { matches: true, pruned: true, printed: false };
    case "print":
      return { matches: true, pruned: false, printed: true };
    case "not": {
      const inner = evaluateSimpleExpression(expr.expr, name, relativePath, isFile, isDirectory);
      return { matches: !inner.matches, pruned: inner.pruned, printed: false };
    }
    case "and": {
      const left = evaluateSimpleExpression(expr.left, name, relativePath, isFile, isDirectory);
      if (!left.matches) {
        return { matches: false, pruned: left.pruned, printed: false };
      }
      const right = evaluateSimpleExpression(expr.right, name, relativePath, isFile, isDirectory);
      return {
        matches: right.matches,
        pruned: left.pruned || right.pruned,
        printed: left.printed || right.printed
      };
    }
    case "or": {
      const left = evaluateSimpleExpression(expr.left, name, relativePath, isFile, isDirectory);
      if (left.matches) {
        return left;
      }
      const right = evaluateSimpleExpression(expr.right, name, relativePath, isFile, isDirectory);
      return {
        matches: right.matches,
        pruned: left.pruned || right.pruned,
        printed: right.printed
      };
    }
    default:
      return { matches: false, pruned: false, printed: false };
  }
}
__name(evaluateSimpleExpression, "evaluateSimpleExpression");
function expressionHasPrune(expr) {
  if (!expr)
    return false;
  switch (expr.type) {
    case "prune":
      return true;
    case "not":
      return expressionHasPrune(expr.expr);
    case "and":
    case "or":
      return expressionHasPrune(expr.left) || expressionHasPrune(expr.right);
    default:
      return false;
  }
}
__name(expressionHasPrune, "expressionHasPrune");
function canEvaluateExpressionEarly(expr) {
  switch (expr.type) {
    // These only need name/path/type
    case "name":
    case "path":
    case "regex":
    case "type":
    case "prune":
    case "print":
      return true;
    // These need stat metadata or directory contents
    case "empty":
    case "mtime":
    case "newer":
    case "size":
    case "perm":
      return false;
    // Compound expressions - check children
    case "not":
      return canEvaluateExpressionEarly(expr.expr);
    case "and":
    case "or":
      return canEvaluateExpressionEarly(expr.left) && canEvaluateExpressionEarly(expr.right);
  }
}
__name(canEvaluateExpressionEarly, "canEvaluateExpressionEarly");
function evaluateForEarlyPrune(expr, ctx) {
  if (!expr || !ctx.isDirectory) {
    return { shouldPrune: false };
  }
  if (!canEvaluateExpressionEarly(expr)) {
    return evaluatePruneBranchEarly(expr, ctx);
  }
  const evalCtx = {
    name: ctx.name,
    relativePath: ctx.relativePath,
    isFile: ctx.isFile,
    isDirectory: ctx.isDirectory,
    isEmpty: false,
    // Not available early
    mtime: 0,
    size: 0,
    mode: 0,
    newerRefTimes: /* @__PURE__ */ new Map()
  };
  const result = evaluateExpressionWithPrune(expr, evalCtx);
  return { shouldPrune: result.pruned };
}
__name(evaluateForEarlyPrune, "evaluateForEarlyPrune");
function evaluatePruneBranchEarly(expr, ctx) {
  switch (expr.type) {
    case "or": {
      if (canEvaluateExpressionEarly(expr.left)) {
        const evalCtx = {
          name: ctx.name,
          relativePath: ctx.relativePath,
          isFile: ctx.isFile,
          isDirectory: ctx.isDirectory,
          isEmpty: false,
          mtime: 0,
          size: 0,
          mode: 0,
          newerRefTimes: /* @__PURE__ */ new Map()
        };
        const leftResult = evaluateExpressionWithPrune(expr.left, evalCtx);
        if (leftResult.pruned) {
          return { shouldPrune: true };
        }
      }
      return evaluatePruneBranchEarly(expr.right, ctx);
    }
    case "and": {
      if (canEvaluateExpressionEarly(expr.left) && canEvaluateExpressionEarly(expr.right)) {
        const evalCtx = {
          name: ctx.name,
          relativePath: ctx.relativePath,
          isFile: ctx.isFile,
          isDirectory: ctx.isDirectory,
          isEmpty: false,
          mtime: 0,
          size: 0,
          mode: 0,
          newerRefTimes: /* @__PURE__ */ new Map()
        };
        const result = evaluateExpressionWithPrune(expr, evalCtx);
        return { shouldPrune: result.pruned };
      }
      if (canEvaluateExpressionEarly(expr.left)) {
        const evalCtx = {
          name: ctx.name,
          relativePath: ctx.relativePath,
          isFile: ctx.isFile,
          isDirectory: ctx.isDirectory,
          isEmpty: false,
          mtime: 0,
          size: 0,
          mode: 0,
          newerRefTimes: /* @__PURE__ */ new Map()
        };
        const leftResult = evaluateExpressionWithPrune(expr.left, evalCtx);
        if (!leftResult.matches) {
          return { shouldPrune: false };
        }
        return evaluatePruneBranchEarly(expr.right, ctx);
      }
      return { shouldPrune: false };
    }
    case "not":
      return { shouldPrune: false };
    default:
      return { shouldPrune: false };
  }
}
__name(evaluatePruneBranchEarly, "evaluatePruneBranchEarly");

// dist/commands/find/parser.js
function parseExpressions(args, startIndex) {
  const tokens = [];
  const actions = [];
  let i = startIndex;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "(" || arg === "\\(") {
      tokens.push({ type: "lparen" });
      i++;
      continue;
    }
    if (arg === ")" || arg === "\\)") {
      tokens.push({ type: "rparen" });
      i++;
      continue;
    }
    if (arg === "-name" && i + 1 < args.length) {
      tokens.push({ type: "expr", expr: { type: "name", pattern: args[++i] } });
    } else if (arg === "-iname" && i + 1 < args.length) {
      tokens.push({
        type: "expr",
        expr: { type: "name", pattern: args[++i], ignoreCase: true }
      });
    } else if (arg === "-path" && i + 1 < args.length) {
      tokens.push({ type: "expr", expr: { type: "path", pattern: args[++i] } });
    } else if (arg === "-ipath" && i + 1 < args.length) {
      tokens.push({
        type: "expr",
        expr: { type: "path", pattern: args[++i], ignoreCase: true }
      });
    } else if (arg === "-regex" && i + 1 < args.length) {
      tokens.push({
        type: "expr",
        expr: { type: "regex", pattern: args[++i] }
      });
    } else if (arg === "-iregex" && i + 1 < args.length) {
      tokens.push({
        type: "expr",
        expr: { type: "regex", pattern: args[++i], ignoreCase: true }
      });
    } else if (arg === "-type" && i + 1 < args.length) {
      const fileType = args[++i];
      if (fileType === "f" || fileType === "d") {
        tokens.push({ type: "expr", expr: { type: "type", fileType } });
      } else {
        return {
          expr: null,
          pathIndex: i,
          error: `find: Unknown argument to -type: ${fileType}
`,
          actions: []
        };
      }
    } else if (arg === "-empty") {
      tokens.push({ type: "expr", expr: { type: "empty" } });
    } else if (arg === "-mtime" && i + 1 < args.length) {
      const mtimeArg = args[++i];
      let comparison = "exact";
      let daysStr = mtimeArg;
      if (mtimeArg.startsWith("+")) {
        comparison = "more";
        daysStr = mtimeArg.slice(1);
      } else if (mtimeArg.startsWith("-")) {
        comparison = "less";
        daysStr = mtimeArg.slice(1);
      }
      const days = parseInt(daysStr, 10);
      if (!Number.isNaN(days)) {
        tokens.push({
          type: "expr",
          expr: { type: "mtime", days, comparison }
        });
      }
    } else if (arg === "-newer" && i + 1 < args.length) {
      const refPath = args[++i];
      tokens.push({ type: "expr", expr: { type: "newer", refPath } });
    } else if (arg === "-size" && i + 1 < args.length) {
      const sizeArg = args[++i];
      let comparison = "exact";
      let sizeStr = sizeArg;
      if (sizeArg.startsWith("+")) {
        comparison = "more";
        sizeStr = sizeArg.slice(1);
      } else if (sizeArg.startsWith("-")) {
        comparison = "less";
        sizeStr = sizeArg.slice(1);
      }
      const sizeMatch = sizeStr.match(/^(\d+)([ckMGb])?$/);
      if (sizeMatch) {
        const value = parseInt(sizeMatch[1], 10);
        const unit = sizeMatch[2] || "b";
        tokens.push({
          type: "expr",
          expr: { type: "size", value, unit, comparison }
        });
      }
    } else if (arg === "-perm" && i + 1 < args.length) {
      const permArg = args[++i];
      let matchType = "exact";
      let modeStr = permArg;
      if (permArg.startsWith("-")) {
        matchType = "all";
        modeStr = permArg.slice(1);
      } else if (permArg.startsWith("/")) {
        matchType = "any";
        modeStr = permArg.slice(1);
      }
      const mode = parseInt(modeStr, 8);
      if (!Number.isNaN(mode)) {
        tokens.push({
          type: "expr",
          expr: { type: "perm", mode, matchType }
        });
      }
    } else if (arg === "-prune") {
      tokens.push({ type: "expr", expr: { type: "prune" } });
    } else if (arg === "-not" || arg === "!") {
      tokens.push({ type: "not" });
    } else if (arg === "-o" || arg === "-or") {
      tokens.push({ type: "op", op: "or" });
    } else if (arg === "-a" || arg === "-and") {
      tokens.push({ type: "op", op: "and" });
    } else if (arg === "-maxdepth" || arg === "-mindepth") {
      i++;
    } else if (arg === "-depth") {
    } else if (arg === "-exec") {
      const commandParts = [];
      i++;
      while (i < args.length && args[i] !== ";" && args[i] !== "+") {
        commandParts.push(args[i]);
        i++;
      }
      if (i >= args.length) {
        return {
          expr: null,
          pathIndex: i,
          error: "find: missing argument to `-exec'\n",
          actions: []
        };
      }
      const batchMode = args[i] === "+";
      actions.push({ type: "exec", command: commandParts, batchMode });
    } else if (arg === "-print") {
      tokens.push({ type: "expr", expr: { type: "print" } });
      actions.push({ type: "print" });
    } else if (arg === "-print0") {
      actions.push({ type: "print0" });
    } else if (arg === "-printf" && i + 1 < args.length) {
      const format = args[++i];
      actions.push({ type: "printf", format });
    } else if (arg === "-delete") {
      actions.push({ type: "delete" });
    } else if (arg.startsWith("-")) {
      return {
        expr: null,
        pathIndex: i,
        error: `find: unknown predicate '${arg}'
`,
        actions: []
      };
    } else {
      if (tokens.length === 0) {
        i++;
        continue;
      }
      break;
    }
    i++;
  }
  if (tokens.length === 0) {
    return { expr: null, pathIndex: i, actions };
  }
  const result = buildExpressionTree(tokens);
  if (result.error) {
    return { expr: null, pathIndex: i, error: result.error, actions };
  }
  return { expr: result.expr, pathIndex: i, actions };
}
__name(parseExpressions, "parseExpressions");
function buildExpressionTree(tokens) {
  let pos = 0;
  function parseOr() {
    let left = parseAnd();
    if (!left)
      return null;
    while (pos < tokens.length) {
      const token = tokens[pos];
      if (token.type === "op" && token.op === "or") {
        pos++;
        const right = parseAnd();
        if (!right)
          return left;
        left = { type: "or", left, right };
      } else {
        break;
      }
    }
    return left;
  }
  __name(parseOr, "parseOr");
  function parseAnd() {
    let left = parseNot();
    if (!left)
      return null;
    while (pos < tokens.length) {
      const token = tokens[pos];
      if (token.type === "op" && token.op === "and") {
        pos++;
        const right = parseNot();
        if (!right)
          return left;
        left = { type: "and", left, right };
      } else if (token.type === "expr" || token.type === "not" || token.type === "lparen") {
        const right = parseNot();
        if (!right)
          return left;
        left = { type: "and", left, right };
      } else {
        break;
      }
    }
    return left;
  }
  __name(parseAnd, "parseAnd");
  function parseNot() {
    if (pos < tokens.length && tokens[pos].type === "not") {
      pos++;
      const expr2 = parseNot();
      if (!expr2)
        return null;
      return { type: "not", expr: expr2 };
    }
    return parsePrimary();
  }
  __name(parseNot, "parseNot");
  function parsePrimary() {
    if (pos >= tokens.length)
      return null;
    const token = tokens[pos];
    if (token.type === "lparen") {
      pos++;
      const expr2 = parseOr();
      if (pos < tokens.length && tokens[pos].type === "rparen") {
        pos++;
      }
      return expr2;
    }
    if (token.type === "expr") {
      pos++;
      return token.expr;
    }
    if (token.type === "rparen") {
      return null;
    }
    return null;
  }
  __name(parsePrimary, "parsePrimary");
  const expr = parseOr();
  return { expr };
}
__name(buildExpressionTree, "buildExpressionTree");

// dist/commands/find/find.js
var FIND_BATCH_SIZE = 500;
function createTraceCounters() {
  return {
    readdirCalls: 0,
    readdirTime: 0,
    statCalls: 0,
    statTime: 0,
    evalCalls: 0,
    evalTime: 0,
    nodeCount: 0,
    batchCount: 0,
    batchTime: 0,
    earlyPrunes: 0
  };
}
__name(createTraceCounters, "createTraceCounters");
function emitTraceSummary(trace, counters, totalMs) {
  trace({
    category: "find",
    name: "summary",
    durationMs: totalMs,
    details: {
      readdirCalls: counters.readdirCalls,
      readdirTimeMs: counters.readdirTime,
      statCalls: counters.statCalls,
      statTimeMs: counters.statTime,
      evalCalls: counters.evalCalls,
      evalTimeMs: counters.evalTime,
      nodeCount: counters.nodeCount,
      batchCount: counters.batchCount,
      batchTimeMs: counters.batchTime,
      earlyPrunes: counters.earlyPrunes,
      otherTimeMs: totalMs - counters.readdirTime - counters.statTime - counters.evalTime - counters.batchTime
    }
  });
}
__name(emitTraceSummary, "emitTraceSummary");
var findHelp = {
  name: "find",
  summary: "search for files in a directory hierarchy",
  usage: "find [path...] [expression]",
  options: [
    "-name PATTERN    file name matches shell pattern PATTERN",
    "-iname PATTERN   like -name but case insensitive",
    "-path PATTERN    file path matches shell pattern PATTERN",
    "-ipath PATTERN   like -path but case insensitive",
    "-regex PATTERN   file path matches regular expression PATTERN",
    "-iregex PATTERN  like -regex but case insensitive",
    "-type TYPE       file is of type: f (regular file), d (directory)",
    "-empty           file is empty or directory is empty",
    "-mtime N         file's data was modified N*24 hours ago",
    "-newer FILE      file was modified more recently than FILE",
    "-size N[ckMGb]   file uses N units of space (c=bytes, k=KB, M=MB, G=GB, b=512B blocks)",
    "-perm MODE       file's permission bits are exactly MODE (octal)",
    "-perm -MODE      all permission bits MODE are set",
    "-perm /MODE      any permission bits MODE are set",
    "-maxdepth LEVELS descend at most LEVELS directories",
    "-mindepth LEVELS do not apply tests at levels less than LEVELS",
    "-depth           process directory contents before directory itself",
    "-prune           do not descend into this directory",
    "-not, !          negate the following expression",
    "-a, -and         logical AND (default)",
    "-o, -or          logical OR",
    "-exec CMD {} ;   execute CMD on each file ({} is replaced by filename)",
    "-exec CMD {} +   execute CMD with multiple files at once",
    "-print           print the full file name (default action)",
    "-print0          print the full file name followed by a null character",
    "-printf FORMAT   print FORMAT with directives: %f %h %p %P %s %d %m %M %t",
    "-delete          delete found files/directories",
    "    --help       display this help and exit"
  ]
};
var PREDICATES_WITH_ARGS_SET = /* @__PURE__ */ new Set([
  "-name",
  "-iname",
  "-path",
  "-ipath",
  "-regex",
  "-iregex",
  "-type",
  "-maxdepth",
  "-mindepth",
  "-mtime",
  "-newer",
  "-size",
  "-perm"
]);
var findCommand = {
  name: "find",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(findHelp);
    }
    const searchPaths = [];
    let maxDepth = null;
    let minDepth = null;
    let depthFirst = false;
    let expressionsStarted = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "-maxdepth" && i + 1 < args.length) {
        expressionsStarted = true;
        maxDepth = parseInt(args[++i], 10);
      } else if (arg === "-mindepth" && i + 1 < args.length) {
        expressionsStarted = true;
        minDepth = parseInt(args[++i], 10);
      } else if (arg === "-depth") {
        expressionsStarted = true;
        depthFirst = true;
      } else if (arg === "-exec") {
        expressionsStarted = true;
        i++;
        while (i < args.length && args[i] !== ";" && args[i] !== "+") {
          i++;
        }
      } else if (!arg.startsWith("-") && arg !== ";" && arg !== "+" && arg !== "(" && arg !== ")" && arg !== "\\(" && arg !== "\\)" && arg !== "!") {
        if (!expressionsStarted) {
          searchPaths.push(arg);
        }
      } else if (PREDICATES_WITH_ARGS_SET.has(arg)) {
        expressionsStarted = true;
        i++;
      } else if (arg.startsWith("-") || arg === "(" || arg === "\\(" || arg === "!") {
        expressionsStarted = true;
      }
    }
    if (searchPaths.length === 0) {
      searchPaths.push(".");
    }
    const { expr, error, actions } = parseExpressions(args, 0);
    if (error) {
      return { stdout: "", stderr: error, exitCode: 1 };
    }
    const hasExplicitPrint = actions.some((a) => a.type === "print");
    const useDefaultPrint = actions.length === 0;
    const results = [];
    const hasPrintfAction = actions.some((a) => a.type === "printf");
    const printfResults = [];
    let stderr = "";
    let exitCode = 0;
    const newerRefPaths = collectNewerRefs(expr);
    const newerRefTimes = /* @__PURE__ */ new Map();
    for (const refPath of newerRefPaths) {
      const refFullPath = ctx.fs.resolvePath(ctx.cwd, refPath);
      try {
        const refStat = await ctx.fs.stat(refFullPath);
        newerRefTimes.set(refPath, refStat.mtime?.getTime() ?? Date.now());
      } catch {
      }
    }
    const printfNeedsStat = actions.some((a) => {
      if (a.type !== "printf")
        return false;
      const format = a.format.replace(/%%/g, "");
      return /%[-+]?[0-9]*\.?[0-9]*(s|m|M|t|T)/.test(format);
    });
    const needsStatMetadata = expressionNeedsStatMetadata(expr) || printfNeedsStat;
    const needsEmptyCheck = expressionNeedsEmptyCheck(expr);
    const pathPruningHints = extractPathPruningHints(expr);
    const hasPruneExpr = expressionHasPrune(expr);
    const isSimpleExpr = isSimpleExpression(expr);
    const hasReaddirWithFileTypes = typeof ctx.fs.readdirWithFileTypes === "function";
    for (let searchPath of searchPaths) {
      let shouldPrintNode2 = function(node) {
        const atOrBeyondMinDepth = minDepth === null || node.depth >= minDepth;
        let matches = atOrBeyondMinDepth;
        let shouldPrint = false;
        if (matches && expr !== null) {
          const evalStart = Date.now();
          let evalResult;
          if (isSimpleExpr) {
            evalResult = evaluateSimpleExpression(expr, node.name, node.relativePath, node.isFile, node.isDirectory);
          } else {
            const evalCtx = {
              name: node.name,
              relativePath: node.relativePath,
              isFile: node.isFile,
              isDirectory: node.isDirectory,
              isEmpty: node.isEmpty,
              mtime: node.stat?.mtime?.getTime() ?? Date.now(),
              size: node.stat?.size ?? 0,
              mode: node.stat?.mode ?? 420,
              newerRefTimes
            };
            evalResult = evaluateExpressionWithPrune(expr, evalCtx);
          }
          matches = evalResult.matches;
          shouldPrint = hasExplicitPrint ? evalResult.printed : matches;
          traceCounters.evalCalls++;
          traceCounters.evalTime += Date.now() - evalStart;
        } else if (matches) {
          shouldPrint = true;
        }
        if (!shouldPrint) {
          return { print: false, printfData: null };
        }
        const printfData = hasPrintfAction ? {
          path: node.relativePath,
          name: node.name,
          size: node.stat?.size ?? 0,
          mtime: node.stat?.mtime?.getTime() ?? Date.now(),
          mode: node.stat?.mode ?? 420,
          isDirectory: node.isDirectory,
          depth: node.depth,
          startingPoint: searchPath
        } : null;
        return { print: true, printfData };
      };
      var shouldPrintNode = shouldPrintNode2;
      __name(shouldPrintNode2, "shouldPrintNode");
      if (searchPath.length > 1 && searchPath.endsWith("/")) {
        searchPath = searchPath.slice(0, -1);
      }
      const basePath = ctx.fs.resolvePath(ctx.cwd, searchPath);
      try {
        await ctx.fs.stat(basePath);
      } catch {
        stderr += `find: ${searchPath}: No such file or directory
`;
        exitCode = 1;
        continue;
      }
      const traceCounters = createTraceCounters();
      const traceStartTime = Date.now();
      async function processNode(item) {
        const { path: currentPath, depth, typeInfo } = item;
        traceCounters.nodeCount++;
        if (maxDepth !== null && depth > maxDepth) {
          return null;
        }
        let isFile;
        let isDirectory;
        let stat;
        if (typeInfo && !needsStatMetadata) {
          isFile = typeInfo.isFile;
          isDirectory = typeInfo.isDirectory;
        } else {
          try {
            const statStart = Date.now();
            stat = await ctx.fs.stat(currentPath);
            traceCounters.statCalls++;
            traceCounters.statTime += Date.now() - statStart;
          } catch {
            return null;
          }
          if (!stat)
            return null;
          isFile = stat.isFile;
          isDirectory = stat.isDirectory;
        }
        let name;
        if (currentPath === basePath) {
          name = searchPath.split("/").pop() || searchPath;
        } else {
          name = currentPath.split("/").pop() || "";
        }
        const relativePath = currentPath === basePath ? searchPath : searchPath === "." ? `./${currentPath.slice(basePath === "/" ? basePath.length : basePath.length + 1)}` : searchPath + currentPath.slice(basePath.length);
        let children = [];
        let entriesWithTypes = null;
        let entries = null;
        let earlyPruned = false;
        if (isDirectory && hasPruneExpr && !depthFirst) {
          const earlyResult = evaluateForEarlyPrune(expr, {
            name,
            relativePath,
            isFile,
            isDirectory
          });
          earlyPruned = earlyResult.shouldPrune;
          if (earlyPruned) {
            traceCounters.earlyPrunes++;
          }
        }
        const atMaxDepth = maxDepth !== null && depth >= maxDepth;
        const inTerminalDir = pathPruningHints.terminalDirName !== null && name === pathPruningHints.terminalDirName;
        const shouldDescendIntoSubdirs = !atMaxDepth && !inTerminalDir && !earlyPruned;
        const shouldReadDir = (shouldDescendIntoSubdirs || needsEmptyCheck || inTerminalDir) && !earlyPruned;
        if (isDirectory && shouldReadDir) {
          const readdirStart = Date.now();
          if (hasReaddirWithFileTypes && ctx.fs.readdirWithFileTypes) {
            entriesWithTypes = await ctx.fs.readdirWithFileTypes(currentPath);
            entries = entriesWithTypes.map((e) => e.name);
            traceCounters.readdirCalls++;
            traceCounters.readdirTime += Date.now() - readdirStart;
            if (shouldDescendIntoSubdirs) {
              children = entriesWithTypes.map((entry, idx) => ({
                path: currentPath === "/" ? `/${entry.name}` : `${currentPath}/${entry.name}`,
                depth: depth + 1,
                typeInfo: {
                  isFile: entry.isFile,
                  isDirectory: entry.isDirectory
                },
                resultIndex: idx
              }));
            } else if (inTerminalDir) {
              const extFilter = pathPruningHints.requiredExtension;
              children = entriesWithTypes.filter((entry) => entry.isFile && (!extFilter || entry.name.endsWith(extFilter))).map((entry, idx) => ({
                path: currentPath === "/" ? `/${entry.name}` : `${currentPath}/${entry.name}`,
                depth: depth + 1,
                typeInfo: {
                  isFile: entry.isFile,
                  isDirectory: entry.isDirectory
                },
                resultIndex: idx
              }));
            }
          } else {
            entries = await ctx.fs.readdir(currentPath);
            traceCounters.readdirCalls++;
            traceCounters.readdirTime += Date.now() - readdirStart;
            if (shouldDescendIntoSubdirs) {
              children = entries.map((entry, idx) => ({
                path: currentPath === "/" ? `/${entry}` : `${currentPath}/${entry}`,
                depth: depth + 1,
                resultIndex: idx
              }));
            }
          }
        }
        const isEmpty = isFile ? (stat?.size ?? 0) === 0 : entries !== null && entries.length === 0;
        let pruned = earlyPruned;
        if (!depthFirst && expr !== null && !earlyPruned && hasPruneExpr) {
          const evalStart = Date.now();
          const evalCtx = {
            name,
            relativePath,
            isFile,
            isDirectory,
            isEmpty,
            mtime: stat?.mtime?.getTime() ?? Date.now(),
            size: stat?.size ?? 0,
            mode: stat?.mode ?? 420,
            newerRefTimes
          };
          const evalResult = evaluateExpressionWithPrune(expr, evalCtx);
          pruned = evalResult.pruned;
          traceCounters.evalCalls++;
          traceCounters.evalTime += Date.now() - evalStart;
        }
        return {
          relativePath,
          name,
          isFile,
          isDirectory,
          isEmpty,
          stat,
          depth,
          children: pruned ? [] : children,
          pruned
        };
      }
      __name(processNode, "processNode");
      async function findIterative() {
        const finalResult = { paths: [], printfData: [] };
        if (depthFirst) {
          let collectPostOrder2 = function(index) {
            const result = { paths: [], printfData: [] };
            const entry = discovered[index];
            if (!entry)
              return result;
            for (const childIndex of entry.childIndices) {
              const childResult = collectPostOrder2(childIndex);
              result.paths.push(...childResult.paths);
              result.printfData.push(...childResult.printfData);
            }
            const { print, printfData } = shouldPrintNode2(entry.node);
            if (print) {
              result.paths.push(entry.node.relativePath);
              if (printfData) {
                result.printfData.push(printfData);
              }
            }
            return result;
          };
          var collectPostOrder = collectPostOrder2;
          __name(collectPostOrder2, "collectPostOrder");
          const discovered = [];
          const workQueue = [
            {
              item: { path: basePath, depth: 0, resultIndex: 0 },
              parentIndex: -1,
              childOrderInParent: 0
            }
          ];
          const parentChildMap = /* @__PURE__ */ new Map();
          while (workQueue.length > 0) {
            const batchStart = Date.now();
            const batch = workQueue.splice(0, FIND_BATCH_SIZE);
            const nodes = await Promise.all(batch.map((q) => processNode(q.item)));
            traceCounters.batchCount++;
            traceCounters.batchTime += Date.now() - batchStart;
            for (let i = 0; i < batch.length; i++) {
              const node = nodes[i];
              const queueItem = batch[i];
              if (!node)
                continue;
              const thisIndex = discovered.length;
              if (queueItem.parentIndex >= 0) {
                const siblings = parentChildMap.get(queueItem.parentIndex) || [];
                siblings.push(thisIndex);
                parentChildMap.set(queueItem.parentIndex, siblings);
              }
              discovered.push({
                node,
                parentIndex: queueItem.parentIndex,
                childIndices: []
                // will be filled from parentChildMap
              });
              for (let j = 0; j < node.children.length; j++) {
                workQueue.push({
                  item: node.children[j],
                  parentIndex: thisIndex,
                  childOrderInParent: j
                });
              }
            }
          }
          for (const [parentIdx, childIndices] of parentChildMap) {
            if (parentIdx >= 0 && parentIdx < discovered.length) {
              discovered[parentIdx].childIndices = childIndices;
            }
          }
          if (discovered.length > 0) {
            const rootResult = collectPostOrder2(0);
            finalResult.paths.push(...rootResult.paths);
            finalResult.printfData.push(...rootResult.printfData);
          }
        } else {
          let collectPreOrder2 = function(orderIndex) {
            const nodeResult = nodeResults.get(orderIndex);
            if (nodeResult) {
              finalResult.paths.push(nodeResult.path);
              if (nodeResult.printfData) {
                finalResult.printfData.push(nodeResult.printfData);
              }
            }
            const children = childOrders.get(orderIndex);
            if (children) {
              for (const childIndex of children) {
                collectPreOrder2(childIndex);
              }
            }
          };
          var collectPreOrder = collectPreOrder2;
          __name(collectPreOrder2, "collectPreOrder");
          const nodeResults = /* @__PURE__ */ new Map();
          let orderCounter = 0;
          const workQueue = [
            {
              item: { path: basePath, depth: 0, resultIndex: 0 },
              orderIndex: orderCounter++
            }
          ];
          const childOrders = /* @__PURE__ */ new Map();
          while (workQueue.length > 0) {
            const batchStart = Date.now();
            const batch = workQueue.splice(0, FIND_BATCH_SIZE);
            const processed = await Promise.all(batch.map(async ({ item, orderIndex }) => {
              const node = await processNode(item);
              return node ? { node, orderIndex } : null;
            }));
            traceCounters.batchCount++;
            traceCounters.batchTime += Date.now() - batchStart;
            for (const result of processed) {
              if (!result)
                continue;
              const { node, orderIndex } = result;
              const { print, printfData } = shouldPrintNode2(node);
              if (print) {
                nodeResults.set(orderIndex, {
                  path: node.relativePath,
                  printfData
                });
              }
              if (node.children.length > 0) {
                const childIndices = [];
                for (const child of node.children) {
                  const childOrder = orderCounter++;
                  childIndices.push(childOrder);
                  workQueue.push({ item: child, orderIndex: childOrder });
                }
                childOrders.set(orderIndex, childIndices);
              }
            }
          }
          collectPreOrder2(0);
        }
        return finalResult;
      }
      __name(findIterative, "findIterative");
      const searchResult = await findIterative();
      results.push(...searchResult.paths);
      printfResults.push(...searchResult.printfData);
      if (ctx.trace) {
        const totalMs = Date.now() - traceStartTime;
        emitTraceSummary(ctx.trace, traceCounters, totalMs);
        ctx.trace({
          category: "find",
          name: "searchPath",
          durationMs: totalMs,
          details: {
            path: searchPath,
            resultsFound: searchResult.paths.length
          }
        });
      }
    }
    let stdout = "";
    if (actions.length > 0) {
      for (const action of actions) {
        switch (action.type) {
          case "print":
            stdout += results.length > 0 ? `${results.join("\n")}
` : "";
            break;
          case "print0":
            stdout += results.length > 0 ? `${results.join("\0")}\0` : "";
            break;
          case "delete": {
            const sortedForDelete = [...results].sort((a, b) => b.length - a.length);
            for (const file of sortedForDelete) {
              const fullPath = ctx.fs.resolvePath(ctx.cwd, file);
              try {
                await ctx.fs.rm(fullPath, { recursive: false });
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                stderr += `find: cannot delete '${file}': ${msg}
`;
                exitCode = 1;
              }
            }
            break;
          }
          case "printf":
            for (const r of printfResults) {
              stdout += formatFindPrintf(action.format, r);
            }
            break;
          case "exec":
            if (!ctx.exec) {
              return {
                stdout: "",
                stderr: "find: -exec not supported in this context\n",
                exitCode: 1
              };
            }
            if (action.batchMode) {
              const cmdWithFiles = [];
              for (const part of action.command) {
                if (part === "{}") {
                  cmdWithFiles.push(...results);
                } else {
                  cmdWithFiles.push(part);
                }
              }
              const cmd = cmdWithFiles.map((p) => `"${p}"`).join(" ");
              const result = await ctx.exec(cmd, { cwd: ctx.cwd });
              stdout += result.stdout;
              stderr += result.stderr;
              if (result.exitCode !== 0) {
                exitCode = result.exitCode;
              }
            } else {
              for (const file of results) {
                const cmdWithFile = action.command.map((part) => part === "{}" ? file : part);
                const cmd = cmdWithFile.map((p) => `"${p}"`).join(" ");
                const result = await ctx.exec(cmd, { cwd: ctx.cwd });
                stdout += result.stdout;
                stderr += result.stderr;
                if (result.exitCode !== 0) {
                  exitCode = result.exitCode;
                }
              }
            }
            break;
        }
      }
    } else if (useDefaultPrint) {
      stdout = results.length > 0 ? `${results.join("\n")}
` : "";
    }
    return { stdout, stderr, exitCode };
  }
};
function formatFindPrintf(format, result) {
  const processed = processEscapes(format);
  let output = "";
  let i = 0;
  while (i < processed.length) {
    if (processed[i] === "%" && i + 1 < processed.length) {
      i++;
      if (processed[i] === "%") {
        output += "%";
        i++;
        continue;
      }
      const [width, precision, consumed] = parseWidthPrecision(processed, i);
      i += consumed;
      if (i >= processed.length) {
        output += "%";
        break;
      }
      const directive = processed[i];
      let value;
      switch (directive) {
        case "f":
          value = result.name;
          i++;
          break;
        case "h": {
          const lastSlash = result.path.lastIndexOf("/");
          value = lastSlash > 0 ? result.path.slice(0, lastSlash) : ".";
          i++;
          break;
        }
        case "p":
          value = result.path;
          i++;
          break;
        case "P": {
          const sp = result.startingPoint;
          if (result.path === sp) {
            value = "";
          } else if (result.path.startsWith(`${sp}/`)) {
            value = result.path.slice(sp.length + 1);
          } else if (sp === "." && result.path.startsWith("./")) {
            value = result.path.slice(2);
          } else {
            value = result.path;
          }
          i++;
          break;
        }
        case "s":
          value = String(result.size);
          i++;
          break;
        case "d":
          value = String(result.depth);
          i++;
          break;
        case "m":
          value = (result.mode & 511).toString(8);
          i++;
          break;
        case "M":
          value = formatSymbolicMode(result.mode, result.isDirectory);
          i++;
          break;
        case "t": {
          const date = new Date(result.mtime);
          value = formatCtimeDate(date);
          i++;
          break;
        }
        case "T": {
          if (i + 1 < processed.length) {
            const timeFormat = processed[i + 1];
            const date = new Date(result.mtime);
            value = formatTimeDirective(date, timeFormat);
            i += 2;
          } else {
            value = "%T";
            i++;
          }
          break;
        }
        default:
          output += `%${width !== 0 || precision !== -1 ? `${width}.${precision}` : ""}${directive}`;
          i++;
          continue;
      }
      output += applyWidth(value, width, precision);
    } else {
      output += processed[i];
      i++;
    }
  }
  return output;
}
__name(formatFindPrintf, "formatFindPrintf");
function formatSymbolicMode(mode, isDirectory) {
  const perms = mode & 511;
  let result = isDirectory ? "d" : "-";
  result += perms & 256 ? "r" : "-";
  result += perms & 128 ? "w" : "-";
  result += perms & 64 ? "x" : "-";
  result += perms & 32 ? "r" : "-";
  result += perms & 16 ? "w" : "-";
  result += perms & 8 ? "x" : "-";
  result += perms & 4 ? "r" : "-";
  result += perms & 2 ? "w" : "-";
  result += perms & 1 ? "x" : "-";
  return result;
}
__name(formatSymbolicMode, "formatSymbolicMode");
function formatCtimeDate(date) {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec"
  ];
  const day = days[date.getDay()];
  const month = months[date.getMonth()];
  const dayNum = String(date.getDate()).padStart(2, " ");
  const hours = String(date.getHours()).padStart(2, "0");
  const mins = String(date.getMinutes()).padStart(2, "0");
  const secs = String(date.getSeconds()).padStart(2, "0");
  const year = date.getFullYear();
  return `${day} ${month} ${dayNum} ${hours}:${mins}:${secs} ${year}`;
}
__name(formatCtimeDate, "formatCtimeDate");
function formatTimeDirective(date, format) {
  switch (format) {
    case "@":
      return String(date.getTime() / 1e3);
    case "Y":
      return String(date.getFullYear());
    case "m":
      return String(date.getMonth() + 1).padStart(2, "0");
    case "d":
      return String(date.getDate()).padStart(2, "0");
    case "H":
      return String(date.getHours()).padStart(2, "0");
    case "M":
      return String(date.getMinutes()).padStart(2, "0");
    case "S":
      return String(date.getSeconds()).padStart(2, "0");
    case "T":
      return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
    case "F":
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    default:
      return `%T${format}`;
  }
}
__name(formatTimeDirective, "formatTimeDirective");
export {
  findCommand
};
