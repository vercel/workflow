import { _ as __name } from "../index.mjs";
function applyReplacement(replacement, match) {
  return replacement.replace(/\$(&|\d+|<([^>]+)>)/g, (_, ref, namedGroup) => {
    if (ref === "&") {
      return match[0];
    }
    if (namedGroup !== void 0) {
      return match.groups?.[namedGroup] ?? "";
    }
    const groupNum = parseInt(ref, 10);
    return match[groupNum] ?? "";
  });
}
__name(applyReplacement, "applyReplacement");
function searchContent(content, regex, options = {}) {
  const { invertMatch = false, showLineNumbers = false, countOnly = false, countMatches = false, filename = "", onlyMatching = false, beforeContext = 0, afterContext = 0, maxCount = 0, contextSeparator = "--", showColumn = false, vimgrep = false, showByteOffset = false, replace = null, passthru = false, multiline = false, kResetGroup } = options;
  if (multiline) {
    return searchContentMultiline(content, regex, {
      invertMatch,
      showLineNumbers,
      countOnly,
      countMatches,
      filename,
      onlyMatching,
      beforeContext,
      afterContext,
      maxCount,
      contextSeparator,
      showColumn,
      showByteOffset,
      replace,
      kResetGroup
    });
  }
  const lines = content.split("\n");
  const lineCount = lines.length;
  const lastIdx = lineCount > 0 && lines[lineCount - 1] === "" ? lineCount - 1 : lineCount;
  if (countOnly || countMatches) {
    let matchCount2 = 0;
    const shouldCountMatches = (countMatches || onlyMatching) && !invertMatch;
    for (let i = 0; i < lastIdx; i++) {
      regex.lastIndex = 0;
      if (shouldCountMatches) {
        for (let match = regex.exec(lines[i]); match !== null; match = regex.exec(lines[i])) {
          matchCount2++;
          if (match[0].length === 0)
            regex.lastIndex++;
        }
      } else {
        if (regex.test(lines[i]) !== invertMatch) {
          matchCount2++;
        }
      }
    }
    const countStr = filename ? `${filename}:${matchCount2}` : String(matchCount2);
    return { output: `${countStr}
`, matched: matchCount2 > 0, matchCount: matchCount2 };
  }
  if (beforeContext === 0 && afterContext === 0 && !passthru) {
    const outputLines2 = [];
    let hasMatch = false;
    let matchCount2 = 0;
    let byteOffset = 0;
    for (let i = 0; i < lastIdx; i++) {
      if (maxCount > 0 && matchCount2 >= maxCount)
        break;
      const line = lines[i];
      regex.lastIndex = 0;
      const matches = regex.test(line);
      if (matches !== invertMatch) {
        hasMatch = true;
        matchCount2++;
        if (onlyMatching) {
          regex.lastIndex = 0;
          for (let match = regex.exec(line); match !== null; match = regex.exec(line)) {
            const rawMatch = kResetGroup !== void 0 ? match[kResetGroup] ?? "" : match[0];
            const matchText = replace !== null ? applyReplacement(replace, match) : rawMatch;
            let prefix = filename ? `${filename}:` : "";
            if (showByteOffset)
              prefix += `${byteOffset + match.index}:`;
            if (showLineNumbers)
              prefix += `${i + 1}:`;
            if (showColumn)
              prefix += `${match.index + 1}:`;
            outputLines2.push(prefix + matchText);
            if (match[0].length === 0)
              regex.lastIndex++;
          }
        } else if (vimgrep) {
          regex.lastIndex = 0;
          for (let match = regex.exec(line); match !== null; match = regex.exec(line)) {
            let prefix = filename ? `${filename}:` : "";
            if (showByteOffset)
              prefix += `${byteOffset + match.index}:`;
            if (showLineNumbers)
              prefix += `${i + 1}:`;
            if (showColumn)
              prefix += `${match.index + 1}:`;
            outputLines2.push(prefix + line);
            if (match[0].length === 0)
              regex.lastIndex++;
          }
        } else {
          regex.lastIndex = 0;
          const firstMatch = regex.exec(line);
          const column = firstMatch ? firstMatch.index + 1 : 1;
          let outputLine = line;
          if (replace !== null) {
            regex.lastIndex = 0;
            outputLine = line.replace(regex, (...args) => {
              const matchText = args[0];
              if (matchText.length === 0)
                return "";
              const match = args;
              const lastArg = args[args.length - 1];
              if (typeof lastArg === "object" && lastArg !== null) {
                match.groups = lastArg;
                match.input = args[args.length - 2];
                match.index = args[args.length - 3];
              } else {
                match.input = args[args.length - 1];
                match.index = args[args.length - 2];
              }
              return applyReplacement(replace, match);
            });
          }
          let prefix = filename ? `${filename}:` : "";
          if (showByteOffset)
            prefix += `${byteOffset + (firstMatch ? firstMatch.index : 0)}:`;
          if (showLineNumbers)
            prefix += `${i + 1}:`;
          if (showColumn)
            prefix += `${column}:`;
          outputLines2.push(prefix + outputLine);
        }
      }
      byteOffset += line.length + 1;
    }
    return {
      output: outputLines2.length > 0 ? `${outputLines2.join("\n")}
` : "",
      matched: hasMatch,
      matchCount: matchCount2
    };
  }
  if (passthru) {
    const outputLines2 = [];
    let hasMatch = false;
    let matchCount2 = 0;
    for (let i = 0; i < lastIdx; i++) {
      const line = lines[i];
      regex.lastIndex = 0;
      const matches = regex.test(line);
      const isMatch = matches !== invertMatch;
      if (isMatch) {
        hasMatch = true;
        matchCount2++;
      }
      const sep = isMatch ? ":" : "-";
      let prefix = filename ? `${filename}${sep}` : "";
      if (showLineNumbers)
        prefix += `${i + 1}${sep}`;
      outputLines2.push(prefix + line);
    }
    return {
      output: outputLines2.length > 0 ? `${outputLines2.join("\n")}
` : "",
      matched: hasMatch,
      matchCount: matchCount2
    };
  }
  const outputLines = [];
  let matchCount = 0;
  const printedLines = /* @__PURE__ */ new Set();
  let lastPrintedLine = -1;
  const matchingLineNumbers = [];
  for (let i = 0; i < lastIdx; i++) {
    if (maxCount > 0 && matchCount >= maxCount)
      break;
    regex.lastIndex = 0;
    if (regex.test(lines[i]) !== invertMatch) {
      matchingLineNumbers.push(i);
      matchCount++;
    }
  }
  for (const lineNum of matchingLineNumbers) {
    const contextStart = Math.max(0, lineNum - beforeContext);
    if (lastPrintedLine >= 0 && contextStart > lastPrintedLine + 1) {
      outputLines.push(contextSeparator);
    }
    for (let i = contextStart; i < lineNum; i++) {
      if (!printedLines.has(i)) {
        printedLines.add(i);
        lastPrintedLine = i;
        let outputLine = lines[i];
        if (showLineNumbers)
          outputLine = `${i + 1}-${outputLine}`;
        if (filename)
          outputLine = `${filename}-${outputLine}`;
        outputLines.push(outputLine);
      }
    }
    if (!printedLines.has(lineNum)) {
      printedLines.add(lineNum);
      lastPrintedLine = lineNum;
      const line = lines[lineNum];
      if (onlyMatching) {
        regex.lastIndex = 0;
        for (let match = regex.exec(line); match !== null; match = regex.exec(line)) {
          const rawMatch = kResetGroup !== void 0 ? match[kResetGroup] ?? "" : match[0];
          const matchText = replace !== null ? replace : rawMatch;
          let prefix = filename ? `${filename}:` : "";
          if (showLineNumbers)
            prefix += `${lineNum + 1}:`;
          if (showColumn)
            prefix += `${match.index + 1}:`;
          outputLines.push(prefix + matchText);
          if (match[0].length === 0)
            regex.lastIndex++;
        }
      } else {
        let outputLine = line;
        if (showLineNumbers)
          outputLine = `${lineNum + 1}:${outputLine}`;
        if (filename)
          outputLine = `${filename}:${outputLine}`;
        outputLines.push(outputLine);
      }
    }
    const maxAfter = Math.min(lastIdx - 1, lineNum + afterContext);
    for (let i = lineNum + 1; i <= maxAfter; i++) {
      if (!printedLines.has(i)) {
        printedLines.add(i);
        lastPrintedLine = i;
        let outputLine = lines[i];
        if (showLineNumbers)
          outputLine = `${i + 1}-${outputLine}`;
        if (filename)
          outputLine = `${filename}-${outputLine}`;
        outputLines.push(outputLine);
      }
    }
  }
  return {
    output: outputLines.length > 0 ? `${outputLines.join("\n")}
` : "",
    matched: matchCount > 0,
    matchCount
  };
}
__name(searchContent, "searchContent");
function searchContentMultiline(content, regex, options) {
  const { invertMatch, showLineNumbers, countOnly, countMatches, filename, onlyMatching, beforeContext, afterContext, maxCount, contextSeparator, showColumn, showByteOffset, replace, kResetGroup } = options;
  const lines = content.split("\n");
  const lineCount = lines.length;
  const lastIdx = lineCount > 0 && lines[lineCount - 1] === "" ? lineCount - 1 : lineCount;
  const lineOffsets = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") {
      lineOffsets.push(i + 1);
    }
  }
  const getLineIndex = /* @__PURE__ */ __name((byteOffset) => {
    let line = 0;
    for (let i = 0; i < lineOffsets.length; i++) {
      if (lineOffsets[i] > byteOffset)
        break;
      line = i;
    }
    return line;
  }, "getLineIndex");
  const getColumn = /* @__PURE__ */ __name((byteOffset) => {
    const lineIdx = getLineIndex(byteOffset);
    return byteOffset - lineOffsets[lineIdx] + 1;
  }, "getColumn");
  const matchSpans = [];
  regex.lastIndex = 0;
  for (let match = regex.exec(content); match !== null; match = regex.exec(content)) {
    if (maxCount > 0 && matchSpans.length >= maxCount)
      break;
    const startLine = getLineIndex(match.index);
    const endLine = getLineIndex(match.index + Math.max(0, match[0].length - 1));
    const extractedMatch = kResetGroup !== void 0 ? match[kResetGroup] ?? "" : match[0];
    matchSpans.push({
      startLine,
      endLine,
      byteOffset: match.index,
      column: getColumn(match.index),
      matchText: extractedMatch
    });
    if (match[0].length === 0)
      regex.lastIndex++;
  }
  if (countOnly || countMatches) {
    let matchCount;
    if (countMatches) {
      matchCount = invertMatch ? 0 : matchSpans.length;
    } else {
      const matchedLines = /* @__PURE__ */ new Set();
      for (const span of matchSpans) {
        for (let i = span.startLine; i <= span.endLine; i++) {
          matchedLines.add(i);
        }
      }
      matchCount = invertMatch ? lastIdx - matchedLines.size : matchedLines.size;
    }
    const countStr = filename ? `${filename}:${matchCount}` : String(matchCount);
    return { output: `${countStr}
`, matched: matchCount > 0, matchCount };
  }
  if (invertMatch) {
    const matchedLines = /* @__PURE__ */ new Set();
    for (const span of matchSpans) {
      for (let i = span.startLine; i <= span.endLine; i++) {
        matchedLines.add(i);
      }
    }
    const outputLines2 = [];
    for (let i = 0; i < lastIdx; i++) {
      if (!matchedLines.has(i)) {
        let line = lines[i];
        if (showLineNumbers)
          line = `${i + 1}:${line}`;
        if (filename)
          line = `${filename}:${line}`;
        outputLines2.push(line);
      }
    }
    return {
      output: outputLines2.length > 0 ? `${outputLines2.join("\n")}
` : "",
      matched: outputLines2.length > 0,
      matchCount: outputLines2.length
    };
  }
  if (matchSpans.length === 0) {
    return { output: "", matched: false, matchCount: 0 };
  }
  const printedLines = /* @__PURE__ */ new Set();
  let lastPrintedLine = -1;
  const outputLines = [];
  for (const span of matchSpans) {
    const contextStart = Math.max(0, span.startLine - beforeContext);
    const contextEnd = Math.min(lastIdx - 1, span.endLine + afterContext);
    if (lastPrintedLine >= 0 && contextStart > lastPrintedLine + 1) {
      outputLines.push(contextSeparator);
    }
    for (let i = contextStart; i < span.startLine; i++) {
      if (!printedLines.has(i)) {
        printedLines.add(i);
        lastPrintedLine = i;
        let line = lines[i];
        if (showLineNumbers)
          line = `${i + 1}-${line}`;
        if (filename)
          line = `${filename}-${line}`;
        outputLines.push(line);
      }
    }
    if (onlyMatching) {
      const matchText = replace !== null ? replace : span.matchText;
      let prefix = filename ? `${filename}:` : "";
      if (showByteOffset)
        prefix += `${span.byteOffset}:`;
      if (showLineNumbers)
        prefix += `${span.startLine + 1}:`;
      if (showColumn)
        prefix += `${span.column}:`;
      outputLines.push(prefix + matchText);
      for (let i = span.startLine; i <= span.endLine; i++) {
        printedLines.add(i);
        lastPrintedLine = i;
      }
    } else {
      for (let i = span.startLine; i <= span.endLine && i < lastIdx; i++) {
        if (!printedLines.has(i)) {
          printedLines.add(i);
          lastPrintedLine = i;
          let line = lines[i];
          if (replace !== null && i === span.startLine) {
            regex.lastIndex = 0;
            line = line.replace(regex, replace);
          }
          let prefix = filename ? `${filename}:` : "";
          if (showByteOffset && i === span.startLine)
            prefix += `${span.byteOffset}:`;
          if (showLineNumbers)
            prefix += `${i + 1}:`;
          if (showColumn && i === span.startLine)
            prefix += `${span.column}:`;
          outputLines.push(prefix + line);
        }
      }
    }
    for (let i = span.endLine + 1; i <= contextEnd; i++) {
      if (!printedLines.has(i)) {
        printedLines.add(i);
        lastPrintedLine = i;
        let line = lines[i];
        if (showLineNumbers)
          line = `${i + 1}-${line}`;
        if (filename)
          line = `${filename}-${line}`;
        outputLines.push(line);
      }
    }
  }
  return {
    output: outputLines.length > 0 ? `${outputLines.join("\n")}
` : "",
    matched: true,
    matchCount: matchSpans.length
  };
}
__name(searchContentMultiline, "searchContentMultiline");
var POSIX_CLASS_MAP = {
  alpha: "a-zA-Z",
  digit: "0-9",
  alnum: "a-zA-Z0-9",
  lower: "a-z",
  upper: "A-Z",
  xdigit: "0-9A-Fa-f",
  space: " \\t\\n\\r\\f\\v",
  blank: " \\t",
  punct: "!-/:-@\\[-`{-~",
  graph: "!-~",
  print: " -~",
  cntrl: "\\x00-\\x1F\\x7F",
  ascii: "\\x00-\\x7F",
  word: "a-zA-Z0-9_"
};
function transformPosixCharacterClasses(pattern) {
  let result = "";
  let i = 0;
  while (i < pattern.length) {
    if (pattern.slice(i, i + 7) === "[[:<:]]") {
      result += "(?<![\\w])";
      i += 7;
      continue;
    }
    if (pattern.slice(i, i + 7) === "[[:>:]]") {
      result += "(?![\\w])";
      i += 7;
      continue;
    }
    if (pattern[i] === "[") {
      let bracketExpr = "[";
      i++;
      if (i < pattern.length && (pattern[i] === "^" || pattern[i] === "!")) {
        bracketExpr += "^";
        i++;
      }
      if (i < pattern.length && pattern[i] === "]") {
        bracketExpr += "\\]";
        i++;
      }
      while (i < pattern.length && pattern[i] !== "]") {
        if (pattern[i] === "[" && i + 1 < pattern.length && pattern[i + 1] === ":") {
          const closeIdx = pattern.indexOf(":]", i + 2);
          if (closeIdx !== -1) {
            const className = pattern.slice(i + 2, closeIdx);
            const replacement = POSIX_CLASS_MAP[className];
            if (replacement) {
              bracketExpr += replacement;
              i = closeIdx + 2;
              continue;
            }
          }
        }
        if (pattern[i] === "\\" && i + 1 < pattern.length) {
          bracketExpr += pattern[i] + pattern[i + 1];
          i += 2;
          continue;
        }
        bracketExpr += pattern[i];
        i++;
      }
      if (i < pattern.length && pattern[i] === "]") {
        bracketExpr += "]";
        i++;
      }
      result += bracketExpr;
      continue;
    }
    if (pattern[i] === "\\" && i + 1 < pattern.length) {
      result += pattern[i] + pattern[i + 1];
      i += 2;
      continue;
    }
    result += pattern[i];
    i++;
  }
  return result;
}
__name(transformPosixCharacterClasses, "transformPosixCharacterClasses");
function buildRegex(pattern, options) {
  let regexPattern;
  let kResetGroup;
  switch (options.mode) {
    case "fixed":
      regexPattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      break;
    case "extended":
    case "perl": {
      regexPattern = transformPosixCharacterClasses(pattern);
      regexPattern = regexPattern.replace(/\(\?P<([^>]+)>/g, "(?<$1>");
      if (options.mode === "perl") {
        regexPattern = handleQuoteMetachars(regexPattern);
        regexPattern = handleUnicodeCodePoints(regexPattern);
        regexPattern = handleInlineModifiers(regexPattern);
        const kResult = handlePerlKReset(regexPattern);
        regexPattern = kResult.pattern;
        kResetGroup = kResult.kResetGroup;
      }
      break;
    }
    default:
      regexPattern = transformPosixCharacterClasses(pattern);
      regexPattern = escapeRegexForBasicGrep(regexPattern);
      break;
  }
  if (options.wholeWord) {
    regexPattern = `(?<![\\w])(?:${regexPattern})(?![\\w])`;
  }
  if (options.lineRegexp) {
    regexPattern = `^${regexPattern}$`;
  }
  const needsUnicode = /\\u\{[0-9A-Fa-f]+\}/.test(regexPattern);
  const flags = "g" + (options.ignoreCase ? "i" : "") + (options.multiline ? "m" : "") + (options.multilineDotall ? "s" : "") + (needsUnicode ? "u" : "");
  return { regex: new RegExp(regexPattern, flags), kResetGroup };
}
__name(buildRegex, "buildRegex");
function handleQuoteMetachars(pattern) {
  let result = "";
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === "\\" && i + 1 < pattern.length && pattern[i + 1] === "Q") {
      i += 2;
      let quoted = "";
      while (i < pattern.length) {
        if (pattern[i] === "\\" && i + 1 < pattern.length && pattern[i + 1] === "E") {
          i += 2;
          break;
        }
        quoted += pattern[i];
        i++;
      }
      result += quoted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else {
      result += pattern[i];
      i++;
    }
  }
  return result;
}
__name(handleQuoteMetachars, "handleQuoteMetachars");
function handleUnicodeCodePoints(pattern) {
  return pattern.replace(/\\x\{([0-9A-Fa-f]+)\}/g, "\\u{$1}");
}
__name(handleUnicodeCodePoints, "handleUnicodeCodePoints");
function handleInlineModifiers(pattern) {
  let result = "";
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === "(" && i + 1 < pattern.length && pattern[i + 1] === "?") {
      const modifierMatch = pattern.slice(i).match(/^\(\?([imsx]*)(-[imsx]*)?(:|$|\))/);
      if (modifierMatch) {
        const enableMods = modifierMatch[1] || "";
        modifierMatch[2] || "";
        const delimiter = modifierMatch[3];
        if (delimiter === ":") {
          const groupStart = i + modifierMatch[0].length - 1;
          const groupEnd = findMatchingParen(pattern, i);
          if (groupEnd !== -1) {
            const groupContent = pattern.slice(groupStart + 1, groupEnd);
            const transformed = applyInlineModifiers(groupContent, enableMods);
            result += `(?:${transformed})`;
            i = groupEnd + 1;
            continue;
          }
        } else if (delimiter === ")" || delimiter === "") {
          i += modifierMatch[0].length;
          continue;
        }
      }
    }
    result += pattern[i];
    i++;
  }
  return result;
}
__name(handleInlineModifiers, "handleInlineModifiers");
function findMatchingParen(pattern, start) {
  let depth = 0;
  let i = start;
  while (i < pattern.length) {
    if (pattern[i] === "\\") {
      i += 2;
      continue;
    }
    if (pattern[i] === "[") {
      i++;
      while (i < pattern.length && pattern[i] !== "]") {
        if (pattern[i] === "\\")
          i++;
        i++;
      }
      i++;
      continue;
    }
    if (pattern[i] === "(") {
      depth++;
    } else if (pattern[i] === ")") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
    i++;
  }
  return -1;
}
__name(findMatchingParen, "findMatchingParen");
function applyInlineModifiers(pattern, enableMods, _disableMods) {
  let result = pattern;
  if (enableMods.includes("i")) {
    result = makeCaseInsensitive(result);
  }
  return result;
}
__name(applyInlineModifiers, "applyInlineModifiers");
function makeCaseInsensitive(pattern) {
  let result = "";
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i];
    if (char === "\\") {
      if (i + 1 < pattern.length) {
        result += char + pattern[i + 1];
        i += 2;
      } else {
        result += char;
        i++;
      }
      continue;
    }
    if (char === "[") {
      result += char;
      i++;
      if (i < pattern.length && pattern[i] === "^") {
        result += pattern[i];
        i++;
      }
      const classChars = [];
      while (i < pattern.length && pattern[i] !== "]") {
        if (pattern[i] === "\\") {
          classChars.push(pattern[i]);
          i++;
          if (i < pattern.length) {
            classChars.push(pattern[i]);
            i++;
          }
        } else if (pattern[i] === "-" && classChars.length > 0 && i + 1 < pattern.length && pattern[i + 1] !== "]") {
          const rangeStart = classChars[classChars.length - 1];
          const rangeEnd = pattern[i + 1];
          classChars.push("-");
          classChars.push(rangeEnd);
          if (/[a-z]/.test(rangeStart) && /[a-z]/.test(rangeEnd)) {
            classChars.push(rangeStart.toUpperCase());
            classChars.push("-");
            classChars.push(rangeEnd.toUpperCase());
          } else if (/[A-Z]/.test(rangeStart) && /[A-Z]/.test(rangeEnd)) {
            classChars.push(rangeStart.toLowerCase());
            classChars.push("-");
            classChars.push(rangeEnd.toLowerCase());
          }
          i += 2;
        } else {
          const c = pattern[i];
          classChars.push(c);
          if (/[a-zA-Z]/.test(c)) {
            const variant = c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase();
            if (!classChars.includes(variant)) {
              classChars.push(variant);
            }
          }
          i++;
        }
      }
      result += classChars.join("");
      if (i < pattern.length) {
        result += pattern[i];
        i++;
      }
      continue;
    }
    if (/[a-zA-Z]/.test(char)) {
      const lower = char.toLowerCase();
      const upper = char.toUpperCase();
      result += `[${upper}${lower}]`;
    } else {
      result += char;
    }
    i++;
  }
  return result;
}
__name(makeCaseInsensitive, "makeCaseInsensitive");
function handlePerlKReset(pattern) {
  const kIndex = findUnescapedK(pattern);
  if (kIndex === -1) {
    return { pattern };
  }
  const before = pattern.slice(0, kIndex);
  const after = pattern.slice(kIndex + 2);
  const groupsBefore = countCapturingGroups(before);
  const newPattern = `(?:${before})(${after})`;
  return {
    pattern: newPattern,
    // The capturing group for "after" will be groupsBefore + 1
    kResetGroup: groupsBefore + 1
  };
}
__name(handlePerlKReset, "handlePerlKReset");
function findUnescapedK(pattern) {
  let i = 0;
  while (i < pattern.length - 1) {
    if (pattern[i] === "\\") {
      if (pattern[i + 1] === "K") {
        let backslashCount = 0;
        let j = i - 1;
        while (j >= 0 && pattern[j] === "\\") {
          backslashCount++;
          j--;
        }
        if (backslashCount % 2 === 0) {
          return i;
        }
      }
      i += 2;
    } else {
      i++;
    }
  }
  return -1;
}
__name(findUnescapedK, "findUnescapedK");
function countCapturingGroups(pattern) {
  let count = 0;
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === "\\") {
      i += 2;
      continue;
    }
    if (pattern[i] === "[") {
      i++;
      while (i < pattern.length && pattern[i] !== "]") {
        if (pattern[i] === "\\")
          i++;
        i++;
      }
      i++;
      continue;
    }
    if (pattern[i] === "(") {
      if (i + 1 < pattern.length && pattern[i + 1] === "?") {
        if (i + 2 < pattern.length) {
          const nextChar = pattern[i + 2];
          if (nextChar === ":" || nextChar === "=" || nextChar === "!") {
            i++;
            continue;
          }
          if (nextChar === "<") {
            if (i + 3 < pattern.length) {
              const afterLt = pattern[i + 3];
              if (afterLt === "=" || afterLt === "!") {
                i++;
                continue;
              }
              count++;
              i++;
              continue;
            }
          }
        }
      } else {
        count++;
      }
    }
    i++;
  }
  return count;
}
__name(countCapturingGroups, "countCapturingGroups");
function convertReplacement(replacement) {
  let result = replacement.replace(/\$\{0\}|\$0(?![0-9])/g, "$$&");
  result = result.replace(/\$\{([^0-9}][^}]*)\}/g, "$$<$1>");
  result = result.replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)(?![>0-9])/g, "$$<$1>");
  return result;
}
__name(convertReplacement, "convertReplacement");
function escapeRegexForBasicGrep(str) {
  let result = "";
  let i = 0;
  let atPatternStart = true;
  while (i < str.length) {
    const char = str[i];
    if (char === "[") {
      result += char;
      i++;
      if (i < str.length && (str[i] === "^" || str[i] === "!")) {
        result += str[i];
        i++;
      }
      if (i < str.length && str[i] === "]") {
        result += str[i];
        i++;
      }
      while (i < str.length && str[i] !== "]") {
        if (str[i] === "\\" && i + 1 < str.length) {
          result += str[i] + str[i + 1];
          i += 2;
        } else {
          result += str[i];
          i++;
        }
      }
      if (i < str.length && str[i] === "]") {
        result += str[i];
        i++;
      }
      atPatternStart = false;
      continue;
    }
    if (char === "\\" && i + 1 < str.length) {
      const nextChar = str[i + 1];
      if (nextChar === "|") {
        result += "|";
        i += 2;
        atPatternStart = true;
        continue;
      }
      if (nextChar === "(") {
        result += "(";
        i += 2;
        atPatternStart = true;
        continue;
      }
      if (nextChar === ")") {
        result += ")";
        i += 2;
        atPatternStart = false;
        continue;
      }
      if (nextChar === "{") {
        const remaining = str.slice(i);
        const intervalMatch = remaining.match(/^\\{(\d+)(,(\d*)?)?\\}/);
        if (intervalMatch) {
          const min = intervalMatch[1];
          const hasComma = intervalMatch[2] !== void 0;
          const max = intervalMatch[3] || "";
          if (hasComma) {
            result += `{${min},${max}}`;
          } else {
            result += `{${min}}`;
          }
          i += intervalMatch[0].length;
          atPatternStart = false;
          continue;
        }
        result += `\\{`;
        i += 2;
        atPatternStart = false;
        continue;
      }
      if (nextChar === "}") {
        result += `\\}`;
        i += 2;
        atPatternStart = false;
        continue;
      }
      result += char + nextChar;
      i += 2;
      atPatternStart = false;
      continue;
    }
    if (char === "*" && atPatternStart) {
      result += "\\*";
      i++;
      continue;
    }
    if (char === "^") {
      if (atPatternStart) {
        result += "^";
        i++;
        continue;
      }
      result += "\\^";
      i++;
      continue;
    }
    if (char === "$") {
      const isAtEnd = i === str.length - 1;
      const isBeforeGroupEnd = i + 2 < str.length && str[i + 1] === "\\" && str[i + 2] === ")";
      if (isAtEnd || isBeforeGroupEnd) {
        result += "$";
      } else {
        result += "\\$";
      }
      i++;
      atPatternStart = false;
      continue;
    }
    if (char === "+" || char === "?" || char === "|" || char === "(" || char === ")" || char === "{" || char === "}") {
      result += `\\${char}`;
    } else {
      result += char;
    }
    i++;
    atPatternStart = false;
  }
  return result;
}
__name(escapeRegexForBasicGrep, "escapeRegexForBasicGrep");
export {
  buildRegex as b,
  convertReplacement as c,
  searchContent as s
};
