import {
  readAndConcat
} from "./chunk-XTSQ6SVV.js";
import "./chunk-PRIRMCRG.js";
import {
  hasHelpFlag,
  showHelp,
  unknownOption
} from "./chunk-HAN5425M.js";
import {
  __name
} from "./chunk-Y7IWVHJ4.js";

// dist/commands/sort/comparator.js
var SIZE_SUFFIXES = {
  "": 1,
  k: 1024,
  m: 1024 ** 2,
  g: 1024 ** 3,
  t: 1024 ** 4,
  p: 1024 ** 5,
  e: 1024 ** 6
};
var MONTHS = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12
};
function parseHumanSize(s) {
  const trimmed = s.trim();
  const match = trimmed.match(/^([+-]?\d*\.?\d+)\s*([kmgtpeKMGTPE])?[iI]?[bB]?$/);
  if (!match) {
    const num2 = parseFloat(trimmed);
    return Number.isNaN(num2) ? 0 : num2;
  }
  const num = parseFloat(match[1]);
  const suffix = (match[2] || "").toLowerCase();
  const multiplier = SIZE_SUFFIXES[suffix] || 1;
  return num * multiplier;
}
__name(parseHumanSize, "parseHumanSize");
function parseMonth(s) {
  const trimmed = s.trim().toLowerCase().slice(0, 3);
  return MONTHS[trimmed] || 0;
}
__name(parseMonth, "parseMonth");
function compareVersions(a, b) {
  const partsA = a.split(/(\d+)/);
  const partsB = b.split(/(\d+)/);
  const maxLen = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < maxLen; i++) {
    const partA = partsA[i] || "";
    const partB = partsB[i] || "";
    const numA = /^\d+$/.test(partA) ? parseInt(partA, 10) : null;
    const numB = /^\d+$/.test(partB) ? parseInt(partB, 10) : null;
    if (numA !== null && numB !== null) {
      if (numA !== numB)
        return numA - numB;
    } else {
      if (partA !== partB)
        return partA.localeCompare(partB);
    }
  }
  return 0;
}
__name(compareVersions, "compareVersions");
function toDictionaryOrder(s) {
  return s.replace(/[^a-zA-Z0-9\s]/g, "");
}
__name(toDictionaryOrder, "toDictionaryOrder");
function extractKeyValue(line, key, delimiter) {
  const splitPattern = delimiter !== null ? delimiter : /\s+/;
  const fields = line.split(splitPattern);
  const startFieldIdx = key.startField - 1;
  if (startFieldIdx >= fields.length) {
    return "";
  }
  if (key.endField === void 0) {
    let field = fields[startFieldIdx] || "";
    if (key.startChar !== void 0) {
      field = field.slice(key.startChar - 1);
    }
    if (key.ignoreLeading) {
      field = field.trimStart();
    }
    return field;
  }
  const endFieldIdx = Math.min(key.endField - 1, fields.length - 1);
  let result = "";
  for (let i = startFieldIdx; i <= endFieldIdx && i < fields.length; i++) {
    let field = fields[i] || "";
    if (i === startFieldIdx && key.startChar !== void 0) {
      field = field.slice(key.startChar - 1);
    }
    if (i === endFieldIdx && key.endChar !== void 0) {
      const endIdx = i === startFieldIdx && key.startChar !== void 0 ? key.endChar - key.startChar + 1 : key.endChar;
      field = field.slice(0, endIdx);
    }
    if (i > startFieldIdx) {
      result += delimiter || " ";
    }
    result += field;
  }
  if (key.ignoreLeading) {
    result = result.trimStart();
  }
  return result;
}
__name(extractKeyValue, "extractKeyValue");
function compareValues(a, b, opts) {
  let valA = a;
  let valB = b;
  if (opts.dictionaryOrder) {
    valA = toDictionaryOrder(valA);
    valB = toDictionaryOrder(valB);
  }
  if (opts.ignoreCase) {
    valA = valA.toLowerCase();
    valB = valB.toLowerCase();
  }
  if (opts.monthSort) {
    const monthA = parseMonth(valA);
    const monthB = parseMonth(valB);
    return monthA - monthB;
  }
  if (opts.humanNumeric) {
    const sizeA = parseHumanSize(valA);
    const sizeB = parseHumanSize(valB);
    return sizeA - sizeB;
  }
  if (opts.versionSort) {
    return compareVersions(valA, valB);
  }
  if (opts.numeric) {
    const numA = parseFloat(valA) || 0;
    const numB = parseFloat(valB) || 0;
    return numA - numB;
  }
  return valA.localeCompare(valB);
}
__name(compareValues, "compareValues");
function createComparator(options) {
  const { keys, fieldDelimiter, numeric: globalNumeric, ignoreCase: globalIgnoreCase, reverse: globalReverse, humanNumeric: globalHumanNumeric, versionSort: globalVersionSort, dictionaryOrder: globalDictionaryOrder, monthSort: globalMonthSort, ignoreLeadingBlanks: globalIgnoreLeadingBlanks, stable: globalStable } = options;
  return (a, b) => {
    let lineA = a;
    let lineB = b;
    if (globalIgnoreLeadingBlanks) {
      lineA = lineA.trimStart();
      lineB = lineB.trimStart();
    }
    if (keys.length === 0) {
      const opts = {
        numeric: globalNumeric,
        ignoreCase: globalIgnoreCase,
        humanNumeric: globalHumanNumeric,
        versionSort: globalVersionSort,
        dictionaryOrder: globalDictionaryOrder,
        monthSort: globalMonthSort
      };
      const result = compareValues(lineA, lineB, opts);
      if (result !== 0) {
        return globalReverse ? -result : result;
      }
      if (!globalStable) {
        const tiebreaker = a.localeCompare(b);
        return globalReverse ? -tiebreaker : tiebreaker;
      }
      return 0;
    }
    for (const key of keys) {
      let valA = extractKeyValue(lineA, key, fieldDelimiter);
      let valB = extractKeyValue(lineB, key, fieldDelimiter);
      if (key.ignoreLeading) {
        valA = valA.trimStart();
        valB = valB.trimStart();
      }
      const opts = {
        numeric: key.numeric ?? globalNumeric,
        ignoreCase: key.ignoreCase ?? globalIgnoreCase,
        humanNumeric: key.humanNumeric ?? globalHumanNumeric,
        versionSort: key.versionSort ?? globalVersionSort,
        dictionaryOrder: key.dictionaryOrder ?? globalDictionaryOrder,
        monthSort: key.monthSort ?? globalMonthSort
      };
      const useReverse = key.reverse ?? globalReverse;
      const result = compareValues(valA, valB, opts);
      if (result !== 0) {
        return useReverse ? -result : result;
      }
    }
    if (!globalStable) {
      const tiebreaker = a.localeCompare(b);
      return globalReverse ? -tiebreaker : tiebreaker;
    }
    return 0;
  };
}
__name(createComparator, "createComparator");
function filterUnique(lines, options) {
  if (options.keys.length === 0) {
    if (options.ignoreCase) {
      const seen2 = /* @__PURE__ */ new Set();
      return lines.filter((line) => {
        const key2 = line.toLowerCase();
        if (seen2.has(key2))
          return false;
        seen2.add(key2);
        return true;
      });
    }
    return [...new Set(lines)];
  }
  const key = options.keys[0];
  const seen = /* @__PURE__ */ new Set();
  return lines.filter((line) => {
    let keyVal = extractKeyValue(line, key, options.fieldDelimiter);
    if (key.ignoreCase ?? options.ignoreCase) {
      keyVal = keyVal.toLowerCase();
    }
    if (seen.has(keyVal))
      return false;
    seen.add(keyVal);
    return true;
  });
}
__name(filterUnique, "filterUnique");

// dist/commands/sort/parser.js
function parseKeySpec(spec) {
  const result = {
    startField: 1
  };
  let modifierStr = "";
  let mainSpec = spec;
  const modifierMatch = mainSpec.match(/([bdfhMnrV]+)$/);
  if (modifierMatch) {
    modifierStr = modifierMatch[1];
    mainSpec = mainSpec.slice(0, -modifierStr.length);
  }
  if (modifierStr.includes("n"))
    result.numeric = true;
  if (modifierStr.includes("r"))
    result.reverse = true;
  if (modifierStr.includes("f"))
    result.ignoreCase = true;
  if (modifierStr.includes("b"))
    result.ignoreLeading = true;
  if (modifierStr.includes("h"))
    result.humanNumeric = true;
  if (modifierStr.includes("V"))
    result.versionSort = true;
  if (modifierStr.includes("d"))
    result.dictionaryOrder = true;
  if (modifierStr.includes("M"))
    result.monthSort = true;
  const parts = mainSpec.split(",");
  if (parts.length === 0 || parts[0] === "") {
    return null;
  }
  const startParts = parts[0].split(".");
  const startField = parseInt(startParts[0], 10);
  if (Number.isNaN(startField) || startField < 1) {
    return null;
  }
  result.startField = startField;
  if (startParts.length > 1 && startParts[1]) {
    const startChar = parseInt(startParts[1], 10);
    if (!Number.isNaN(startChar) && startChar >= 1) {
      result.startChar = startChar;
    }
  }
  if (parts.length > 1 && parts[1]) {
    let endPart = parts[1];
    const endModifierMatch = endPart.match(/([bdfhMnrV]+)$/);
    if (endModifierMatch) {
      const endModifiers = endModifierMatch[1];
      if (endModifiers.includes("n"))
        result.numeric = true;
      if (endModifiers.includes("r"))
        result.reverse = true;
      if (endModifiers.includes("f"))
        result.ignoreCase = true;
      if (endModifiers.includes("b"))
        result.ignoreLeading = true;
      if (endModifiers.includes("h"))
        result.humanNumeric = true;
      if (endModifiers.includes("V"))
        result.versionSort = true;
      if (endModifiers.includes("d"))
        result.dictionaryOrder = true;
      if (endModifiers.includes("M"))
        result.monthSort = true;
      endPart = endPart.slice(0, -endModifiers.length);
    }
    const endParts = endPart.split(".");
    if (endParts[0]) {
      const endField = parseInt(endParts[0], 10);
      if (!Number.isNaN(endField) && endField >= 1) {
        result.endField = endField;
      }
      if (endParts.length > 1 && endParts[1]) {
        const endChar = parseInt(endParts[1], 10);
        if (!Number.isNaN(endChar) && endChar >= 1) {
          result.endChar = endChar;
        }
      }
    }
  }
  return result;
}
__name(parseKeySpec, "parseKeySpec");

// dist/commands/sort/sort.js
var sortHelp = {
  name: "sort",
  summary: "sort lines of text files",
  usage: "sort [OPTION]... [FILE]...",
  options: [
    "-b, --ignore-leading-blanks  ignore leading blanks",
    "-d, --dictionary-order  consider only blanks and alphanumeric characters",
    "-f, --ignore-case    fold lower case to upper case characters",
    "-h, --human-numeric-sort  compare human readable numbers (e.g., 2K 1G)",
    "-M, --month-sort     compare (unknown) < 'JAN' < ... < 'DEC'",
    "-n, --numeric-sort   compare according to string numerical value",
    "-r, --reverse        reverse the result of comparisons",
    "-V, --version-sort   natural sort of (version) numbers within text",
    "-c, --check          check for sorted input; do not sort",
    "-o, --output=FILE    write result to FILE instead of stdout",
    "-s, --stable         stabilize sort by disabling last-resort comparison",
    "-u, --unique         output only unique lines",
    "-k, --key=KEYDEF     sort via a key; KEYDEF gives location and type",
    "-t, --field-separator=SEP  use SEP as field separator",
    "    --help           display this help and exit"
  ],
  description: `KEYDEF is F[.C][OPTS][,F[.C][OPTS]]
  F is a field number (1-indexed)
  C is a character position within the field (1-indexed)
  OPTS can be: b d f h M n r V (per-key modifiers)

Examples:
  -k1        sort by first field
  -k2,2      sort by second field only
  -k1.3      sort by first field starting at 3rd character
  -k1,2n     sort by fields 1-2 numerically
  -k2 -k1    sort by field 2, then by field 1`
};
var sortCommand = {
  name: "sort",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) {
      return showHelp(sortHelp);
    }
    const options = {
      reverse: false,
      numeric: false,
      unique: false,
      ignoreCase: false,
      humanNumeric: false,
      versionSort: false,
      dictionaryOrder: false,
      monthSort: false,
      ignoreLeadingBlanks: false,
      stable: false,
      checkOnly: false,
      outputFile: null,
      keys: [],
      fieldDelimiter: null
    };
    const files = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "-r" || arg === "--reverse") {
        options.reverse = true;
      } else if (arg === "-n" || arg === "--numeric-sort") {
        options.numeric = true;
      } else if (arg === "-u" || arg === "--unique") {
        options.unique = true;
      } else if (arg === "-f" || arg === "--ignore-case") {
        options.ignoreCase = true;
      } else if (arg === "-h" || arg === "--human-numeric-sort") {
        options.humanNumeric = true;
      } else if (arg === "-V" || arg === "--version-sort") {
        options.versionSort = true;
      } else if (arg === "-d" || arg === "--dictionary-order") {
        options.dictionaryOrder = true;
      } else if (arg === "-M" || arg === "--month-sort") {
        options.monthSort = true;
      } else if (arg === "-b" || arg === "--ignore-leading-blanks") {
        options.ignoreLeadingBlanks = true;
      } else if (arg === "-s" || arg === "--stable") {
        options.stable = true;
      } else if (arg === "-c" || arg === "--check") {
        options.checkOnly = true;
      } else if (arg === "-o" || arg === "--output") {
        options.outputFile = args[++i] || null;
      } else if (arg.startsWith("-o")) {
        options.outputFile = arg.slice(2) || null;
      } else if (arg.startsWith("--output=")) {
        options.outputFile = arg.slice(9) || null;
      } else if (arg === "-t" || arg === "--field-separator") {
        options.fieldDelimiter = args[++i] || null;
      } else if (arg.startsWith("-t")) {
        options.fieldDelimiter = arg.slice(2) || null;
      } else if (arg.startsWith("--field-separator=")) {
        options.fieldDelimiter = arg.slice(18) || null;
      } else if (arg === "-k" || arg === "--key") {
        const keyArg = args[++i];
        if (keyArg) {
          const keySpec = parseKeySpec(keyArg);
          if (keySpec) {
            options.keys.push(keySpec);
          }
        }
      } else if (arg.startsWith("-k")) {
        const keySpec = parseKeySpec(arg.slice(2));
        if (keySpec) {
          options.keys.push(keySpec);
        }
      } else if (arg.startsWith("--key=")) {
        const keySpec = parseKeySpec(arg.slice(6));
        if (keySpec) {
          options.keys.push(keySpec);
        }
      } else if (arg.startsWith("--")) {
        return unknownOption("sort", arg);
      } else if (arg.startsWith("-") && !arg.startsWith("--")) {
        let hasUnknown = false;
        for (const char of arg.slice(1)) {
          if (char === "r")
            options.reverse = true;
          else if (char === "n")
            options.numeric = true;
          else if (char === "u")
            options.unique = true;
          else if (char === "f")
            options.ignoreCase = true;
          else if (char === "h")
            options.humanNumeric = true;
          else if (char === "V")
            options.versionSort = true;
          else if (char === "d")
            options.dictionaryOrder = true;
          else if (char === "M")
            options.monthSort = true;
          else if (char === "b")
            options.ignoreLeadingBlanks = true;
          else if (char === "s")
            options.stable = true;
          else if (char === "c")
            options.checkOnly = true;
          else {
            hasUnknown = true;
            break;
          }
        }
        if (hasUnknown) {
          return unknownOption("sort", arg);
        }
      } else {
        files.push(arg);
      }
    }
    const readResult = await readAndConcat(ctx, files, { cmdName: "sort" });
    if (!readResult.ok)
      return readResult.error;
    const content = readResult.content;
    let lines = content.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    const comparator = createComparator(options);
    if (options.checkOnly) {
      const checkFile = files.length > 0 ? files[0] : "-";
      for (let i = 1; i < lines.length; i++) {
        if (comparator(lines[i - 1], lines[i]) > 0) {
          return {
            stdout: "",
            stderr: `sort: ${checkFile}:${i + 1}: disorder: ${lines[i]}
`,
            exitCode: 1
          };
        }
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    lines.sort(comparator);
    if (options.unique) {
      lines = filterUnique(lines, options);
    }
    const output = lines.length > 0 ? `${lines.join("\n")}
` : "";
    if (options.outputFile) {
      const outPath = ctx.fs.resolvePath(ctx.cwd, options.outputFile);
      await ctx.fs.writeFile(outPath, output);
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    return { stdout: output, stderr: "", exitCode: 0 };
  }
};
export {
  sortCommand
};
