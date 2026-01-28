import {
  ExecutionLimitError
} from "./chunk-KRBYMBZY.js";
import {
  hasHelpFlag,
  showHelp,
  unknownOption
} from "./chunk-HAN5425M.js";
import {
  __name
} from "./chunk-Y7IWVHJ4.js";

// dist/commands/sed/sed-regex.js
var POSIX_CLASSES = {
  alnum: "a-zA-Z0-9",
  alpha: "a-zA-Z",
  ascii: "\\x00-\\x7F",
  blank: " \\t",
  cntrl: "\\x00-\\x1F\\x7F",
  digit: "0-9",
  graph: "!-~",
  lower: "a-z",
  print: " -~",
  punct: "!-/:-@\\[-`{-~",
  space: " \\t\\n\\r\\f\\v",
  upper: "A-Z",
  word: "a-zA-Z0-9_",
  xdigit: "0-9A-Fa-f"
};
function breToEre(pattern) {
  let result = "";
  let i = 0;
  let inBracket = false;
  while (i < pattern.length) {
    if (pattern[i] === "[" && !inBracket) {
      if (pattern[i + 1] === "[" && pattern[i + 2] === ":") {
        const closeIdx = pattern.indexOf(":]]", i + 3);
        if (closeIdx !== -1) {
          const className = pattern.slice(i + 3, closeIdx);
          const jsClass = POSIX_CLASSES[className];
          if (jsClass) {
            result += `[${jsClass}]`;
            i = closeIdx + 3;
            continue;
          }
        }
      }
      if (pattern[i + 1] === "^" && pattern[i + 2] === "[" && pattern[i + 3] === ":") {
        const closeIdx = pattern.indexOf(":]]", i + 4);
        if (closeIdx !== -1) {
          const className = pattern.slice(i + 4, closeIdx);
          const jsClass = POSIX_CLASSES[className];
          if (jsClass) {
            result += `[^${jsClass}]`;
            i = closeIdx + 3;
            continue;
          }
        }
      }
      result += "[";
      i++;
      inBracket = true;
      if (i < pattern.length && pattern[i] === "^") {
        result += "^";
        i++;
      }
      if (i < pattern.length && pattern[i] === "]") {
        result += "\\]";
        i++;
      }
      continue;
    }
    if (inBracket) {
      if (pattern[i] === "]") {
        result += "]";
        i++;
        inBracket = false;
        continue;
      }
      if (pattern[i] === "[" && pattern[i + 1] === ":") {
        const closeIdx = pattern.indexOf(":]", i + 2);
        if (closeIdx !== -1) {
          const className = pattern.slice(i + 2, closeIdx);
          const jsClass = POSIX_CLASSES[className];
          if (jsClass) {
            result += jsClass;
            i = closeIdx + 2;
            continue;
          }
        }
      }
      if (pattern[i] === "\\" && i + 1 < pattern.length) {
        result += pattern[i] + pattern[i + 1];
        i += 2;
        continue;
      }
      result += pattern[i];
      i++;
      continue;
    }
    if (pattern[i] === "\\") {
      if (i + 1 < pattern.length) {
        const next = pattern[i + 1];
        if (next === "+" || next === "?" || next === "|") {
          result += next;
          i += 2;
          continue;
        }
        if (next === "(" || next === ")") {
          result += next;
          i += 2;
          continue;
        }
        if (next === "{" || next === "}") {
          result += next;
          i += 2;
          continue;
        }
        if (next === "t") {
          result += "	";
          i += 2;
          continue;
        }
        if (next === "n") {
          result += "\n";
          i += 2;
          continue;
        }
        if (next === "r") {
          result += "\r";
          i += 2;
          continue;
        }
        result += pattern[i] + next;
        i += 2;
        continue;
      }
    }
    if (pattern[i] === "+" || pattern[i] === "?" || pattern[i] === "|" || pattern[i] === "(" || pattern[i] === ")") {
      result += `\\${pattern[i]}`;
      i++;
      continue;
    }
    if (pattern[i] === "^") {
      const isAnchor = result === "" || result.endsWith("(");
      if (!isAnchor) {
        result += "\\^";
        i++;
        continue;
      }
    }
    if (pattern[i] === "$") {
      const isEnd = i === pattern.length - 1;
      const beforeGroupClose = i + 2 < pattern.length && pattern[i + 1] === "\\" && pattern[i + 2] === ")";
      if (!isEnd && !beforeGroupClose) {
        result += "\\$";
        i++;
        continue;
      }
    }
    result += pattern[i];
    i++;
  }
  return result;
}
__name(breToEre, "breToEre");
function normalizeForJs(pattern) {
  let result = "";
  let inBracket = false;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "[" && !inBracket) {
      inBracket = true;
      result += "[";
      i++;
      if (i < pattern.length && pattern[i] === "^") {
        result += "^";
        i++;
      }
      if (i < pattern.length && pattern[i] === "]") {
        result += "]";
        i++;
      }
      i--;
    } else if (pattern[i] === "]" && inBracket) {
      inBracket = false;
      result += "]";
    } else if (!inBracket && pattern[i] === "{" && pattern[i + 1] === ",") {
      result += "{0,";
      i++;
    } else {
      result += pattern[i];
    }
  }
  return result;
}
__name(normalizeForJs, "normalizeForJs");
function escapeForList(input) {
  let result = "";
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const code = ch.charCodeAt(0);
    if (ch === "\\") {
      result += "\\\\";
    } else if (ch === "	") {
      result += "\\t";
    } else if (ch === "\n") {
      result += "$\n";
    } else if (ch === "\r") {
      result += "\\r";
    } else if (ch === "\x07") {
      result += "\\a";
    } else if (ch === "\b") {
      result += "\\b";
    } else if (ch === "\f") {
      result += "\\f";
    } else if (ch === "\v") {
      result += "\\v";
    } else if (code < 32 || code >= 127) {
      result += `\\${code.toString(8).padStart(3, "0")}`;
    } else {
      result += ch;
    }
  }
  return `${result}$`;
}
__name(escapeForList, "escapeForList");

// dist/commands/sed/executor.js
var DEFAULT_MAX_ITERATIONS = 1e4;
function createInitialState(totalLines, filename, rangeStates) {
  return {
    patternSpace: "",
    holdSpace: "",
    lineNumber: 0,
    totalLines,
    deleted: false,
    printed: false,
    quit: false,
    quitSilent: false,
    exitCode: void 0,
    errorMessage: void 0,
    appendBuffer: [],
    substitutionMade: false,
    lineNumberOutput: [],
    nCommandOutput: [],
    restartCycle: false,
    inDRestartedCycle: false,
    currentFilename: filename,
    pendingFileReads: [],
    pendingFileWrites: [],
    pendingExecute: void 0,
    rangeStates: rangeStates || /* @__PURE__ */ new Map(),
    linesConsumedInCycle: 0
  };
}
__name(createInitialState, "createInitialState");
function isStepAddress(address) {
  return typeof address === "object" && "first" in address && "step" in address;
}
__name(isStepAddress, "isStepAddress");
function isRelativeOffset(address) {
  return typeof address === "object" && "offset" in address;
}
__name(isRelativeOffset, "isRelativeOffset");
function matchesAddress(address, lineNum, totalLines, line, state) {
  if (address === "$") {
    return lineNum === totalLines;
  }
  if (typeof address === "number") {
    return lineNum === address;
  }
  if (isStepAddress(address)) {
    const { first, step } = address;
    if (step === 0)
      return lineNum === first;
    return (lineNum - first) % step === 0 && lineNum >= first;
  }
  if (typeof address === "object" && "pattern" in address) {
    try {
      let rawPattern = address.pattern;
      if (rawPattern === "" && state?.lastPattern) {
        rawPattern = state.lastPattern;
      } else if (rawPattern !== "" && state) {
        state.lastPattern = rawPattern;
      }
      const pattern = normalizeForJs(breToEre(rawPattern));
      const regex = new RegExp(pattern);
      return regex.test(line);
    } catch {
      return false;
    }
  }
  return false;
}
__name(matchesAddress, "matchesAddress");
function serializeRange(range) {
  const serializeAddr = /* @__PURE__ */ __name((addr) => {
    if (addr === void 0)
      return "undefined";
    if (addr === "$")
      return "$";
    if (typeof addr === "number")
      return String(addr);
    if ("pattern" in addr)
      return `/${addr.pattern}/`;
    if ("first" in addr)
      return `${addr.first}~${addr.step}`;
    return "unknown";
  }, "serializeAddr");
  return `${serializeAddr(range.start)},${serializeAddr(range.end)}`;
}
__name(serializeRange, "serializeRange");
function isInRangeInternal(range, lineNum, totalLines, line, rangeStates, state) {
  if (!range || !range.start && !range.end) {
    return true;
  }
  const start = range.start;
  const end = range.end;
  if (start !== void 0 && end === void 0) {
    return matchesAddress(start, lineNum, totalLines, line, state);
  }
  if (start !== void 0 && end !== void 0) {
    const hasPatternStart = typeof start === "object" && "pattern" in start;
    const hasPatternEnd = typeof end === "object" && "pattern" in end;
    const hasRelativeEnd = isRelativeOffset(end);
    if (hasRelativeEnd && rangeStates) {
      const rangeKey = serializeRange(range);
      let rangeState = rangeStates.get(rangeKey);
      if (!rangeState) {
        rangeState = { active: false };
        rangeStates.set(rangeKey, rangeState);
      }
      if (!rangeState.active) {
        const startMatches2 = matchesAddress(start, lineNum, totalLines, line, state);
        if (startMatches2) {
          rangeState.active = true;
          rangeState.startLine = lineNum;
          rangeStates.set(rangeKey, rangeState);
          if (end.offset === 0) {
            rangeState.active = false;
            rangeStates.set(rangeKey, rangeState);
          }
          return true;
        }
        return false;
      } else {
        const startLine = rangeState.startLine || lineNum;
        if (lineNum >= startLine + end.offset) {
          rangeState.active = false;
          rangeStates.set(rangeKey, rangeState);
        }
        return true;
      }
    }
    if (!hasPatternStart && !hasPatternEnd && !hasRelativeEnd) {
      const startNum = typeof start === "number" ? start : start === "$" ? totalLines : 1;
      const endNum = typeof end === "number" ? end : end === "$" ? totalLines : totalLines;
      if (startNum <= endNum) {
        return lineNum >= startNum && lineNum <= endNum;
      }
      if (rangeStates) {
        const rangeKey = serializeRange(range);
        let rangeState = rangeStates.get(rangeKey);
        if (!rangeState) {
          rangeState = { active: false };
          rangeStates.set(rangeKey, rangeState);
        }
        if (!rangeState.completed) {
          if (lineNum >= startNum) {
            rangeState.completed = true;
            rangeStates.set(rangeKey, rangeState);
            return true;
          }
        }
        return false;
      }
      return false;
    }
    if (rangeStates) {
      const rangeKey = serializeRange(range);
      let rangeState = rangeStates.get(rangeKey);
      if (!rangeState) {
        rangeState = { active: false };
        rangeStates.set(rangeKey, rangeState);
      }
      if (!rangeState.active) {
        if (rangeState.completed) {
          return false;
        }
        let startMatches2 = false;
        if (typeof start === "number") {
          startMatches2 = lineNum >= start;
        } else {
          startMatches2 = matchesAddress(start, lineNum, totalLines, line, state);
        }
        if (startMatches2) {
          rangeState.active = true;
          rangeState.startLine = lineNum;
          rangeStates.set(rangeKey, rangeState);
          if (matchesAddress(end, lineNum, totalLines, line, state)) {
            rangeState.active = false;
            if (typeof start === "number") {
              rangeState.completed = true;
            }
            rangeStates.set(rangeKey, rangeState);
          }
          return true;
        }
        return false;
      } else {
        if (matchesAddress(end, lineNum, totalLines, line, state)) {
          rangeState.active = false;
          if (typeof start === "number") {
            rangeState.completed = true;
          }
          rangeStates.set(rangeKey, rangeState);
        }
        return true;
      }
    }
    const startMatches = matchesAddress(start, lineNum, totalLines, line, state);
    return startMatches;
  }
  return true;
}
__name(isInRangeInternal, "isInRangeInternal");
function isInRange(range, lineNum, totalLines, line, rangeStates, state) {
  const result = isInRangeInternal(range, lineNum, totalLines, line, rangeStates, state);
  if (range?.negated) {
    return !result;
  }
  return result;
}
__name(isInRange, "isInRange");
function globalReplace(input, regex, _replacement, replaceFn) {
  let result = "";
  let pos = 0;
  let skipZeroLengthAtNextPos = false;
  while (pos <= input.length) {
    regex.lastIndex = pos;
    const match = regex.exec(input);
    if (!match) {
      result += input.slice(pos);
      break;
    }
    if (match.index !== pos) {
      result += input.slice(pos, match.index);
      pos = match.index;
      skipZeroLengthAtNextPos = false;
      continue;
    }
    const matchedText = match[0];
    const groups = match.slice(1);
    if (skipZeroLengthAtNextPos && matchedText.length === 0) {
      if (pos < input.length) {
        result += input[pos];
        pos++;
      } else {
        break;
      }
      skipZeroLengthAtNextPos = false;
      continue;
    }
    result += replaceFn(matchedText, groups);
    skipZeroLengthAtNextPos = false;
    if (matchedText.length === 0) {
      if (pos < input.length) {
        result += input[pos];
        pos++;
      } else {
        break;
      }
    } else {
      pos += matchedText.length;
      skipZeroLengthAtNextPos = true;
    }
  }
  return result;
}
__name(globalReplace, "globalReplace");
function processReplacement(replacement, match, groups) {
  let result = "";
  let i = 0;
  while (i < replacement.length) {
    if (replacement[i] === "\\") {
      if (i + 1 < replacement.length) {
        const next = replacement[i + 1];
        if (next === "&") {
          result += "&";
          i += 2;
          continue;
        }
        if (next === "n") {
          result += "\n";
          i += 2;
          continue;
        }
        if (next === "t") {
          result += "	";
          i += 2;
          continue;
        }
        if (next === "r") {
          result += "\r";
          i += 2;
          continue;
        }
        const digit = parseInt(next, 10);
        if (digit === 0) {
          result += match;
          i += 2;
          continue;
        }
        if (digit >= 1 && digit <= 9) {
          result += groups[digit - 1] || "";
          i += 2;
          continue;
        }
        result += next;
        i += 2;
        continue;
      }
    }
    if (replacement[i] === "&") {
      result += match;
      i++;
      continue;
    }
    result += replacement[i];
    i++;
  }
  return result;
}
__name(processReplacement, "processReplacement");
function executeCommand(cmd, state) {
  const { lineNumber, totalLines, patternSpace } = state;
  if (cmd.type === "label") {
    return;
  }
  if (!isInRange(cmd.address, lineNumber, totalLines, patternSpace, state.rangeStates, state)) {
    return;
  }
  switch (cmd.type) {
    case "substitute": {
      const subCmd = cmd;
      let flags = "";
      if (subCmd.global)
        flags += "g";
      if (subCmd.ignoreCase)
        flags += "i";
      let rawPattern = subCmd.pattern;
      if (rawPattern === "" && state.lastPattern) {
        rawPattern = state.lastPattern;
      } else if (rawPattern !== "") {
        state.lastPattern = rawPattern;
      }
      const pattern = normalizeForJs(subCmd.extendedRegex ? rawPattern : breToEre(rawPattern));
      try {
        const regex = new RegExp(pattern, flags);
        const hasMatch = regex.test(state.patternSpace);
        regex.lastIndex = 0;
        if (hasMatch) {
          state.substitutionMade = true;
          if (subCmd.nthOccurrence && subCmd.nthOccurrence > 0 && !subCmd.global) {
            let count = 0;
            const nth = subCmd.nthOccurrence;
            state.patternSpace = state.patternSpace.replace(new RegExp(pattern, `g${subCmd.ignoreCase ? "i" : ""}`), (match, ...args) => {
              count++;
              if (count === nth) {
                const groups = args.slice(0, -2);
                return processReplacement(subCmd.replacement, match, groups);
              }
              return match;
            });
          } else if (subCmd.global) {
            state.patternSpace = globalReplace(state.patternSpace, new RegExp(pattern, `g${subCmd.ignoreCase ? "i" : ""}`), subCmd.replacement, (match, groups) => processReplacement(subCmd.replacement, match, groups));
          } else {
            state.patternSpace = state.patternSpace.replace(regex, (match, ...args) => {
              const groups = args.slice(0, -2);
              return processReplacement(subCmd.replacement, match, groups);
            });
          }
          if (subCmd.printOnMatch) {
            state.lineNumberOutput.push(state.patternSpace);
          }
        }
      } catch {
      }
      break;
    }
    case "print":
      state.lineNumberOutput.push(state.patternSpace);
      break;
    case "printFirstLine": {
      const newlineIdx = state.patternSpace.indexOf("\n");
      if (newlineIdx !== -1) {
        state.lineNumberOutput.push(state.patternSpace.slice(0, newlineIdx));
      } else {
        state.lineNumberOutput.push(state.patternSpace);
      }
      break;
    }
    case "delete":
      state.deleted = true;
      break;
    case "deleteFirstLine": {
      const newlineIdx = state.patternSpace.indexOf("\n");
      if (newlineIdx !== -1) {
        state.patternSpace = state.patternSpace.slice(newlineIdx + 1);
        state.restartCycle = true;
        state.inDRestartedCycle = true;
      } else {
        state.deleted = true;
      }
      break;
    }
    case "zap":
      state.patternSpace = "";
      break;
    case "append":
      state.appendBuffer.push(cmd.text);
      break;
    case "insert":
      state.appendBuffer.unshift(`__INSERT__${cmd.text}`);
      break;
    case "change":
      state.deleted = true;
      state.changedText = cmd.text;
      break;
    case "hold":
      state.holdSpace = state.patternSpace;
      break;
    case "holdAppend":
      if (state.holdSpace) {
        state.holdSpace += `
${state.patternSpace}`;
      } else {
        state.holdSpace = state.patternSpace;
      }
      break;
    case "get":
      state.patternSpace = state.holdSpace;
      break;
    case "getAppend":
      state.patternSpace += `
${state.holdSpace}`;
      break;
    case "exchange": {
      const temp = state.patternSpace;
      state.patternSpace = state.holdSpace;
      state.holdSpace = temp;
      break;
    }
    case "next":
      state.printed = true;
      break;
    case "quit":
      state.quit = true;
      if (cmd.exitCode !== void 0) {
        state.exitCode = cmd.exitCode;
      }
      break;
    case "quitSilent":
      state.quit = true;
      state.quitSilent = true;
      if (cmd.exitCode !== void 0) {
        state.exitCode = cmd.exitCode;
      }
      break;
    case "list": {
      const escaped = escapeForList(state.patternSpace);
      state.lineNumberOutput.push(escaped);
      break;
    }
    case "printFilename":
      if (state.currentFilename) {
        state.lineNumberOutput.push(state.currentFilename);
      }
      break;
    case "version": {
      const OUR_VERSION = [4, 8, 0];
      if (cmd.minVersion) {
        const parts = cmd.minVersion.split(".");
        const requestedVersion = [];
        let parseError = false;
        for (const part of parts) {
          const num = parseInt(part, 10);
          if (Number.isNaN(num) || num < 0) {
            state.quit = true;
            state.exitCode = 1;
            state.errorMessage = `sed: invalid version string: ${cmd.minVersion}`;
            parseError = true;
            break;
          }
          requestedVersion.push(num);
        }
        if (!parseError) {
          while (requestedVersion.length < 3) {
            requestedVersion.push(0);
          }
          for (let i = 0; i < 3; i++) {
            if (requestedVersion[i] > OUR_VERSION[i]) {
              state.quit = true;
              state.exitCode = 1;
              state.errorMessage = `sed: this is not GNU sed version ${cmd.minVersion}`;
              break;
            }
            if (requestedVersion[i] < OUR_VERSION[i]) {
              break;
            }
          }
        }
      }
      break;
    }
    case "readFile":
      state.pendingFileReads.push({ filename: cmd.filename, wholeFile: true });
      break;
    case "readFileLine":
      state.pendingFileReads.push({ filename: cmd.filename, wholeFile: false });
      break;
    case "writeFile":
      state.pendingFileWrites.push({
        filename: cmd.filename,
        content: `${state.patternSpace}
`
      });
      break;
    case "writeFirstLine": {
      const newlineIdx = state.patternSpace.indexOf("\n");
      const firstLine = newlineIdx !== -1 ? state.patternSpace.slice(0, newlineIdx) : state.patternSpace;
      state.pendingFileWrites.push({
        filename: cmd.filename,
        content: `${firstLine}
`
      });
      break;
    }
    case "execute":
      if (cmd.command) {
        state.pendingExecute = { command: cmd.command, replacePattern: false };
      } else {
        state.pendingExecute = {
          command: state.patternSpace,
          replacePattern: true
        };
      }
      break;
    case "transliterate":
      state.patternSpace = executeTransliterate(state.patternSpace, cmd);
      break;
    case "lineNumber":
      state.lineNumberOutput.push(String(state.lineNumber));
      break;
    case "branch":
      break;
    case "branchOnSubst":
      break;
    case "branchOnNoSubst":
      break;
    case "group":
      break;
  }
}
__name(executeCommand, "executeCommand");
function executeTransliterate(input, cmd) {
  let result = "";
  for (const char of input) {
    const idx = cmd.source.indexOf(char);
    if (idx !== -1) {
      result += cmd.dest[idx];
    } else {
      result += char;
    }
  }
  return result;
}
__name(executeTransliterate, "executeTransliterate");
function executeCommands(commands, state, ctx, limits) {
  const labelIndex = /* @__PURE__ */ new Map();
  for (let i2 = 0; i2 < commands.length; i2++) {
    const cmd = commands[i2];
    if (cmd.type === "label") {
      labelIndex.set(cmd.name, i2);
    }
  }
  const maxIterations = limits?.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  let totalIterations = 0;
  let i = 0;
  while (i < commands.length) {
    totalIterations++;
    if (totalIterations > maxIterations) {
      throw new ExecutionLimitError(`sed: command execution exceeded maximum iterations (${maxIterations})`, "iterations");
    }
    if (state.deleted || state.quit || state.quitSilent || state.restartCycle)
      break;
    const cmd = commands[i];
    if (cmd.type === "next") {
      if (isInRange(cmd.address, state.lineNumber, state.totalLines, state.patternSpace, state.rangeStates, state)) {
        state.nCommandOutput.push(state.patternSpace);
        if (ctx && ctx.currentLineIndex + state.linesConsumedInCycle + 1 < ctx.lines.length) {
          state.linesConsumedInCycle++;
          const nextLine = ctx.lines[ctx.currentLineIndex + state.linesConsumedInCycle];
          state.patternSpace = nextLine;
          state.lineNumber = ctx.currentLineIndex + state.linesConsumedInCycle + 1;
          state.substitutionMade = false;
        } else {
          state.quit = true;
          state.deleted = true;
          break;
        }
      }
      i++;
      continue;
    }
    if (cmd.type === "nextAppend") {
      if (isInRange(cmd.address, state.lineNumber, state.totalLines, state.patternSpace, state.rangeStates, state)) {
        if (ctx && ctx.currentLineIndex + state.linesConsumedInCycle + 1 < ctx.lines.length) {
          state.linesConsumedInCycle++;
          const nextLine = ctx.lines[ctx.currentLineIndex + state.linesConsumedInCycle];
          state.patternSpace += `
${nextLine}`;
          state.lineNumber = ctx.currentLineIndex + state.linesConsumedInCycle + 1;
        } else {
          state.quit = true;
          break;
        }
      }
      i++;
      continue;
    }
    if (cmd.type === "branch") {
      const branchCmd = cmd;
      if (isInRange(branchCmd.address, state.lineNumber, state.totalLines, state.patternSpace, state.rangeStates, state)) {
        if (branchCmd.label) {
          const target = labelIndex.get(branchCmd.label);
          if (target !== void 0) {
            i = target;
            continue;
          }
          state.branchRequest = branchCmd.label;
          break;
        }
        break;
      }
      i++;
      continue;
    }
    if (cmd.type === "branchOnSubst") {
      const branchCmd = cmd;
      if (isInRange(branchCmd.address, state.lineNumber, state.totalLines, state.patternSpace, state.rangeStates, state)) {
        if (state.substitutionMade) {
          state.substitutionMade = false;
          if (branchCmd.label) {
            const target = labelIndex.get(branchCmd.label);
            if (target !== void 0) {
              i = target;
              continue;
            }
            state.branchRequest = branchCmd.label;
            break;
          }
          break;
        }
      }
      i++;
      continue;
    }
    if (cmd.type === "branchOnNoSubst") {
      const branchCmd = cmd;
      if (isInRange(branchCmd.address, state.lineNumber, state.totalLines, state.patternSpace, state.rangeStates, state)) {
        if (!state.substitutionMade) {
          if (branchCmd.label) {
            const target = labelIndex.get(branchCmd.label);
            if (target !== void 0) {
              i = target;
              continue;
            }
            state.branchRequest = branchCmd.label;
            break;
          }
          break;
        }
      }
      i++;
      continue;
    }
    if (cmd.type === "group") {
      const groupCmd = cmd;
      if (isInRange(groupCmd.address, state.lineNumber, state.totalLines, state.patternSpace, state.rangeStates, state)) {
        executeCommands(groupCmd.commands, state, ctx, limits);
        if (state.branchRequest) {
          const target = labelIndex.get(state.branchRequest);
          if (target !== void 0) {
            state.branchRequest = void 0;
            i = target;
            continue;
          }
          break;
        }
      }
      i++;
      continue;
    }
    executeCommand(cmd, state);
    i++;
  }
  return state.linesConsumedInCycle;
}
__name(executeCommands, "executeCommands");

// dist/commands/sed/lexer.js
var SedTokenType;
(function(SedTokenType2) {
  SedTokenType2["NUMBER"] = "NUMBER";
  SedTokenType2["DOLLAR"] = "DOLLAR";
  SedTokenType2["PATTERN"] = "PATTERN";
  SedTokenType2["STEP"] = "STEP";
  SedTokenType2["RELATIVE_OFFSET"] = "RELATIVE_OFFSET";
  SedTokenType2["LBRACE"] = "LBRACE";
  SedTokenType2["RBRACE"] = "RBRACE";
  SedTokenType2["SEMICOLON"] = "SEMICOLON";
  SedTokenType2["NEWLINE"] = "NEWLINE";
  SedTokenType2["COMMA"] = "COMMA";
  SedTokenType2["NEGATION"] = "NEGATION";
  SedTokenType2["COMMAND"] = "COMMAND";
  SedTokenType2["SUBSTITUTE"] = "SUBSTITUTE";
  SedTokenType2["TRANSLITERATE"] = "TRANSLITERATE";
  SedTokenType2["LABEL_DEF"] = "LABEL_DEF";
  SedTokenType2["BRANCH"] = "BRANCH";
  SedTokenType2["BRANCH_ON_SUBST"] = "BRANCH_ON_SUBST";
  SedTokenType2["BRANCH_ON_NO_SUBST"] = "BRANCH_ON_NO_SUBST";
  SedTokenType2["TEXT_CMD"] = "TEXT_CMD";
  SedTokenType2["FILE_READ"] = "FILE_READ";
  SedTokenType2["FILE_READ_LINE"] = "FILE_READ_LINE";
  SedTokenType2["FILE_WRITE"] = "FILE_WRITE";
  SedTokenType2["FILE_WRITE_LINE"] = "FILE_WRITE_LINE";
  SedTokenType2["EXECUTE"] = "EXECUTE";
  SedTokenType2["VERSION"] = "VERSION";
  SedTokenType2["EOF"] = "EOF";
  SedTokenType2["ERROR"] = "ERROR";
})(SedTokenType || (SedTokenType = {}));
var SedLexer = class {
  static {
    __name(this, "SedLexer");
  }
  input;
  pos = 0;
  line = 1;
  column = 1;
  constructor(input) {
    this.input = input;
  }
  tokenize() {
    const tokens = [];
    while (this.pos < this.input.length) {
      const token = this.nextToken();
      if (token) {
        tokens.push(token);
      }
    }
    tokens.push(this.makeToken(SedTokenType.EOF, ""));
    return tokens;
  }
  makeToken(type, value, extra) {
    return { type, value, line: this.line, column: this.column, ...extra };
  }
  peek(offset = 0) {
    return this.input[this.pos + offset] || "";
  }
  advance() {
    const ch = this.input[this.pos++] || "";
    if (ch === "\n") {
      this.line++;
      this.column = 1;
    } else {
      this.column++;
    }
    return ch;
  }
  /**
   * Read an escaped string until the delimiter is reached.
   * Handles escape sequences: \n -> newline, \t -> tab, \X -> X
   * Returns null if newline is encountered before delimiter.
   */
  readEscapedString(delimiter) {
    let result = "";
    while (this.pos < this.input.length && this.peek() !== delimiter) {
      if (this.peek() === "\\") {
        this.advance();
        const escaped = this.advance();
        if (escaped === "n")
          result += "\n";
        else if (escaped === "t")
          result += "	";
        else
          result += escaped;
      } else if (this.peek() === "\n") {
        return null;
      } else {
        result += this.advance();
      }
    }
    return result;
  }
  skipWhitespace() {
    while (this.pos < this.input.length) {
      const ch = this.peek();
      if (ch === " " || ch === "	" || ch === "\r") {
        this.advance();
      } else if (ch === "#") {
        while (this.pos < this.input.length && this.peek() !== "\n") {
          this.advance();
        }
      } else {
        break;
      }
    }
  }
  nextToken() {
    this.skipWhitespace();
    if (this.pos >= this.input.length) {
      return null;
    }
    const startLine = this.line;
    const startColumn = this.column;
    const ch = this.peek();
    if (ch === "\n") {
      this.advance();
      return {
        type: SedTokenType.NEWLINE,
        value: "\n",
        line: startLine,
        column: startColumn
      };
    }
    if (ch === ";") {
      this.advance();
      return {
        type: SedTokenType.SEMICOLON,
        value: ";",
        line: startLine,
        column: startColumn
      };
    }
    if (ch === "{") {
      this.advance();
      return {
        type: SedTokenType.LBRACE,
        value: "{",
        line: startLine,
        column: startColumn
      };
    }
    if (ch === "}") {
      this.advance();
      return {
        type: SedTokenType.RBRACE,
        value: "}",
        line: startLine,
        column: startColumn
      };
    }
    if (ch === ",") {
      this.advance();
      return {
        type: SedTokenType.COMMA,
        value: ",",
        line: startLine,
        column: startColumn
      };
    }
    if (ch === "!") {
      this.advance();
      return {
        type: SedTokenType.NEGATION,
        value: "!",
        line: startLine,
        column: startColumn
      };
    }
    if (ch === "$") {
      this.advance();
      return {
        type: SedTokenType.DOLLAR,
        value: "$",
        line: startLine,
        column: startColumn
      };
    }
    if (this.isDigit(ch)) {
      return this.readNumber();
    }
    if (ch === "+" && this.isDigit(this.input[this.pos + 1] || "")) {
      return this.readRelativeOffset();
    }
    if (ch === "/") {
      return this.readPattern();
    }
    if (ch === ":") {
      return this.readLabelDef();
    }
    return this.readCommand();
  }
  readNumber() {
    const startLine = this.line;
    const startColumn = this.column;
    let numStr = "";
    while (this.isDigit(this.peek())) {
      numStr += this.advance();
    }
    if (this.peek() === "~") {
      this.advance();
      let stepStr = "";
      while (this.isDigit(this.peek())) {
        stepStr += this.advance();
      }
      const first = parseInt(numStr, 10);
      const step = parseInt(stepStr, 10) || 0;
      return {
        type: SedTokenType.STEP,
        value: `${first}~${step}`,
        first,
        step,
        line: startLine,
        column: startColumn
      };
    }
    return {
      type: SedTokenType.NUMBER,
      value: parseInt(numStr, 10),
      line: startLine,
      column: startColumn
    };
  }
  readRelativeOffset() {
    const startLine = this.line;
    const startColumn = this.column;
    this.advance();
    let numStr = "";
    while (this.isDigit(this.peek())) {
      numStr += this.advance();
    }
    const offset = parseInt(numStr, 10) || 0;
    return {
      type: SedTokenType.RELATIVE_OFFSET,
      value: `+${offset}`,
      offset,
      line: startLine,
      column: startColumn
    };
  }
  readPattern() {
    const startLine = this.line;
    const startColumn = this.column;
    this.advance();
    let pattern = "";
    let inBracket = false;
    while (this.pos < this.input.length) {
      const ch = this.peek();
      if (ch === "/" && !inBracket) {
        break;
      }
      if (ch === "\\") {
        pattern += this.advance();
        if (this.pos < this.input.length && this.peek() !== "\n") {
          pattern += this.advance();
        }
      } else if (ch === "\n") {
        break;
      } else if (ch === "[" && !inBracket) {
        inBracket = true;
        pattern += this.advance();
        if (this.peek() === "^") {
          pattern += this.advance();
        }
        if (this.peek() === "]") {
          pattern += this.advance();
        }
      } else if (ch === "]" && inBracket) {
        inBracket = false;
        pattern += this.advance();
      } else {
        pattern += this.advance();
      }
    }
    if (this.peek() === "/") {
      this.advance();
    }
    return {
      type: SedTokenType.PATTERN,
      value: pattern,
      pattern,
      line: startLine,
      column: startColumn
    };
  }
  readLabelDef() {
    const startLine = this.line;
    const startColumn = this.column;
    this.advance();
    while (this.peek() === " " || this.peek() === "	") {
      this.advance();
    }
    let label = "";
    while (this.pos < this.input.length) {
      const ch = this.peek();
      if (ch === " " || ch === "	" || ch === "\n" || ch === ";" || ch === "}" || ch === "{") {
        break;
      }
      label += this.advance();
    }
    return {
      type: SedTokenType.LABEL_DEF,
      value: label,
      label,
      line: startLine,
      column: startColumn
    };
  }
  readCommand() {
    const startLine = this.line;
    const startColumn = this.column;
    const ch = this.advance();
    switch (ch) {
      case "s":
        return this.readSubstitute(startLine, startColumn);
      case "y":
        return this.readTransliterate(startLine, startColumn);
      case "a":
      case "i":
      case "c":
        return this.readTextCommand(ch, startLine, startColumn);
      case "b":
        return this.readBranch(SedTokenType.BRANCH, "b", startLine, startColumn);
      case "t":
        return this.readBranch(SedTokenType.BRANCH_ON_SUBST, "t", startLine, startColumn);
      case "T":
        return this.readBranch(SedTokenType.BRANCH_ON_NO_SUBST, "T", startLine, startColumn);
      case "r":
        return this.readFileCommand(SedTokenType.FILE_READ, "r", startLine, startColumn);
      case "R":
        return this.readFileCommand(SedTokenType.FILE_READ_LINE, "R", startLine, startColumn);
      case "w":
        return this.readFileCommand(SedTokenType.FILE_WRITE, "w", startLine, startColumn);
      case "W":
        return this.readFileCommand(SedTokenType.FILE_WRITE_LINE, "W", startLine, startColumn);
      case "e":
        return this.readExecute(startLine, startColumn);
      case "p":
      case "P":
      case "d":
      case "D":
      case "h":
      case "H":
      case "g":
      case "G":
      case "x":
      case "n":
      case "N":
      case "q":
      case "Q":
      case "z":
      case "=":
      case "l":
      case "F":
        return {
          type: SedTokenType.COMMAND,
          value: ch,
          line: startLine,
          column: startColumn
        };
      case "v":
        return this.readVersion(startLine, startColumn);
      default:
        return {
          type: SedTokenType.ERROR,
          value: ch,
          line: startLine,
          column: startColumn
        };
    }
  }
  readSubstitute(startLine, startColumn) {
    const delimiter = this.advance();
    if (!delimiter || delimiter === "\n") {
      return {
        type: SedTokenType.ERROR,
        value: "s",
        line: startLine,
        column: startColumn
      };
    }
    let pattern = "";
    let inBracket = false;
    while (this.pos < this.input.length) {
      const ch = this.peek();
      if (ch === delimiter && !inBracket) {
        break;
      }
      if (ch === "\\") {
        this.advance();
        if (this.pos < this.input.length && this.peek() !== "\n") {
          const escaped = this.peek();
          if (escaped === delimiter && !inBracket) {
            pattern += this.advance();
          } else {
            pattern += "\\";
            pattern += this.advance();
          }
        } else {
          pattern += "\\";
        }
      } else if (ch === "\n") {
        break;
      } else if (ch === "[" && !inBracket) {
        inBracket = true;
        pattern += this.advance();
        if (this.peek() === "^") {
          pattern += this.advance();
        }
        if (this.peek() === "]") {
          pattern += this.advance();
        }
      } else if (ch === "]" && inBracket) {
        inBracket = false;
        pattern += this.advance();
      } else {
        pattern += this.advance();
      }
    }
    if (this.peek() !== delimiter) {
      return {
        type: SedTokenType.ERROR,
        value: "unterminated substitution pattern",
        line: startLine,
        column: startColumn
      };
    }
    this.advance();
    let replacement = "";
    while (this.pos < this.input.length && this.peek() !== delimiter) {
      if (this.peek() === "\\") {
        this.advance();
        if (this.pos < this.input.length) {
          const next = this.peek();
          if (next === "\\") {
            this.advance();
            if (this.pos < this.input.length && this.peek() === "\n") {
              replacement += "\n";
              this.advance();
            } else {
              replacement += "\\";
            }
          } else if (next === "\n") {
            replacement += "\n";
            this.advance();
          } else {
            replacement += `\\${this.advance()}`;
          }
        } else {
          replacement += "\\";
        }
      } else if (this.peek() === "\n") {
        break;
      } else {
        replacement += this.advance();
      }
    }
    if (this.peek() === delimiter) {
      this.advance();
    }
    let flags = "";
    while (this.pos < this.input.length) {
      const ch = this.peek();
      if (ch === "g" || ch === "i" || ch === "p" || ch === "I" || this.isDigit(ch)) {
        flags += this.advance();
      } else {
        break;
      }
    }
    return {
      type: SedTokenType.SUBSTITUTE,
      value: `s${delimiter}${pattern}${delimiter}${replacement}${delimiter}${flags}`,
      pattern,
      replacement,
      flags,
      line: startLine,
      column: startColumn
    };
  }
  readTransliterate(startLine, startColumn) {
    const delimiter = this.advance();
    if (!delimiter || delimiter === "\n") {
      return {
        type: SedTokenType.ERROR,
        value: "y",
        line: startLine,
        column: startColumn
      };
    }
    const source = this.readEscapedString(delimiter);
    if (source === null || this.peek() !== delimiter) {
      return {
        type: SedTokenType.ERROR,
        value: "unterminated transliteration source",
        line: startLine,
        column: startColumn
      };
    }
    this.advance();
    const dest = this.readEscapedString(delimiter);
    if (dest === null || this.peek() !== delimiter) {
      return {
        type: SedTokenType.ERROR,
        value: "unterminated transliteration dest",
        line: startLine,
        column: startColumn
      };
    }
    this.advance();
    let nextChar = this.peek();
    while (nextChar === " " || nextChar === "	") {
      this.advance();
      nextChar = this.peek();
    }
    if (nextChar !== "" && nextChar !== ";" && nextChar !== "\n" && nextChar !== "}") {
      return {
        type: SedTokenType.ERROR,
        value: "extra text at the end of a transform command",
        line: startLine,
        column: startColumn
      };
    }
    return {
      type: SedTokenType.TRANSLITERATE,
      value: `y${delimiter}${source}${delimiter}${dest}${delimiter}`,
      source,
      dest,
      line: startLine,
      column: startColumn
    };
  }
  readTextCommand(cmd, startLine, startColumn) {
    let hasBackslash = false;
    if (this.peek() === "\\" && this.pos + 1 < this.input.length && (this.input[this.pos + 1] === "\n" || this.input[this.pos + 1] === " " || this.input[this.pos + 1] === "	")) {
      hasBackslash = true;
      this.advance();
    }
    if (this.peek() === " " || this.peek() === "	") {
      this.advance();
    }
    if (this.peek() === "\\" && this.pos + 1 < this.input.length && (this.input[this.pos + 1] === " " || this.input[this.pos + 1] === "	")) {
      this.advance();
    }
    if (hasBackslash && this.peek() === "\n") {
      this.advance();
    }
    let text = "";
    while (this.pos < this.input.length) {
      const ch = this.peek();
      if (ch === "\n") {
        if (text.endsWith("\\")) {
          text = `${text.slice(0, -1)}
`;
          this.advance();
          continue;
        }
        break;
      }
      if (ch === "\\" && this.pos + 1 < this.input.length) {
        const next = this.input[this.pos + 1];
        if (next === "n") {
          text += "\n";
          this.advance();
          this.advance();
          continue;
        }
        if (next === "t") {
          text += "	";
          this.advance();
          this.advance();
          continue;
        }
        if (next === "r") {
          text += "\r";
          this.advance();
          this.advance();
          continue;
        }
      }
      text += this.advance();
    }
    return {
      type: SedTokenType.TEXT_CMD,
      value: cmd,
      text,
      line: startLine,
      column: startColumn
    };
  }
  readBranch(type, cmd, startLine, startColumn) {
    while (this.peek() === " " || this.peek() === "	") {
      this.advance();
    }
    let label = "";
    while (this.pos < this.input.length) {
      const ch = this.peek();
      if (ch === " " || ch === "	" || ch === "\n" || ch === ";" || ch === "}" || ch === "{") {
        break;
      }
      label += this.advance();
    }
    return {
      type,
      value: cmd,
      label: label || void 0,
      line: startLine,
      column: startColumn
    };
  }
  readVersion(startLine, startColumn) {
    while (this.peek() === " " || this.peek() === "	") {
      this.advance();
    }
    let version = "";
    while (this.pos < this.input.length) {
      const ch = this.peek();
      if (ch === " " || ch === "	" || ch === "\n" || ch === ";" || ch === "}" || ch === "{") {
        break;
      }
      version += this.advance();
    }
    return {
      type: SedTokenType.VERSION,
      value: "v",
      label: version || void 0,
      // Reuse label field for version string
      line: startLine,
      column: startColumn
    };
  }
  readFileCommand(type, cmd, startLine, startColumn) {
    while (this.peek() === " " || this.peek() === "	") {
      this.advance();
    }
    let filename = "";
    while (this.pos < this.input.length) {
      const ch = this.peek();
      if (ch === "\n" || ch === ";") {
        break;
      }
      filename += this.advance();
    }
    return {
      type,
      value: cmd,
      filename: filename.trim(),
      line: startLine,
      column: startColumn
    };
  }
  readExecute(startLine, startColumn) {
    while (this.peek() === " " || this.peek() === "	") {
      this.advance();
    }
    let command = "";
    while (this.pos < this.input.length) {
      const ch = this.peek();
      if (ch === "\n" || ch === ";") {
        break;
      }
      command += this.advance();
    }
    return {
      type: SedTokenType.EXECUTE,
      value: "e",
      command: command.trim() || void 0,
      line: startLine,
      column: startColumn
    };
  }
  isDigit(ch) {
    return ch >= "0" && ch <= "9";
  }
};

// dist/commands/sed/parser.js
var SedParser = class {
  static {
    __name(this, "SedParser");
  }
  scripts;
  tokens = [];
  pos = 0;
  extendedRegex = false;
  constructor(scripts, extendedRegex = false) {
    this.scripts = scripts;
    this.extendedRegex = extendedRegex;
  }
  parse() {
    const allCommands = [];
    for (const script of this.scripts) {
      const lexer = new SedLexer(script);
      this.tokens = lexer.tokenize();
      this.pos = 0;
      while (!this.isAtEnd()) {
        if (this.check(SedTokenType.NEWLINE) || this.check(SedTokenType.SEMICOLON)) {
          this.advance();
          continue;
        }
        const result = this.parseCommand();
        if (result.error) {
          return { commands: [], error: result.error };
        }
        if (result.command) {
          allCommands.push(result.command);
        }
      }
    }
    return { commands: allCommands };
  }
  parseCommand() {
    const addressResult = this.parseAddressRange();
    if (addressResult?.error) {
      return { command: null, error: addressResult.error };
    }
    const address = addressResult?.address;
    if (this.check(SedTokenType.NEGATION)) {
      this.advance();
      if (address) {
        address.negated = true;
      }
    }
    while (this.check(SedTokenType.NEWLINE) || this.check(SedTokenType.SEMICOLON)) {
      this.advance();
    }
    if (this.isAtEnd()) {
      if (address && (address.start !== void 0 || address.end !== void 0)) {
        return { command: null, error: "command expected" };
      }
      return { command: null };
    }
    const token = this.peek();
    switch (token.type) {
      case SedTokenType.COMMAND:
        return this.parseSimpleCommand(token, address);
      case SedTokenType.SUBSTITUTE:
        return this.parseSubstituteFromToken(token, address);
      case SedTokenType.TRANSLITERATE:
        return this.parseTransliterateFromToken(token, address);
      case SedTokenType.LABEL_DEF:
        this.advance();
        return {
          command: { type: "label", name: token.label || "" }
        };
      case SedTokenType.BRANCH:
        this.advance();
        return {
          command: { type: "branch", address, label: token.label }
        };
      case SedTokenType.BRANCH_ON_SUBST:
        this.advance();
        return {
          command: { type: "branchOnSubst", address, label: token.label }
        };
      case SedTokenType.BRANCH_ON_NO_SUBST:
        this.advance();
        return {
          command: { type: "branchOnNoSubst", address, label: token.label }
        };
      case SedTokenType.TEXT_CMD:
        this.advance();
        return this.parseTextCommand(token, address);
      case SedTokenType.FILE_READ:
        this.advance();
        return {
          command: {
            type: "readFile",
            address,
            filename: token.filename || ""
          }
        };
      case SedTokenType.FILE_READ_LINE:
        this.advance();
        return {
          command: {
            type: "readFileLine",
            address,
            filename: token.filename || ""
          }
        };
      case SedTokenType.FILE_WRITE:
        this.advance();
        return {
          command: {
            type: "writeFile",
            address,
            filename: token.filename || ""
          }
        };
      case SedTokenType.FILE_WRITE_LINE:
        this.advance();
        return {
          command: {
            type: "writeFirstLine",
            address,
            filename: token.filename || ""
          }
        };
      case SedTokenType.EXECUTE:
        this.advance();
        return {
          command: { type: "execute", address, command: token.command }
        };
      case SedTokenType.VERSION:
        this.advance();
        return {
          command: {
            type: "version",
            address,
            minVersion: token.label
            // label field holds version string
          }
        };
      case SedTokenType.LBRACE:
        return this.parseGroup(address);
      case SedTokenType.RBRACE:
        return { command: null };
      case SedTokenType.ERROR:
        return { command: null, error: `invalid command: ${token.value}` };
      default:
        if (address && (address.start !== void 0 || address.end !== void 0)) {
          return { command: null, error: "command expected" };
        }
        return { command: null };
    }
  }
  parseSimpleCommand(token, address) {
    this.advance();
    const cmd = token.value;
    switch (cmd) {
      case "p":
        return { command: { type: "print", address } };
      case "P":
        return { command: { type: "printFirstLine", address } };
      case "d":
        return { command: { type: "delete", address } };
      case "D":
        return { command: { type: "deleteFirstLine", address } };
      case "h":
        return { command: { type: "hold", address } };
      case "H":
        return { command: { type: "holdAppend", address } };
      case "g":
        return { command: { type: "get", address } };
      case "G":
        return { command: { type: "getAppend", address } };
      case "x":
        return { command: { type: "exchange", address } };
      case "n":
        return { command: { type: "next", address } };
      case "N":
        return { command: { type: "nextAppend", address } };
      case "q":
        return { command: { type: "quit", address } };
      case "Q":
        return { command: { type: "quitSilent", address } };
      case "z":
        return { command: { type: "zap", address } };
      case "=":
        return { command: { type: "lineNumber", address } };
      case "l":
        return { command: { type: "list", address } };
      case "F":
        return { command: { type: "printFilename", address } };
      // Note: 'v' command is now handled as SedTokenType.VERSION
      default:
        return { command: null, error: `unknown command: ${cmd}` };
    }
  }
  parseSubstituteFromToken(token, address) {
    this.advance();
    const flags = token.flags || "";
    let nthOccurrence;
    const numMatch = flags.match(/(\d+)/);
    if (numMatch) {
      nthOccurrence = parseInt(numMatch[1], 10);
    }
    return {
      command: {
        type: "substitute",
        address,
        pattern: token.pattern || "",
        replacement: token.replacement || "",
        global: flags.includes("g"),
        ignoreCase: flags.includes("i") || flags.includes("I"),
        printOnMatch: flags.includes("p"),
        nthOccurrence,
        extendedRegex: this.extendedRegex
      }
    };
  }
  parseTransliterateFromToken(token, address) {
    this.advance();
    const source = token.source || "";
    const dest = token.dest || "";
    if (source.length !== dest.length) {
      return {
        command: null,
        error: "transliteration sets must have same length"
      };
    }
    return {
      command: {
        type: "transliterate",
        address,
        source,
        dest
      }
    };
  }
  parseTextCommand(token, address) {
    const cmd = token.value;
    const text = token.text || "";
    switch (cmd) {
      case "a":
        return { command: { type: "append", address, text } };
      case "i":
        return { command: { type: "insert", address, text } };
      case "c":
        return { command: { type: "change", address, text } };
      default:
        return { command: null, error: `unknown text command: ${cmd}` };
    }
  }
  parseGroup(address) {
    this.advance();
    const commands = [];
    while (!this.isAtEnd() && !this.check(SedTokenType.RBRACE)) {
      if (this.check(SedTokenType.NEWLINE) || this.check(SedTokenType.SEMICOLON)) {
        this.advance();
        continue;
      }
      const result = this.parseCommand();
      if (result.error) {
        return { command: null, error: result.error };
      }
      if (result.command) {
        commands.push(result.command);
      }
    }
    if (!this.check(SedTokenType.RBRACE)) {
      return { command: null, error: "unmatched brace in grouped commands" };
    }
    this.advance();
    return {
      command: { type: "group", address, commands }
    };
  }
  parseAddressRange() {
    const start = this.parseAddress();
    if (start === void 0) {
      return void 0;
    }
    let end;
    if (this.check(SedTokenType.RELATIVE_OFFSET)) {
      const token = this.advance();
      end = { offset: token.offset || 0 };
    } else if (this.check(SedTokenType.COMMA)) {
      this.advance();
      end = this.parseAddress();
      if (end === void 0) {
        return { error: "expected context address" };
      }
    }
    return { address: { start, end } };
  }
  parseAddress() {
    const token = this.peek();
    switch (token.type) {
      case SedTokenType.NUMBER:
        this.advance();
        return token.value;
      case SedTokenType.DOLLAR:
        this.advance();
        return "$";
      case SedTokenType.PATTERN:
        this.advance();
        return { pattern: token.pattern || token.value };
      case SedTokenType.STEP:
        this.advance();
        return {
          first: token.first || 0,
          step: token.step || 0
        };
      case SedTokenType.RELATIVE_OFFSET:
        this.advance();
        return { offset: token.offset || 0 };
      default:
        return void 0;
    }
  }
  peek() {
    return this.tokens[this.pos] || {
      type: SedTokenType.EOF,
      value: "",
      line: 0,
      column: 0
    };
  }
  advance() {
    if (!this.isAtEnd()) {
      this.pos++;
    }
    return this.tokens[this.pos - 1];
  }
  check(type) {
    return this.peek().type === type;
  }
  isAtEnd() {
    return this.peek().type === SedTokenType.EOF;
  }
};
function parseMultipleScripts(scripts, extendedRegex = false) {
  let silentMode = false;
  let extendedRegexFromComment = false;
  const joinedScripts = [];
  for (let i = 0; i < scripts.length; i++) {
    let script = scripts[i];
    if (joinedScripts.length === 0 && i === 0) {
      const match = script.match(/^#([nr]+)\s*(?:\n|$)/i);
      if (match) {
        const flags = match[1].toLowerCase();
        if (flags.includes("n")) {
          silentMode = true;
        }
        if (flags.includes("r")) {
          extendedRegexFromComment = true;
        }
        script = script.slice(match[0].length);
      }
    }
    if (joinedScripts.length > 0 && joinedScripts[joinedScripts.length - 1].endsWith("\\")) {
      const lastScript = joinedScripts[joinedScripts.length - 1];
      joinedScripts[joinedScripts.length - 1] = `${lastScript}
${script}`;
    } else {
      joinedScripts.push(script);
    }
  }
  const combinedScript = joinedScripts.join("\n");
  const parser = new SedParser([combinedScript], extendedRegex || extendedRegexFromComment);
  const result = parser.parse();
  if (!result.error && result.commands.length > 0) {
    const labelError = validateLabels(result.commands);
    if (labelError) {
      return {
        commands: [],
        error: labelError,
        silentMode,
        extendedRegexMode: extendedRegexFromComment
      };
    }
  }
  return {
    ...result,
    silentMode,
    extendedRegexMode: extendedRegexFromComment
  };
}
__name(parseMultipleScripts, "parseMultipleScripts");
function validateLabels(commands) {
  const definedLabels = /* @__PURE__ */ new Set();
  collectLabels(commands, definedLabels);
  const undefinedLabel = findUndefinedLabel(commands, definedLabels);
  if (undefinedLabel) {
    return `undefined label '${undefinedLabel}'`;
  }
  return void 0;
}
__name(validateLabels, "validateLabels");
function collectLabels(commands, labels) {
  for (const cmd of commands) {
    if (cmd.type === "label") {
      labels.add(cmd.name);
    } else if (cmd.type === "group") {
      collectLabels(cmd.commands, labels);
    }
  }
}
__name(collectLabels, "collectLabels");
function findUndefinedLabel(commands, definedLabels) {
  for (const cmd of commands) {
    if ((cmd.type === "branch" || cmd.type === "branchOnSubst" || cmd.type === "branchOnNoSubst") && cmd.label && !definedLabels.has(cmd.label)) {
      return cmd.label;
    }
    if (cmd.type === "group") {
      const result = findUndefinedLabel(cmd.commands, definedLabels);
      if (result)
        return result;
    }
  }
  return void 0;
}
__name(findUndefinedLabel, "findUndefinedLabel");

// dist/commands/sed/sed.js
var sedHelp = {
  name: "sed",
  summary: "stream editor for filtering and transforming text",
  usage: "sed [OPTION]... {script} [input-file]...",
  options: [
    "-n, --quiet, --silent  suppress automatic printing of pattern space",
    "-e script              add the script to commands to be executed",
    "-f script-file         read script from file",
    "-i, --in-place         edit files in place",
    "-E, -r, --regexp-extended  use extended regular expressions",
    "    --help             display this help and exit"
  ],
  description: `Commands:
  s/regexp/replacement/[flags]  substitute
  d                             delete pattern space
  p                             print pattern space
  a\\ text                       append text after line
  i\\ text                       insert text before line
  c\\ text                       change (replace) line with text
  h                             copy pattern space to hold space
  H                             append pattern space to hold space
  g                             copy hold space to pattern space
  G                             append hold space to pattern space
  x                             exchange pattern and hold spaces
  n                             read next line into pattern space
  N                             append next line to pattern space
  y/source/dest/                transliterate characters
  =                             print line number
  l                             list pattern space (escape special chars)
  b [label]                     branch to label
  t [label]                     branch on substitution
  T [label]                     branch if no substitution
  :label                        define label
  q                             quit
  Q                             quit without printing

Addresses:
  N                             line number
  $                             last line
  /regexp/                      lines matching regexp
  N,M                           range from line N to M
  first~step                    every step-th line starting at first`
};
async function processContent(content, commands, silent, options = {}) {
  const { limits, filename, fs, cwd } = options;
  const inputEndsWithNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const totalLines = lines.length;
  let output = "";
  let exitCode;
  let lastOutputWasAutoPrint = false;
  let holdSpace = "";
  let lastPattern;
  const rangeStates = /* @__PURE__ */ new Map();
  const fileLineCache = /* @__PURE__ */ new Map();
  const fileLinePositions = /* @__PURE__ */ new Map();
  const fileWrites = /* @__PURE__ */ new Map();
  const sedLimits = limits ? { maxIterations: limits.maxSedIterations } : void 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const state = {
      ...createInitialState(totalLines, filename, rangeStates),
      patternSpace: lines[lineIndex],
      holdSpace,
      lastPattern,
      lineNumber: lineIndex + 1,
      totalLines,
      substitutionMade: false
      // Reset for each new line (T command behavior)
    };
    const ctx = {
      lines,
      currentLineIndex: lineIndex
    };
    let cycleIterations = 0;
    const maxCycleIterations = 1e4;
    state.linesConsumedInCycle = 0;
    do {
      cycleIterations++;
      if (cycleIterations > maxCycleIterations) {
        break;
      }
      state.restartCycle = false;
      state.pendingFileReads = [];
      state.pendingFileWrites = [];
      executeCommands(commands, state, ctx, sedLimits);
      if (fs && cwd) {
        for (const read of state.pendingFileReads) {
          const filePath = fs.resolvePath(cwd, read.filename);
          try {
            if (read.wholeFile) {
              const fileContent = await fs.readFile(filePath);
              state.appendBuffer.push(fileContent.replace(/\n$/, ""));
            } else {
              if (!fileLineCache.has(filePath)) {
                const fileContent = await fs.readFile(filePath);
                fileLineCache.set(filePath, fileContent.split("\n"));
                fileLinePositions.set(filePath, 0);
              }
              const fileLines = fileLineCache.get(filePath);
              const pos = fileLinePositions.get(filePath);
              if (fileLines && pos !== void 0 && pos < fileLines.length) {
                state.appendBuffer.push(fileLines[pos]);
                fileLinePositions.set(filePath, pos + 1);
              }
            }
          } catch {
          }
        }
        for (const write of state.pendingFileWrites) {
          const filePath = fs.resolvePath(cwd, write.filename);
          const existing = fileWrites.get(filePath) || "";
          fileWrites.set(filePath, existing + write.content);
        }
      }
    } while (state.restartCycle && !state.deleted && !state.quit && !state.quitSilent);
    lineIndex += state.linesConsumedInCycle;
    holdSpace = state.holdSpace;
    lastPattern = state.lastPattern;
    if (!silent) {
      for (const ln of state.nCommandOutput) {
        output += `${ln}
`;
      }
    }
    const hadLineNumberOutput = state.lineNumberOutput.length > 0;
    for (const ln of state.lineNumberOutput) {
      output += `${ln}
`;
    }
    const inserts = [];
    const appends = [];
    for (const item of state.appendBuffer) {
      if (item.startsWith("__INSERT__")) {
        inserts.push(item.slice(10));
      } else {
        appends.push(item);
      }
    }
    for (const text of inserts) {
      output += `${text}
`;
    }
    let hadPatternSpaceOutput = false;
    if (!state.deleted && !state.quitSilent) {
      if (silent) {
        if (state.printed) {
          output += `${state.patternSpace}
`;
          hadPatternSpaceOutput = true;
        }
      } else {
        output += `${state.patternSpace}
`;
        hadPatternSpaceOutput = true;
      }
    } else if (state.changedText !== void 0) {
      output += `${state.changedText}
`;
      hadPatternSpaceOutput = true;
    }
    for (const text of appends) {
      output += `${text}
`;
    }
    const hadOutput = hadLineNumberOutput || hadPatternSpaceOutput;
    lastOutputWasAutoPrint = hadOutput && appends.length === 0;
    if (state.quit || state.quitSilent) {
      if (state.exitCode !== void 0) {
        exitCode = state.exitCode;
      }
      if (state.errorMessage) {
        return {
          output: "",
          exitCode: exitCode || 1,
          errorMessage: state.errorMessage
        };
      }
      break;
    }
  }
  if (fs && cwd) {
    for (const [filePath, fileContent] of fileWrites) {
      try {
        await fs.writeFile(filePath, fileContent);
      } catch {
      }
    }
  }
  if (!inputEndsWithNewline && lastOutputWasAutoPrint && output.endsWith("\n")) {
    output = output.slice(0, -1);
  }
  return { output, exitCode };
}
__name(processContent, "processContent");
var sedCommand = {
  name: "sed",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(sedHelp);
    }
    const scripts = [];
    const scriptFiles = [];
    let silent = false;
    let inPlace = false;
    let extendedRegex = false;
    const files = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "-n" || arg === "--quiet" || arg === "--silent") {
        silent = true;
      } else if (arg === "-i" || arg === "--in-place") {
        inPlace = true;
      } else if (arg.startsWith("-i")) {
        inPlace = true;
      } else if (arg === "-E" || arg === "-r" || arg === "--regexp-extended") {
        extendedRegex = true;
      } else if (arg === "-e") {
        if (i + 1 < args.length) {
          scripts.push(args[++i]);
        }
      } else if (arg === "-f") {
        if (i + 1 < args.length) {
          scriptFiles.push(args[++i]);
        }
      } else if (arg.startsWith("--")) {
        return unknownOption("sed", arg);
      } else if (arg === "-") {
        files.push(arg);
      } else if (arg.startsWith("-") && arg.length > 1) {
        for (const c of arg.slice(1)) {
          if (c !== "n" && c !== "e" && c !== "f" && c !== "i" && c !== "E" && c !== "r") {
            return unknownOption("sed", `-${c}`);
          }
        }
        if (arg.includes("n"))
          silent = true;
        if (arg.includes("i"))
          inPlace = true;
        if (arg.includes("E") || arg.includes("r"))
          extendedRegex = true;
        if (arg.includes("e") && !arg.includes("n") && !arg.includes("i")) {
          if (i + 1 < args.length) {
            scripts.push(args[++i]);
          }
        }
        if (arg.includes("f") && !arg.includes("e")) {
          if (i + 1 < args.length) {
            scriptFiles.push(args[++i]);
          }
        }
      } else if (!arg.startsWith("-") && scripts.length === 0 && scriptFiles.length === 0) {
        scripts.push(arg);
      } else if (!arg.startsWith("-")) {
        files.push(arg);
      }
    }
    for (const scriptFile of scriptFiles) {
      const scriptPath = ctx.fs.resolvePath(ctx.cwd, scriptFile);
      try {
        const scriptContent = await ctx.fs.readFile(scriptPath);
        for (const line of scriptContent.split("\n")) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith("#")) {
            scripts.push(trimmed);
          }
        }
      } catch {
        return {
          stdout: "",
          stderr: `sed: couldn't open file ${scriptFile}: No such file or directory
`,
          exitCode: 1
        };
      }
    }
    if (scripts.length === 0) {
      return {
        stdout: "",
        stderr: "sed: no script specified\n",
        exitCode: 1
      };
    }
    const { commands, error, silentMode } = parseMultipleScripts(scripts, extendedRegex);
    if (error) {
      return {
        stdout: "",
        stderr: `sed: ${error}
`,
        exitCode: 1
      };
    }
    const effectiveSilent = !!(silent || silentMode);
    if (inPlace) {
      if (files.length === 0) {
        return {
          stdout: "",
          stderr: "sed: -i requires at least one file argument\n",
          exitCode: 1
        };
      }
      for (const file of files) {
        if (file === "-") {
          continue;
        }
        const filePath = ctx.fs.resolvePath(ctx.cwd, file);
        try {
          const fileContent = await ctx.fs.readFile(filePath);
          const result = await processContent(fileContent, commands, effectiveSilent, {
            limits: ctx.limits,
            filename: file,
            fs: ctx.fs,
            cwd: ctx.cwd
          });
          if (result.errorMessage) {
            return {
              stdout: "",
              stderr: `${result.errorMessage}
`,
              exitCode: result.exitCode ?? 1
            };
          }
          await ctx.fs.writeFile(filePath, result.output);
        } catch (e) {
          if (e instanceof ExecutionLimitError) {
            return {
              stdout: "",
              stderr: `sed: ${e.message}
`,
              exitCode: ExecutionLimitError.EXIT_CODE
            };
          }
          return {
            stdout: "",
            stderr: `sed: ${file}: No such file or directory
`,
            exitCode: 1
          };
        }
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    let content = "";
    if (files.length === 0) {
      content = ctx.stdin;
      try {
        const result = await processContent(content, commands, effectiveSilent, {
          limits: ctx.limits,
          fs: ctx.fs,
          cwd: ctx.cwd
        });
        return {
          stdout: result.output,
          stderr: result.errorMessage ? `${result.errorMessage}
` : "",
          exitCode: result.exitCode ?? 0
        };
      } catch (e) {
        if (e instanceof ExecutionLimitError) {
          return {
            stdout: "",
            stderr: `sed: ${e.message}
`,
            exitCode: ExecutionLimitError.EXIT_CODE
          };
        }
        throw e;
      }
    }
    let stdinConsumed = false;
    for (const file of files) {
      let fileContent;
      if (file === "-") {
        if (stdinConsumed) {
          fileContent = "";
        } else {
          fileContent = ctx.stdin;
          stdinConsumed = true;
        }
      } else {
        const filePath = ctx.fs.resolvePath(ctx.cwd, file);
        try {
          fileContent = await ctx.fs.readFile(filePath);
        } catch (e) {
          if (e instanceof ExecutionLimitError) {
            return {
              stdout: "",
              stderr: `sed: ${e.message}
`,
              exitCode: ExecutionLimitError.EXIT_CODE
            };
          }
          return {
            stdout: "",
            stderr: `sed: ${file}: No such file or directory
`,
            exitCode: 1
          };
        }
      }
      if (content.length > 0 && fileContent.length > 0 && !content.endsWith("\n")) {
        content += "\n";
      }
      content += fileContent;
    }
    try {
      const result = await processContent(content, commands, effectiveSilent, {
        limits: ctx.limits,
        filename: files.length === 1 ? files[0] : void 0,
        fs: ctx.fs,
        cwd: ctx.cwd
      });
      return {
        stdout: result.output,
        stderr: result.errorMessage ? `${result.errorMessage}
` : "",
        exitCode: result.exitCode ?? 0
      };
    } catch (e) {
      if (e instanceof ExecutionLimitError) {
        return {
          stdout: "",
          stderr: `sed: ${e.message}
`,
          exitCode: ExecutionLimitError.EXIT_CODE
        };
      }
      throw e;
    }
  }
};
export {
  sedCommand
};
