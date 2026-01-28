import {
  ArithmeticError,
  BadSubstitutionError,
  BraceExpansionError,
  ExecutionLimitError,
  ExitError,
  GlobError,
  NounsetError
} from "./chunk-KRBYMBZY.js";
import {
  DEFAULT_BATCH_SIZE
} from "./chunk-PRIRMCRG.js";
import {
  __name
} from "./chunk-Y7IWVHJ4.js";

// dist/parser/arithmetic-primaries.js
function skipArithWhitespace(input, pos) {
  while (pos < input.length) {
    if (input[pos] === "\\" && input[pos + 1] === "\n") {
      pos += 2;
      continue;
    }
    if (/\s/.test(input[pos])) {
      pos++;
      continue;
    }
    break;
  }
  return pos;
}
__name(skipArithWhitespace, "skipArithWhitespace");
var ARITH_ASSIGN_OPS = [
  "=",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "<<=",
  ">>=",
  "&=",
  "|=",
  "^="
];
function parseArithNumber(str) {
  if (str.includes("#")) {
    const [baseStr, numStr] = str.split("#");
    const base = Number.parseInt(baseStr, 10);
    if (base < 2 || base > 64) {
      return Number.NaN;
    }
    if (base <= 36) {
      return Number.parseInt(numStr, base);
    }
    let result = 0;
    for (const ch of numStr) {
      let digitValue;
      if (/[0-9]/.test(ch)) {
        digitValue = ch.charCodeAt(0) - "0".charCodeAt(0);
      } else if (/[a-z]/.test(ch)) {
        digitValue = ch.charCodeAt(0) - "a".charCodeAt(0) + 10;
      } else if (/[A-Z]/.test(ch)) {
        digitValue = ch.charCodeAt(0) - "A".charCodeAt(0) + 36;
      } else if (ch === "@") {
        digitValue = 62;
      } else if (ch === "_") {
        digitValue = 63;
      } else {
        return Number.NaN;
      }
      if (digitValue >= base) {
        return Number.NaN;
      }
      result = result * base + digitValue;
    }
    return result;
  }
  if (str.startsWith("0x") || str.startsWith("0X")) {
    return Number.parseInt(str.slice(2), 16);
  }
  if (str.startsWith("0") && str.length > 1 && /^[0-9]+$/.test(str)) {
    if (/[89]/.test(str)) {
      return Number.NaN;
    }
    return Number.parseInt(str, 8);
  }
  return Number.parseInt(str, 10);
}
__name(parseArithNumber, "parseArithNumber");
function parseNestedArithmetic(parseArithExpr2, p, input, currentPos) {
  if (input.slice(currentPos, currentPos + 3) !== "$((") {
    return null;
  }
  let pos = currentPos + 3;
  let depth = 1;
  const exprStart = pos;
  while (pos < input.length - 1 && depth > 0) {
    if (input[pos] === "(" && input[pos + 1] === "(") {
      depth++;
      pos += 2;
    } else if (input[pos] === ")" && input[pos + 1] === ")") {
      depth--;
      if (depth > 0)
        pos += 2;
    } else {
      pos++;
    }
  }
  const nestedExpr = input.slice(exprStart, pos);
  const { expr } = parseArithExpr2(p, nestedExpr, 0);
  pos += 2;
  return { expr: { type: "ArithNested", expression: expr }, pos };
}
__name(parseNestedArithmetic, "parseNestedArithmetic");
function parseAnsiCQuoting(input, currentPos) {
  if (input.slice(currentPos, currentPos + 2) !== "$'") {
    return null;
  }
  let pos = currentPos + 2;
  let content = "";
  while (pos < input.length && input[pos] !== "'") {
    if (input[pos] === "\\" && pos + 1 < input.length) {
      const nextChar = input[pos + 1];
      switch (nextChar) {
        case "n":
          content += "\n";
          break;
        case "t":
          content += "	";
          break;
        case "r":
          content += "\r";
          break;
        case "\\":
          content += "\\";
          break;
        case "'":
          content += "'";
          break;
        default:
          content += nextChar;
      }
      pos += 2;
    } else {
      content += input[pos];
      pos++;
    }
  }
  if (input[pos] === "'")
    pos++;
  const numValue = Number.parseInt(content, 10);
  return {
    expr: {
      type: "ArithNumber",
      value: Number.isNaN(numValue) ? 0 : numValue
    },
    pos
  };
}
__name(parseAnsiCQuoting, "parseAnsiCQuoting");
function parseLocalizationQuoting(input, currentPos) {
  if (input.slice(currentPos, currentPos + 2) !== '$"') {
    return null;
  }
  let pos = currentPos + 2;
  let content = "";
  while (pos < input.length && input[pos] !== '"') {
    if (input[pos] === "\\" && pos + 1 < input.length) {
      content += input[pos + 1];
      pos += 2;
    } else {
      content += input[pos];
      pos++;
    }
  }
  if (input[pos] === '"')
    pos++;
  const numValue = Number.parseInt(content, 10);
  return {
    expr: {
      type: "ArithNumber",
      value: Number.isNaN(numValue) ? 0 : numValue
    },
    pos
  };
}
__name(parseLocalizationQuoting, "parseLocalizationQuoting");

// dist/parser/arithmetic-parser.js
function preprocessArithInput(input) {
  let result = "";
  let i = 0;
  while (i < input.length) {
    if (input[i] === '"') {
      i++;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === "\\" && i + 1 < input.length) {
          result += input[i + 1];
          i += 2;
        } else {
          result += input[i];
          i++;
        }
      }
      if (i < input.length)
        i++;
    } else {
      result += input[i];
      i++;
    }
  }
  return result;
}
__name(preprocessArithInput, "preprocessArithInput");
function parseArithmeticExpression(_p, input) {
  const preprocessed = preprocessArithInput(input);
  const { expr: expression, pos } = parseArithExpr(_p, preprocessed, 0);
  const finalPos = skipArithWhitespace(preprocessed, pos);
  if (finalPos < preprocessed.length) {
    const remaining = input.slice(finalPos).trim();
    if (remaining) {
      return {
        type: "ArithmeticExpression",
        originalText: input,
        expression: {
          type: "ArithSyntaxError",
          errorToken: remaining,
          message: `${remaining}: syntax error: invalid arithmetic operator (error token is "${remaining}")`
        }
      };
    }
  }
  return { type: "ArithmeticExpression", expression, originalText: input };
}
__name(parseArithmeticExpression, "parseArithmeticExpression");
function makeMissingOperandError(op, pos) {
  return {
    expr: {
      type: "ArithSyntaxError",
      errorToken: op,
      message: `syntax error: operand expected (error token is "${op}")`
    },
    pos
  };
}
__name(makeMissingOperandError, "makeMissingOperandError");
function isMissingOperand(input, pos) {
  return skipArithWhitespace(input, pos) >= input.length;
}
__name(isMissingOperand, "isMissingOperand");
function parseArithExpr(p, input, pos) {
  return parseArithComma(p, input, pos);
}
__name(parseArithExpr, "parseArithExpr");
function parseArithComma(p, input, pos) {
  let { expr: left, pos: currentPos } = parseArithTernary(p, input, pos);
  currentPos = skipArithWhitespace(input, currentPos);
  while (input[currentPos] === ",") {
    const op = ",";
    currentPos++;
    if (isMissingOperand(input, currentPos)) {
      return makeMissingOperandError(op, currentPos);
    }
    const { expr: right, pos: p2 } = parseArithTernary(p, input, currentPos);
    left = { type: "ArithBinary", operator: ",", left, right };
    currentPos = skipArithWhitespace(input, p2);
  }
  return { expr: left, pos: currentPos };
}
__name(parseArithComma, "parseArithComma");
function parseArithTernary(p, input, pos) {
  let { expr: condition, pos: currentPos } = parseArithLogicalOr(p, input, pos);
  currentPos = skipArithWhitespace(input, currentPos);
  if (input[currentPos] === "?") {
    currentPos++;
    const { expr: consequent, pos: p2 } = parseArithExpr(p, input, currentPos);
    currentPos = skipArithWhitespace(input, p2);
    if (input[currentPos] === ":") {
      currentPos++;
      const { expr: alternate, pos: p3 } = parseArithExpr(p, input, currentPos);
      return {
        expr: { type: "ArithTernary", condition, consequent, alternate },
        pos: p3
      };
    }
  }
  return { expr: condition, pos: currentPos };
}
__name(parseArithTernary, "parseArithTernary");
function parseArithLogicalOr(p, input, pos) {
  let { expr: left, pos: currentPos } = parseArithLogicalAnd(p, input, pos);
  while (true) {
    currentPos = skipArithWhitespace(input, currentPos);
    if (input.slice(currentPos, currentPos + 2) === "||") {
      const op = "||";
      currentPos += 2;
      if (isMissingOperand(input, currentPos)) {
        return makeMissingOperandError(op, currentPos);
      }
      const { expr: right, pos: p2 } = parseArithLogicalAnd(p, input, currentPos);
      left = { type: "ArithBinary", operator: "||", left, right };
      currentPos = p2;
    } else {
      break;
    }
  }
  return { expr: left, pos: currentPos };
}
__name(parseArithLogicalOr, "parseArithLogicalOr");
function parseArithLogicalAnd(p, input, pos) {
  let { expr: left, pos: currentPos } = parseArithBitwiseOr(p, input, pos);
  while (true) {
    currentPos = skipArithWhitespace(input, currentPos);
    if (input.slice(currentPos, currentPos + 2) === "&&") {
      const op = "&&";
      currentPos += 2;
      if (isMissingOperand(input, currentPos)) {
        return makeMissingOperandError(op, currentPos);
      }
      const { expr: right, pos: p2 } = parseArithBitwiseOr(p, input, currentPos);
      left = { type: "ArithBinary", operator: "&&", left, right };
      currentPos = p2;
    } else {
      break;
    }
  }
  return { expr: left, pos: currentPos };
}
__name(parseArithLogicalAnd, "parseArithLogicalAnd");
function parseArithBitwiseOr(p, input, pos) {
  let { expr: left, pos: currentPos } = parseArithBitwiseXor(p, input, pos);
  while (true) {
    currentPos = skipArithWhitespace(input, currentPos);
    if (input[currentPos] === "|" && input[currentPos + 1] !== "|") {
      const op = "|";
      currentPos++;
      if (isMissingOperand(input, currentPos)) {
        return makeMissingOperandError(op, currentPos);
      }
      const { expr: right, pos: p2 } = parseArithBitwiseXor(p, input, currentPos);
      left = { type: "ArithBinary", operator: "|", left, right };
      currentPos = p2;
    } else {
      break;
    }
  }
  return { expr: left, pos: currentPos };
}
__name(parseArithBitwiseOr, "parseArithBitwiseOr");
function parseArithBitwiseXor(p, input, pos) {
  let { expr: left, pos: currentPos } = parseArithBitwiseAnd(p, input, pos);
  while (true) {
    currentPos = skipArithWhitespace(input, currentPos);
    if (input[currentPos] === "^") {
      const op = "^";
      currentPos++;
      if (isMissingOperand(input, currentPos)) {
        return makeMissingOperandError(op, currentPos);
      }
      const { expr: right, pos: p2 } = parseArithBitwiseAnd(p, input, currentPos);
      left = { type: "ArithBinary", operator: "^", left, right };
      currentPos = p2;
    } else {
      break;
    }
  }
  return { expr: left, pos: currentPos };
}
__name(parseArithBitwiseXor, "parseArithBitwiseXor");
function parseArithBitwiseAnd(p, input, pos) {
  let { expr: left, pos: currentPos } = parseArithEquality(p, input, pos);
  while (true) {
    currentPos = skipArithWhitespace(input, currentPos);
    if (input[currentPos] === "&" && input[currentPos + 1] !== "&") {
      const op = "&";
      currentPos++;
      if (isMissingOperand(input, currentPos)) {
        return makeMissingOperandError(op, currentPos);
      }
      const { expr: right, pos: p2 } = parseArithEquality(p, input, currentPos);
      left = { type: "ArithBinary", operator: "&", left, right };
      currentPos = p2;
    } else {
      break;
    }
  }
  return { expr: left, pos: currentPos };
}
__name(parseArithBitwiseAnd, "parseArithBitwiseAnd");
function parseArithEquality(p, input, pos) {
  let { expr: left, pos: currentPos } = parseArithRelational(p, input, pos);
  while (true) {
    currentPos = skipArithWhitespace(input, currentPos);
    if (input.slice(currentPos, currentPos + 2) === "==" || input.slice(currentPos, currentPos + 2) === "!=") {
      const op = input.slice(currentPos, currentPos + 2);
      currentPos += 2;
      if (isMissingOperand(input, currentPos)) {
        return makeMissingOperandError(op, currentPos);
      }
      const { expr: right, pos: p2 } = parseArithRelational(p, input, currentPos);
      left = { type: "ArithBinary", operator: op, left, right };
      currentPos = p2;
    } else {
      break;
    }
  }
  return { expr: left, pos: currentPos };
}
__name(parseArithEquality, "parseArithEquality");
function parseArithRelational(p, input, pos) {
  let { expr: left, pos: currentPos } = parseArithShift(p, input, pos);
  while (true) {
    currentPos = skipArithWhitespace(input, currentPos);
    if (input.slice(currentPos, currentPos + 2) === "<=" || input.slice(currentPos, currentPos + 2) === ">=") {
      const op = input.slice(currentPos, currentPos + 2);
      currentPos += 2;
      if (isMissingOperand(input, currentPos)) {
        return makeMissingOperandError(op, currentPos);
      }
      const { expr: right, pos: p2 } = parseArithShift(p, input, currentPos);
      left = { type: "ArithBinary", operator: op, left, right };
      currentPos = p2;
    } else if (input[currentPos] === "<" || input[currentPos] === ">") {
      const op = input[currentPos];
      currentPos++;
      if (isMissingOperand(input, currentPos)) {
        return makeMissingOperandError(op, currentPos);
      }
      const { expr: right, pos: p2 } = parseArithShift(p, input, currentPos);
      left = { type: "ArithBinary", operator: op, left, right };
      currentPos = p2;
    } else {
      break;
    }
  }
  return { expr: left, pos: currentPos };
}
__name(parseArithRelational, "parseArithRelational");
function parseArithShift(p, input, pos) {
  let { expr: left, pos: currentPos } = parseArithAdditive(p, input, pos);
  while (true) {
    currentPos = skipArithWhitespace(input, currentPos);
    if (input.slice(currentPos, currentPos + 2) === "<<" || input.slice(currentPos, currentPos + 2) === ">>") {
      const op = input.slice(currentPos, currentPos + 2);
      currentPos += 2;
      if (isMissingOperand(input, currentPos)) {
        return makeMissingOperandError(op, currentPos);
      }
      const { expr: right, pos: p2 } = parseArithAdditive(p, input, currentPos);
      left = { type: "ArithBinary", operator: op, left, right };
      currentPos = p2;
    } else {
      break;
    }
  }
  return { expr: left, pos: currentPos };
}
__name(parseArithShift, "parseArithShift");
function parseArithAdditive(p, input, pos) {
  let { expr: left, pos: currentPos } = parseArithMultiplicative(p, input, pos);
  while (true) {
    currentPos = skipArithWhitespace(input, currentPos);
    if ((input[currentPos] === "+" || input[currentPos] === "-") && input[currentPos + 1] !== input[currentPos]) {
      const op = input[currentPos];
      currentPos++;
      if (isMissingOperand(input, currentPos)) {
        return makeMissingOperandError(op, currentPos);
      }
      const { expr: right, pos: p2 } = parseArithMultiplicative(p, input, currentPos);
      left = { type: "ArithBinary", operator: op, left, right };
      currentPos = p2;
    } else {
      break;
    }
  }
  return { expr: left, pos: currentPos };
}
__name(parseArithAdditive, "parseArithAdditive");
function parseArithMultiplicative(p, input, pos) {
  let { expr: left, pos: currentPos } = parseArithPower(p, input, pos);
  while (true) {
    currentPos = skipArithWhitespace(input, currentPos);
    if (input[currentPos] === "*" && input[currentPos + 1] !== "*") {
      const op = "*";
      currentPos++;
      if (isMissingOperand(input, currentPos)) {
        return makeMissingOperandError(op, currentPos);
      }
      const { expr: right, pos: p2 } = parseArithPower(p, input, currentPos);
      left = { type: "ArithBinary", operator: "*", left, right };
      currentPos = p2;
    } else if (input[currentPos] === "/" || input[currentPos] === "%") {
      const op = input[currentPos];
      currentPos++;
      if (isMissingOperand(input, currentPos)) {
        return makeMissingOperandError(op, currentPos);
      }
      const { expr: right, pos: p2 } = parseArithPower(p, input, currentPos);
      left = { type: "ArithBinary", operator: op, left, right };
      currentPos = p2;
    } else {
      break;
    }
  }
  return { expr: left, pos: currentPos };
}
__name(parseArithMultiplicative, "parseArithMultiplicative");
function parseArithPower(p, input, pos) {
  const { expr: base, pos: currentPos } = parseArithUnary(p, input, pos);
  let p2 = skipArithWhitespace(input, currentPos);
  if (input.slice(p2, p2 + 2) === "**") {
    const op = "**";
    p2 += 2;
    if (isMissingOperand(input, p2)) {
      return makeMissingOperandError(op, p2);
    }
    const { expr: exponent, pos: p3 } = parseArithPower(p, input, p2);
    return {
      expr: {
        type: "ArithBinary",
        operator: "**",
        left: base,
        right: exponent
      },
      pos: p3
    };
  }
  return { expr: base, pos: currentPos };
}
__name(parseArithPower, "parseArithPower");
function parseArithUnary(p, input, pos) {
  let currentPos = skipArithWhitespace(input, pos);
  if (input.slice(currentPos, currentPos + 2) === "++" || input.slice(currentPos, currentPos + 2) === "--") {
    const op = input.slice(currentPos, currentPos + 2);
    currentPos += 2;
    const { expr: operand, pos: p2 } = parseArithUnary(p, input, currentPos);
    return {
      expr: { type: "ArithUnary", operator: op, operand, prefix: true },
      pos: p2
    };
  }
  if (input[currentPos] === "+" || input[currentPos] === "-" || input[currentPos] === "!" || input[currentPos] === "~") {
    const op = input[currentPos];
    currentPos++;
    const { expr: operand, pos: p2 } = parseArithUnary(p, input, currentPos);
    return {
      expr: { type: "ArithUnary", operator: op, operand, prefix: true },
      pos: p2
    };
  }
  return parseArithPostfix(p, input, currentPos);
}
__name(parseArithUnary, "parseArithUnary");
function canStartConcatPrimary(input, pos) {
  const c = input[pos];
  if (c === "$")
    return true;
  if (c === "`")
    return true;
  return false;
}
__name(canStartConcatPrimary, "canStartConcatPrimary");
function parseArithPostfix(p, input, pos) {
  let { expr, pos: currentPos } = parseArithPrimary(p, input, pos, false);
  const parts = [expr];
  while (canStartConcatPrimary(input, currentPos)) {
    const { expr: nextExpr, pos: nextPos } = parseArithPrimary(p, input, currentPos, true);
    parts.push(nextExpr);
    currentPos = nextPos;
  }
  if (parts.length > 1) {
    expr = { type: "ArithConcat", parts };
  }
  let subscript;
  if (input[currentPos] === "[" && expr.type === "ArithConcat") {
    currentPos++;
    const { expr: indexExpr, pos: p2 } = parseArithExpr(p, input, currentPos);
    subscript = indexExpr;
    currentPos = p2;
    if (input[currentPos] === "]")
      currentPos++;
  }
  if (subscript && expr.type === "ArithConcat") {
    expr = { type: "ArithDynamicElement", nameExpr: expr, subscript };
    subscript = void 0;
  }
  currentPos = skipArithWhitespace(input, currentPos);
  if (expr.type === "ArithConcat" || expr.type === "ArithVariable" || expr.type === "ArithDynamicElement") {
    for (const op of ARITH_ASSIGN_OPS) {
      if (input.slice(currentPos, currentPos + op.length) === op && input.slice(currentPos, currentPos + op.length + 1) !== "==") {
        currentPos += op.length;
        const { expr: value, pos: p2 } = parseArithTernary(p, input, currentPos);
        if (expr.type === "ArithDynamicElement") {
          return {
            expr: {
              type: "ArithDynamicAssignment",
              operator: op,
              target: expr.nameExpr,
              subscript: expr.subscript,
              value
            },
            pos: p2
          };
        }
        if (expr.type === "ArithConcat") {
          return {
            expr: {
              type: "ArithDynamicAssignment",
              operator: op,
              target: expr,
              value
            },
            pos: p2
          };
        }
        return {
          expr: {
            type: "ArithAssignment",
            operator: op,
            variable: expr.name,
            value
          },
          pos: p2
        };
      }
    }
  }
  if (input.slice(currentPos, currentPos + 2) === "++" || input.slice(currentPos, currentPos + 2) === "--") {
    const op = input.slice(currentPos, currentPos + 2);
    currentPos += 2;
    return {
      expr: {
        type: "ArithUnary",
        operator: op,
        operand: expr,
        prefix: false
      },
      pos: currentPos
    };
  }
  return { expr, pos: currentPos };
}
__name(parseArithPostfix, "parseArithPostfix");
function parseArithPrimary(p, input, pos, skipAssignment = false) {
  let currentPos = skipArithWhitespace(input, pos);
  const nestedResult = parseNestedArithmetic(parseArithExpr, p, input, currentPos);
  if (nestedResult)
    return nestedResult;
  const ansiResult = parseAnsiCQuoting(input, currentPos);
  if (ansiResult)
    return ansiResult;
  const locResult = parseLocalizationQuoting(input, currentPos);
  if (locResult)
    return locResult;
  if (input.slice(currentPos, currentPos + 2) === "$(" && input[currentPos + 2] !== "(") {
    currentPos += 2;
    let depth = 1;
    const cmdStart = currentPos;
    while (currentPos < input.length && depth > 0) {
      if (input[currentPos] === "(")
        depth++;
      else if (input[currentPos] === ")")
        depth--;
      if (depth > 0)
        currentPos++;
    }
    const cmd = input.slice(cmdStart, currentPos);
    currentPos++;
    return {
      expr: { type: "ArithCommandSubst", command: cmd },
      pos: currentPos
    };
  }
  if (input[currentPos] === "`") {
    currentPos++;
    const cmdStart = currentPos;
    while (currentPos < input.length && input[currentPos] !== "`") {
      currentPos++;
    }
    const cmd = input.slice(cmdStart, currentPos);
    if (input[currentPos] === "`")
      currentPos++;
    return {
      expr: { type: "ArithCommandSubst", command: cmd },
      pos: currentPos
    };
  }
  if (input[currentPos] === "(") {
    currentPos++;
    const { expr, pos: p2 } = parseArithExpr(p, input, currentPos);
    currentPos = skipArithWhitespace(input, p2);
    if (input[currentPos] === ")")
      currentPos++;
    return { expr: { type: "ArithGroup", expression: expr }, pos: currentPos };
  }
  if (input[currentPos] === "'") {
    currentPos++;
    let content = "";
    while (currentPos < input.length && input[currentPos] !== "'") {
      content += input[currentPos];
      currentPos++;
    }
    if (input[currentPos] === "'")
      currentPos++;
    const numValue = Number.parseInt(content, 10);
    return {
      expr: {
        type: "ArithSingleQuote",
        content,
        value: Number.isNaN(numValue) ? 0 : numValue
      },
      pos: currentPos
    };
  }
  if (input[currentPos] === '"') {
    currentPos++;
    let content = "";
    while (currentPos < input.length && input[currentPos] !== '"') {
      if (input[currentPos] === "\\" && currentPos + 1 < input.length) {
        content += input[currentPos + 1];
        currentPos += 2;
      } else {
        content += input[currentPos];
        currentPos++;
      }
    }
    if (input[currentPos] === '"')
      currentPos++;
    const trimmed = content.trim();
    if (!trimmed) {
      return { expr: { type: "ArithNumber", value: 0 }, pos: currentPos };
    }
    const { expr } = parseArithExpr(p, trimmed, 0);
    return { expr, pos: currentPos };
  }
  if (/[0-9]/.test(input[currentPos])) {
    let numStr = "";
    let seenHash = false;
    let isHex = false;
    while (currentPos < input.length) {
      const ch = input[currentPos];
      if (seenHash) {
        if (/[0-9a-zA-Z@_]/.test(ch)) {
          numStr += ch;
          currentPos++;
        } else {
          break;
        }
      } else if (ch === "#") {
        seenHash = true;
        numStr += ch;
        currentPos++;
      } else if (numStr === "0" && (ch === "x" || ch === "X") && currentPos + 1 < input.length && /[0-9a-fA-F]/.test(input[currentPos + 1])) {
        isHex = true;
        numStr += ch;
        currentPos++;
      } else if (isHex && /[0-9a-fA-F]/.test(ch)) {
        numStr += ch;
        currentPos++;
      } else if (!isHex && /[0-9]/.test(ch)) {
        numStr += ch;
        currentPos++;
      } else {
        break;
      }
    }
    if (currentPos < input.length && /[a-zA-Z_]/.test(input[currentPos])) {
      let invalidToken = numStr;
      while (currentPos < input.length && /[a-zA-Z0-9_]/.test(input[currentPos])) {
        invalidToken += input[currentPos];
        currentPos++;
      }
      return {
        expr: {
          type: "ArithSyntaxError",
          errorToken: invalidToken,
          message: `${invalidToken}: value too great for base (error token is "${invalidToken}")`
        },
        pos: currentPos
      };
    }
    if (input[currentPos] === "." && /[0-9]/.test(input[currentPos + 1])) {
      throw new ArithmeticError(`${numStr}.${input[currentPos + 1]}...: syntax error: invalid arithmetic operator`);
    }
    if (input[currentPos] === "[") {
      const errorToken = input.slice(currentPos).trim();
      return {
        expr: {
          type: "ArithNumberSubscript",
          number: numStr,
          errorToken
        },
        pos: input.length
        // Consume the rest
      };
    }
    const value = parseArithNumber(numStr);
    return { expr: { type: "ArithNumber", value }, pos: currentPos };
  }
  if (input[currentPos] === "$" && input[currentPos + 1] === "{") {
    const braceStart = currentPos + 2;
    let braceDepth = 1;
    let i = braceStart;
    while (i < input.length && braceDepth > 0) {
      if (input[i] === "{")
        braceDepth++;
      else if (input[i] === "}")
        braceDepth--;
      if (braceDepth > 0)
        i++;
    }
    const content = input.slice(braceStart, i);
    const afterBrace = i + 1;
    if (input[afterBrace] === "#") {
      let valueEnd = afterBrace + 1;
      while (valueEnd < input.length && /[0-9a-zA-Z@_]/.test(input[valueEnd])) {
        valueEnd++;
      }
      const valueStr = input.slice(afterBrace + 1, valueEnd);
      return {
        expr: { type: "ArithDynamicBase", baseExpr: content, value: valueStr },
        pos: valueEnd
      };
    }
    if (/[0-9]/.test(input[afterBrace]) || input[afterBrace] === "x" || input[afterBrace] === "X") {
      let numEnd = afterBrace;
      if (input[afterBrace] === "x" || input[afterBrace] === "X") {
        numEnd++;
        while (numEnd < input.length && /[0-9a-fA-F]/.test(input[numEnd])) {
          numEnd++;
        }
      } else {
        while (numEnd < input.length && /[0-9]/.test(input[numEnd])) {
          numEnd++;
        }
      }
      const suffix = input.slice(afterBrace, numEnd);
      return {
        expr: { type: "ArithDynamicNumber", prefix: content, suffix },
        pos: numEnd
      };
    }
    currentPos = afterBrace;
    return { expr: { type: "ArithBracedExpansion", content }, pos: currentPos };
  }
  if (input[currentPos] === "$" && currentPos + 1 < input.length && /[0-9]/.test(input[currentPos + 1])) {
    currentPos++;
    let name = "";
    while (currentPos < input.length && /[0-9]/.test(input[currentPos])) {
      name += input[currentPos];
      currentPos++;
    }
    return {
      expr: { type: "ArithVariable", name, hasDollarPrefix: true },
      pos: currentPos
    };
  }
  if (input[currentPos] === "$" && currentPos + 1 < input.length && /[*@#?\-!$]/.test(input[currentPos + 1])) {
    const name = input[currentPos + 1];
    currentPos += 2;
    return { expr: { type: "ArithSpecialVar", name }, pos: currentPos };
  }
  let hasDollarPrefix = false;
  if (input[currentPos] === "$" && currentPos + 1 < input.length && /[a-zA-Z_]/.test(input[currentPos + 1])) {
    hasDollarPrefix = true;
    currentPos++;
  }
  if (currentPos < input.length && /[a-zA-Z_]/.test(input[currentPos])) {
    let name = "";
    while (currentPos < input.length && /[a-zA-Z0-9_]/.test(input[currentPos])) {
      name += input[currentPos];
      currentPos++;
    }
    if (input[currentPos] === "[" && !skipAssignment) {
      currentPos++;
      let stringKey;
      if (input[currentPos] === "'" || input[currentPos] === '"') {
        const quote = input[currentPos];
        currentPos++;
        stringKey = "";
        while (currentPos < input.length && input[currentPos] !== quote) {
          stringKey += input[currentPos];
          currentPos++;
        }
        if (input[currentPos] === quote)
          currentPos++;
        currentPos = skipArithWhitespace(input, currentPos);
        if (input[currentPos] === "]")
          currentPos++;
      }
      let indexExpr;
      if (stringKey === void 0) {
        const { expr, pos: p2 } = parseArithExpr(p, input, currentPos);
        indexExpr = expr;
        currentPos = p2;
        if (input[currentPos] === "]")
          currentPos++;
      }
      currentPos = skipArithWhitespace(input, currentPos);
      if (input[currentPos] === "[" && indexExpr) {
        return {
          expr: { type: "ArithDoubleSubscript", array: name, index: indexExpr },
          pos: currentPos
        };
      }
      if (!skipAssignment) {
        for (const op of ARITH_ASSIGN_OPS) {
          if (input.slice(currentPos, currentPos + op.length) === op && input.slice(currentPos, currentPos + op.length + 1) !== "==") {
            currentPos += op.length;
            const { expr: value, pos: p2 } = parseArithTernary(p, input, currentPos);
            return {
              expr: {
                type: "ArithAssignment",
                operator: op,
                variable: name,
                subscript: indexExpr,
                stringKey,
                value
              },
              pos: p2
            };
          }
        }
      }
      return {
        expr: {
          type: "ArithArrayElement",
          array: name,
          index: indexExpr,
          stringKey
        },
        pos: currentPos
      };
    }
    currentPos = skipArithWhitespace(input, currentPos);
    if (!skipAssignment) {
      for (const op of ARITH_ASSIGN_OPS) {
        if (input.slice(currentPos, currentPos + op.length) === op && input.slice(currentPos, currentPos + op.length + 1) !== "==") {
          currentPos += op.length;
          const { expr: value, pos: p2 } = parseArithTernary(p, input, currentPos);
          return {
            expr: {
              type: "ArithAssignment",
              operator: op,
              variable: name,
              value
            },
            pos: p2
          };
        }
      }
    }
    return {
      expr: { type: "ArithVariable", name, hasDollarPrefix },
      pos: currentPos
    };
  }
  if (input[currentPos] === "#") {
    let errorEnd = currentPos + 1;
    while (errorEnd < input.length && input[errorEnd] !== "\n") {
      errorEnd++;
    }
    const errorToken = input.slice(currentPos, errorEnd).trim() || "#";
    return {
      expr: {
        type: "ArithSyntaxError",
        errorToken,
        message: `${errorToken}: syntax error: invalid arithmetic operator (error token is "${errorToken}")`
      },
      pos: input.length
      // Consume the rest
    };
  }
  return { expr: { type: "ArithNumber", value: 0 }, pos: currentPos };
}
__name(parseArithPrimary, "parseArithPrimary");

// dist/ast/types.js
var AST = {
  script(statements) {
    return { type: "Script", statements };
  },
  statement(pipelines, operators = [], background = false, deferredError, sourceText) {
    const node = {
      type: "Statement",
      pipelines,
      operators,
      background
    };
    if (deferredError) {
      node.deferredError = deferredError;
    }
    if (sourceText !== void 0) {
      node.sourceText = sourceText;
    }
    return node;
  },
  pipeline(commands, negated = false, timed = false, timePosix = false, pipeStderr) {
    return {
      type: "Pipeline",
      commands,
      negated,
      timed,
      timePosix,
      pipeStderr
    };
  },
  simpleCommand(name, args = [], assignments = [], redirections = []) {
    return { type: "SimpleCommand", name, args, assignments, redirections };
  },
  word(parts) {
    return { type: "Word", parts };
  },
  literal(value) {
    return { type: "Literal", value };
  },
  singleQuoted(value) {
    return { type: "SingleQuoted", value };
  },
  doubleQuoted(parts) {
    return { type: "DoubleQuoted", parts };
  },
  escaped(value) {
    return { type: "Escaped", value };
  },
  parameterExpansion(parameter, operation = null) {
    return { type: "ParameterExpansion", parameter, operation };
  },
  commandSubstitution(body, legacy = false) {
    return { type: "CommandSubstitution", body, legacy };
  },
  arithmeticExpansion(expression) {
    return { type: "ArithmeticExpansion", expression };
  },
  assignment(name, value, append = false, array = null) {
    return { type: "Assignment", name, value, append, array };
  },
  redirection(operator, target, fd = null, fdVariable) {
    const node = { type: "Redirection", fd, operator, target };
    if (fdVariable) {
      node.fdVariable = fdVariable;
    }
    return node;
  },
  hereDoc(delimiter, content, stripTabs = false, quoted = false) {
    return { type: "HereDoc", delimiter, content, stripTabs, quoted };
  },
  ifNode(clauses, elseBody = null, redirections = []) {
    return { type: "If", clauses, elseBody, redirections };
  },
  forNode(variable, words, body, redirections = []) {
    return { type: "For", variable, words, body, redirections };
  },
  whileNode(condition, body, redirections = []) {
    return { type: "While", condition, body, redirections };
  },
  untilNode(condition, body, redirections = []) {
    return { type: "Until", condition, body, redirections };
  },
  caseNode(word, items, redirections = []) {
    return { type: "Case", word, items, redirections };
  },
  caseItem(patterns, body, terminator = ";;") {
    return { type: "CaseItem", patterns, body, terminator };
  },
  subshell(body, redirections = []) {
    return { type: "Subshell", body, redirections };
  },
  group(body, redirections = []) {
    return { type: "Group", body, redirections };
  },
  functionDef(name, body, redirections = [], sourceFile) {
    return { type: "FunctionDef", name, body, redirections, sourceFile };
  },
  conditionalCommand(expression, redirections = [], line) {
    return { type: "ConditionalCommand", expression, redirections, line };
  },
  arithmeticCommand(expression, redirections = [], line) {
    return { type: "ArithmeticCommand", expression, redirections, line };
  }
};

// dist/parser/lexer.js
var TokenType;
(function(TokenType2) {
  TokenType2["EOF"] = "EOF";
  TokenType2["NEWLINE"] = "NEWLINE";
  TokenType2["SEMICOLON"] = "SEMICOLON";
  TokenType2["AMP"] = "AMP";
  TokenType2["PIPE"] = "PIPE";
  TokenType2["PIPE_AMP"] = "PIPE_AMP";
  TokenType2["AND_AND"] = "AND_AND";
  TokenType2["OR_OR"] = "OR_OR";
  TokenType2["BANG"] = "BANG";
  TokenType2["LESS"] = "LESS";
  TokenType2["GREAT"] = "GREAT";
  TokenType2["DLESS"] = "DLESS";
  TokenType2["DGREAT"] = "DGREAT";
  TokenType2["LESSAND"] = "LESSAND";
  TokenType2["GREATAND"] = "GREATAND";
  TokenType2["LESSGREAT"] = "LESSGREAT";
  TokenType2["DLESSDASH"] = "DLESSDASH";
  TokenType2["CLOBBER"] = "CLOBBER";
  TokenType2["TLESS"] = "TLESS";
  TokenType2["AND_GREAT"] = "AND_GREAT";
  TokenType2["AND_DGREAT"] = "AND_DGREAT";
  TokenType2["LPAREN"] = "LPAREN";
  TokenType2["RPAREN"] = "RPAREN";
  TokenType2["LBRACE"] = "LBRACE";
  TokenType2["RBRACE"] = "RBRACE";
  TokenType2["DSEMI"] = "DSEMI";
  TokenType2["SEMI_AND"] = "SEMI_AND";
  TokenType2["SEMI_SEMI_AND"] = "SEMI_SEMI_AND";
  TokenType2["DBRACK_START"] = "DBRACK_START";
  TokenType2["DBRACK_END"] = "DBRACK_END";
  TokenType2["DPAREN_START"] = "DPAREN_START";
  TokenType2["DPAREN_END"] = "DPAREN_END";
  TokenType2["IF"] = "IF";
  TokenType2["THEN"] = "THEN";
  TokenType2["ELSE"] = "ELSE";
  TokenType2["ELIF"] = "ELIF";
  TokenType2["FI"] = "FI";
  TokenType2["FOR"] = "FOR";
  TokenType2["WHILE"] = "WHILE";
  TokenType2["UNTIL"] = "UNTIL";
  TokenType2["DO"] = "DO";
  TokenType2["DONE"] = "DONE";
  TokenType2["CASE"] = "CASE";
  TokenType2["ESAC"] = "ESAC";
  TokenType2["IN"] = "IN";
  TokenType2["FUNCTION"] = "FUNCTION";
  TokenType2["SELECT"] = "SELECT";
  TokenType2["TIME"] = "TIME";
  TokenType2["COPROC"] = "COPROC";
  TokenType2["WORD"] = "WORD";
  TokenType2["NAME"] = "NAME";
  TokenType2["NUMBER"] = "NUMBER";
  TokenType2["ASSIGNMENT_WORD"] = "ASSIGNMENT_WORD";
  TokenType2["FD_VARIABLE"] = "FD_VARIABLE";
  TokenType2["COMMENT"] = "COMMENT";
  TokenType2["HEREDOC_CONTENT"] = "HEREDOC_CONTENT";
})(TokenType || (TokenType = {}));
var LexerError = class extends Error {
  static {
    __name(this, "LexerError");
  }
  line;
  column;
  constructor(message, line, column) {
    super(`line ${line}: ${message}`);
    this.line = line;
    this.column = column;
    this.name = "LexerError";
  }
};
var RESERVED_WORDS = {
  if: TokenType.IF,
  // biome-ignore lint/suspicious/noThenProperty: "then" is a bash reserved word
  then: TokenType.THEN,
  else: TokenType.ELSE,
  elif: TokenType.ELIF,
  fi: TokenType.FI,
  for: TokenType.FOR,
  while: TokenType.WHILE,
  until: TokenType.UNTIL,
  do: TokenType.DO,
  done: TokenType.DONE,
  case: TokenType.CASE,
  esac: TokenType.ESAC,
  in: TokenType.IN,
  function: TokenType.FUNCTION,
  select: TokenType.SELECT,
  time: TokenType.TIME,
  coproc: TokenType.COPROC
};
function isValidAssignmentLHS(str) {
  const match = str.match(/^[a-zA-Z_][a-zA-Z0-9_]*/);
  if (!match)
    return false;
  const afterName = str.slice(match[0].length);
  if (afterName === "" || afterName === "+")
    return true;
  if (afterName[0] === "[") {
    let depth = 0;
    let i = 0;
    for (; i < afterName.length; i++) {
      if (afterName[i] === "[")
        depth++;
      else if (afterName[i] === "]") {
        depth--;
        if (depth === 0)
          break;
      }
    }
    if (depth !== 0 || i >= afterName.length)
      return false;
    const afterBracket = afterName.slice(i + 1);
    return afterBracket === "" || afterBracket === "+";
  }
  return false;
}
__name(isValidAssignmentLHS, "isValidAssignmentLHS");
function findAssignmentEq(str) {
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === "[") {
      depth++;
    } else if (c === "]") {
      depth--;
    } else if (depth === 0 && c === "=") {
      return i;
    } else if (depth === 0 && c === "+" && str[i + 1] === "=") {
      return i + 1;
    }
  }
  return -1;
}
__name(findAssignmentEq, "findAssignmentEq");
var THREE_CHAR_OPS = [
  [";", ";", "&", TokenType.SEMI_SEMI_AND],
  ["<", "<", "<", TokenType.TLESS],
  ["&", ">", ">", TokenType.AND_DGREAT]
  // Note: <<- has special handling for heredoc, not included here
];
var TWO_CHAR_OPS = [
  ["[", "[", TokenType.DBRACK_START],
  ["]", "]", TokenType.DBRACK_END],
  ["(", "(", TokenType.DPAREN_START],
  [")", ")", TokenType.DPAREN_END],
  ["&", "&", TokenType.AND_AND],
  ["|", "|", TokenType.OR_OR],
  [";", ";", TokenType.DSEMI],
  [";", "&", TokenType.SEMI_AND],
  ["|", "&", TokenType.PIPE_AMP],
  [">", ">", TokenType.DGREAT],
  ["<", "&", TokenType.LESSAND],
  [">", "&", TokenType.GREATAND],
  ["<", ">", TokenType.LESSGREAT],
  [">", "|", TokenType.CLOBBER],
  ["&", ">", TokenType.AND_GREAT]
];
var SINGLE_CHAR_OPS = {
  "|": TokenType.PIPE,
  "&": TokenType.AMP,
  ";": TokenType.SEMICOLON,
  "(": TokenType.LPAREN,
  ")": TokenType.RPAREN,
  "<": TokenType.LESS,
  ">": TokenType.GREAT
};
function isValidName(s) {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s);
}
__name(isValidName, "isValidName");
function isWordBoundary(char) {
  return char === " " || char === "	" || char === "\n" || char === ";" || char === "&" || char === "|" || char === "(" || char === ")" || char === "<" || char === ">";
}
__name(isWordBoundary, "isWordBoundary");
var Lexer = class {
  static {
    __name(this, "Lexer");
  }
  input;
  pos = 0;
  line = 1;
  column = 1;
  tokens = [];
  pendingHeredocs = [];
  // Track depth inside (( )) for C-style for loops and arithmetic commands
  // When > 0, we're inside (( )) and need to track nested parens
  dparenDepth = 0;
  constructor(input) {
    this.input = input;
  }
  /**
   * Tokenize the entire input
   */
  tokenize() {
    const input = this.input;
    const len = input.length;
    const tokens = this.tokens;
    const pendingHeredocs = this.pendingHeredocs;
    while (this.pos < len) {
      if (pendingHeredocs.length > 0 && tokens.length > 0 && tokens[tokens.length - 1].type === TokenType.NEWLINE) {
        this.readHeredocContent();
        continue;
      }
      this.skipWhitespace();
      if (this.pos >= len)
        break;
      const token = this.nextToken();
      if (token) {
        tokens.push(token);
      }
    }
    tokens.push({
      type: TokenType.EOF,
      value: "",
      start: this.pos,
      end: this.pos,
      line: this.line,
      column: this.column
    });
    return tokens;
  }
  skipWhitespace() {
    const input = this.input;
    const len = input.length;
    let pos = this.pos;
    let col = this.column;
    let ln = this.line;
    while (pos < len) {
      const char = input[pos];
      if (char === " " || char === "	") {
        pos++;
        col++;
      } else if (char === "\\" && input[pos + 1] === "\n") {
        pos += 2;
        ln++;
        col = 1;
      } else {
        break;
      }
    }
    this.pos = pos;
    this.column = col;
    this.line = ln;
  }
  nextToken() {
    const input = this.input;
    const pos = this.pos;
    const startLine = this.line;
    const startColumn = this.column;
    const c0 = input[pos];
    const c1 = input[pos + 1];
    const c2 = input[pos + 2];
    if (c0 === "#" && this.dparenDepth === 0) {
      return this.readComment(pos, startLine, startColumn);
    }
    if (c0 === "\n") {
      this.pos = pos + 1;
      this.line++;
      this.column = 1;
      return {
        type: TokenType.NEWLINE,
        value: "\n",
        start: pos,
        end: pos + 1,
        line: startLine,
        column: startColumn
      };
    }
    if (c0 === "<" && c1 === "<" && c2 === "-") {
      this.pos = pos + 3;
      this.column = startColumn + 3;
      this.registerHeredocFromLookahead(true);
      return this.makeToken(TokenType.DLESSDASH, "<<-", pos, startLine, startColumn);
    }
    for (const [first, second, third, type] of THREE_CHAR_OPS) {
      if (c0 === first && c1 === second && c2 === third) {
        this.pos = pos + 3;
        this.column = startColumn + 3;
        return this.makeToken(type, first + second + third, pos, startLine, startColumn);
      }
    }
    if (c0 === "<" && c1 === "<") {
      this.pos = pos + 2;
      this.column = startColumn + 2;
      this.registerHeredocFromLookahead(false);
      return this.makeToken(TokenType.DLESS, "<<", pos, startLine, startColumn);
    }
    if (c0 === "(" && c1 === "(") {
      if (this.dparenDepth > 0) {
        this.pos = pos + 1;
        this.column = startColumn + 1;
        this.dparenDepth++;
        return this.makeToken(TokenType.LPAREN, "(", pos, startLine, startColumn);
      }
      if (this.looksLikeNestedSubshells(pos + 2) || this.dparenClosesWithSpacedParens(pos + 2)) {
        this.pos = pos + 1;
        this.column = startColumn + 1;
        return this.makeToken(TokenType.LPAREN, "(", pos, startLine, startColumn);
      }
      this.pos = pos + 2;
      this.column = startColumn + 2;
      this.dparenDepth = 1;
      return this.makeToken(TokenType.DPAREN_START, "((", pos, startLine, startColumn);
    }
    if (c0 === ")" && c1 === ")") {
      if (this.dparenDepth === 1) {
        this.pos = pos + 2;
        this.column = startColumn + 2;
        this.dparenDepth = 0;
        return this.makeToken(TokenType.DPAREN_END, "))", pos, startLine, startColumn);
      } else if (this.dparenDepth > 1) {
        this.pos = pos + 1;
        this.column = startColumn + 1;
        this.dparenDepth--;
        return this.makeToken(TokenType.RPAREN, ")", pos, startLine, startColumn);
      }
      this.pos = pos + 1;
      this.column = startColumn + 1;
      return this.makeToken(TokenType.RPAREN, ")", pos, startLine, startColumn);
    }
    for (const [first, second, type] of TWO_CHAR_OPS) {
      if (first === "(" && second === "(" || first === ")" && second === ")") {
        continue;
      }
      if (this.dparenDepth > 0 && first === ";" && (type === TokenType.DSEMI || type === TokenType.SEMI_AND || type === TokenType.SEMI_SEMI_AND)) {
        continue;
      }
      if (c0 === first && c1 === second) {
        if (type === TokenType.DBRACK_START || type === TokenType.DBRACK_END) {
          const afterOp = input[pos + 2];
          if (afterOp !== void 0 && afterOp !== " " && afterOp !== "	" && afterOp !== "\n" && afterOp !== ";" && afterOp !== "&" && afterOp !== "|" && afterOp !== "(" && afterOp !== ")" && afterOp !== "<" && afterOp !== ">") {
            break;
          }
        }
        this.pos = pos + 2;
        this.column = startColumn + 2;
        return this.makeToken(type, first + second, pos, startLine, startColumn);
      }
    }
    if (c0 === "(" && this.dparenDepth > 0) {
      this.pos = pos + 1;
      this.column = startColumn + 1;
      this.dparenDepth++;
      return this.makeToken(TokenType.LPAREN, "(", pos, startLine, startColumn);
    }
    if (c0 === ")" && this.dparenDepth > 1) {
      this.pos = pos + 1;
      this.column = startColumn + 1;
      this.dparenDepth--;
      return this.makeToken(TokenType.RPAREN, ")", pos, startLine, startColumn);
    }
    const singleCharType = SINGLE_CHAR_OPS[c0];
    if (singleCharType) {
      this.pos = pos + 1;
      this.column = startColumn + 1;
      return this.makeToken(singleCharType, c0, pos, startLine, startColumn);
    }
    if (c0 === "{") {
      const fdVarResult = this.scanFdVariable(pos);
      if (fdVarResult !== null) {
        this.pos = fdVarResult.end;
        this.column = startColumn + (fdVarResult.end - pos);
        return {
          type: TokenType.FD_VARIABLE,
          value: fdVarResult.varname,
          start: pos,
          end: fdVarResult.end,
          line: startLine,
          column: startColumn
        };
      }
      if (c1 === "}") {
        this.pos = pos + 2;
        this.column = startColumn + 2;
        return {
          type: TokenType.WORD,
          value: "{}",
          start: pos,
          end: pos + 2,
          line: startLine,
          column: startColumn,
          quoted: false,
          singleQuoted: false
        };
      }
      const braceContent = this.scanBraceExpansion(pos);
      if (braceContent !== null) {
        return this.readWordWithBraceExpansion(pos, startLine, startColumn);
      }
      const literalBrace = this.scanLiteralBraceWord(pos);
      if (literalBrace !== null) {
        return this.readWordWithBraceExpansion(pos, startLine, startColumn);
      }
      if (c1 !== void 0 && c1 !== " " && c1 !== "	" && c1 !== "\n") {
        return this.readWord(pos, startLine, startColumn);
      }
      this.pos = pos + 1;
      this.column = startColumn + 1;
      return this.makeToken(TokenType.LBRACE, "{", pos, startLine, startColumn);
    }
    if (c0 === "}") {
      if (this.isWordCharFollowing(pos + 1)) {
        return this.readWord(pos, startLine, startColumn);
      }
      this.pos = pos + 1;
      this.column = startColumn + 1;
      return this.makeToken(TokenType.RBRACE, "}", pos, startLine, startColumn);
    }
    if (c0 === "!") {
      if (c1 === "=") {
        this.pos = pos + 2;
        this.column = startColumn + 2;
        return this.makeToken(TokenType.WORD, "!=", pos, startLine, startColumn);
      }
      this.pos = pos + 1;
      this.column = startColumn + 1;
      return this.makeToken(TokenType.BANG, "!", pos, startLine, startColumn);
    }
    return this.readWord(pos, startLine, startColumn);
  }
  /**
   * Look ahead from position after (( to determine if this is nested subshells
   * like ((cmd) || (cmd2)) rather than arithmetic like ((1+2)).
   *
   * Returns true if it looks like nested subshells (command invocation).
   */
  looksLikeNestedSubshells(startPos) {
    const input = this.input;
    const len = input.length;
    let pos = startPos;
    while (pos < len && (input[pos] === " " || input[pos] === "	")) {
      pos++;
    }
    if (pos >= len)
      return false;
    const c = input[pos];
    if (c === "(") {
      return this.looksLikeNestedSubshells(pos + 1);
    }
    const isLetter = /[a-zA-Z_]/.test(c);
    const isSpecialCommand = c === "!" || c === "[";
    if (!isLetter && !isSpecialCommand) {
      return false;
    }
    let wordEnd = pos;
    while (wordEnd < len && /[a-zA-Z0-9_\-.]/.test(input[wordEnd])) {
      wordEnd++;
    }
    if (wordEnd === pos) {
      return isSpecialCommand;
    }
    let afterWord = wordEnd;
    while (afterWord < len && (input[afterWord] === " " || input[afterWord] === "	")) {
      afterWord++;
    }
    if (afterWord >= len)
      return false;
    const nextChar = input[afterWord];
    if (nextChar === "=" && input[afterWord + 1] !== "=") {
      return false;
    }
    if (nextChar === "\n") {
      return false;
    }
    if (wordEnd === afterWord && /[+\-*/%<>&|^!~?:]/.test(nextChar) && nextChar !== "-") {
      return false;
    }
    if (nextChar === ")" && input[afterWord + 1] === ")") {
      return false;
    }
    if (afterWord > wordEnd && (nextChar === "-" || nextChar === '"' || nextChar === "'" || nextChar === "$" || /[a-zA-Z_/.]/.test(nextChar))) {
      let scanPos = afterWord;
      while (scanPos < len && input[scanPos] !== "\n") {
        if (input[scanPos] === ")") {
          return true;
        }
        scanPos++;
      }
      return false;
    }
    if (nextChar === ")") {
      let afterParen = afterWord + 1;
      while (afterParen < len && (input[afterParen] === " " || input[afterParen] === "	")) {
        afterParen++;
      }
      if (input[afterParen] === "|" && input[afterParen + 1] === "|" || input[afterParen] === "&" && input[afterParen + 1] === "&" || input[afterParen] === ";" || input[afterParen] === "|" && input[afterParen + 1] !== "|") {
        return true;
      }
    }
    return false;
  }
  makeToken(type, value, start, line, column) {
    return {
      type,
      value,
      start,
      end: this.pos,
      line,
      column
    };
  }
  readComment(start, line, column) {
    const input = this.input;
    const len = input.length;
    let pos = this.pos;
    while (pos < len && input[pos] !== "\n") {
      pos++;
    }
    const value = input.slice(start, pos);
    this.pos = pos;
    this.column = column + (pos - start);
    return {
      type: TokenType.COMMENT,
      value,
      start,
      end: pos,
      line,
      column
    };
  }
  readWord(start, line, column) {
    const input = this.input;
    const len = input.length;
    let pos = this.pos;
    const fastStart = pos;
    while (pos < len) {
      const c = input[pos];
      if (c === " " || c === "	" || c === "\n" || c === ";" || c === "&" || c === "|" || c === "(" || c === ")" || c === "<" || c === ">" || c === "'" || c === '"' || c === "\\" || c === "$" || c === "`" || c === "{" || c === "}" || c === "~" || c === "*" || c === "?" || c === "[") {
        break;
      }
      pos++;
    }
    if (pos > fastStart) {
      const c = input[pos];
      if (c === "(" && pos > fastStart && "@*+?!".includes(input[pos - 1])) {
      } else if (
        // If we hit end or a simple delimiter, we can use the fast path result
        pos >= len || c === " " || c === "	" || c === "\n" || c === ";" || c === "&" || c === "|" || c === "(" || c === ")" || c === "<" || c === ">"
      ) {
        const value2 = input.slice(fastStart, pos);
        this.pos = pos;
        this.column = column + (pos - fastStart);
        if (RESERVED_WORDS[value2]) {
          return {
            type: RESERVED_WORDS[value2],
            value: value2,
            start,
            end: pos,
            line,
            column
          };
        }
        const eqIdx = findAssignmentEq(value2);
        if (eqIdx > 0 && isValidAssignmentLHS(value2.slice(0, eqIdx))) {
          return {
            type: TokenType.ASSIGNMENT_WORD,
            value: value2,
            start,
            end: pos,
            line,
            column
          };
        }
        if (/^[0-9]+$/.test(value2)) {
          return {
            type: TokenType.NUMBER,
            value: value2,
            start,
            end: pos,
            line,
            column
          };
        }
        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value2)) {
          return {
            type: TokenType.NAME,
            value: value2,
            start,
            end: pos,
            line,
            column,
            quoted: false,
            singleQuoted: false
          };
        }
        return {
          type: TokenType.WORD,
          value: value2,
          start,
          end: pos,
          line,
          column,
          quoted: false,
          singleQuoted: false
        };
      }
    }
    pos = this.pos;
    let col = this.column;
    let ln = this.line;
    let value = "";
    let quoted = false;
    let singleQuoted = false;
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let startsWithQuote = input[pos] === '"' || input[pos] === "'";
    let hasContentAfterQuote = false;
    let bracketDepth = 0;
    while (pos < len) {
      const char = input[pos];
      if (!inSingleQuote && !inDoubleQuote) {
        if (char === "(" && value.length > 0 && "@*+?!".includes(value[value.length - 1])) {
          const extglobResult = this.scanExtglobPattern(pos);
          if (extglobResult !== null) {
            value += extglobResult.content;
            pos = extglobResult.end;
            col += extglobResult.content.length;
            continue;
          }
        }
        if (char === "[" && bracketDepth === 0) {
          if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
            const afterBracket = pos + 1 < len ? input[pos + 1] : "";
            if (afterBracket === "^" || afterBracket === "!") {
              value += char;
              pos++;
              col++;
              continue;
            }
            bracketDepth = 1;
            value += char;
            pos++;
            col++;
            continue;
          }
        } else if (char === "[" && bracketDepth > 0) {
          if (value.length > 0 && value[value.length - 1] !== "\\") {
            bracketDepth++;
          }
          value += char;
          pos++;
          col++;
          continue;
        } else if (char === "]" && bracketDepth > 0) {
          if (value.length > 0 && value[value.length - 1] !== "\\") {
            bracketDepth--;
          }
          value += char;
          pos++;
          col++;
          continue;
        }
        if (bracketDepth > 0) {
          if (char === "\n") {
            break;
          }
          value += char;
          pos++;
          col++;
          continue;
        }
        if (char === " " || char === "	" || char === "\n" || char === ";" || char === "&" || char === "|" || char === "(" || char === ")" || char === "<" || char === ">") {
          break;
        }
      }
      if (char === "$" && pos + 1 < len && input[pos + 1] === "'" && !inSingleQuote && !inDoubleQuote) {
        value += "$'";
        pos += 2;
        col += 2;
        while (pos < len && input[pos] !== "'") {
          if (input[pos] === "\\" && pos + 1 < len) {
            value += input[pos] + input[pos + 1];
            pos += 2;
            col += 2;
          } else {
            value += input[pos];
            pos++;
            col++;
          }
        }
        if (pos < len) {
          value += "'";
          pos++;
          col++;
        }
        continue;
      }
      if (char === "$" && pos + 1 < len && input[pos + 1] === '"' && !inSingleQuote && !inDoubleQuote) {
        pos++;
        col++;
        inDoubleQuote = true;
        quoted = true;
        if (value === "") {
          startsWithQuote = true;
        }
        pos++;
        col++;
        continue;
      }
      if (char === "'" && !inDoubleQuote) {
        if (inSingleQuote) {
          inSingleQuote = false;
          if (!startsWithQuote || hasContentAfterQuote) {
            value += char;
          } else {
            const nextChar = pos + 1 < len ? input[pos + 1] : "";
            if (nextChar && !isWordBoundary(nextChar) && nextChar !== "'") {
              if (nextChar === '"') {
                hasContentAfterQuote = true;
                value += char;
                singleQuoted = false;
                quoted = false;
              } else {
                hasContentAfterQuote = true;
                value += char;
              }
            }
          }
        } else {
          inSingleQuote = true;
          if (startsWithQuote && !hasContentAfterQuote) {
            singleQuoted = true;
            quoted = true;
          } else {
            value += char;
          }
        }
        pos++;
        col++;
        continue;
      }
      if (char === '"' && !inSingleQuote) {
        if (inDoubleQuote) {
          inDoubleQuote = false;
          if (!startsWithQuote || hasContentAfterQuote) {
            value += char;
          } else {
            const nextChar = pos + 1 < len ? input[pos + 1] : "";
            if (nextChar && !isWordBoundary(nextChar) && nextChar !== '"') {
              if (nextChar === "'") {
                hasContentAfterQuote = true;
                value += char;
                singleQuoted = false;
                quoted = false;
              } else {
                hasContentAfterQuote = true;
                value += char;
              }
            }
          }
        } else {
          inDoubleQuote = true;
          if (startsWithQuote && !hasContentAfterQuote) {
            quoted = true;
          } else {
            value += char;
          }
        }
        pos++;
        col++;
        continue;
      }
      if (char === "\\" && !inSingleQuote && pos + 1 < len) {
        const nextChar = input[pos + 1];
        if (nextChar === "\n") {
          pos += 2;
          ln++;
          col = 1;
          continue;
        }
        if (inDoubleQuote) {
          if (nextChar === '"' || nextChar === "\\" || nextChar === "$" || nextChar === "`" || nextChar === "\n") {
            if (nextChar === "\n") {
              pos += 2;
              col = 1;
              ln++;
              continue;
            }
            value += char + nextChar;
            pos += 2;
            col += 2;
            continue;
          }
        } else {
          if (nextChar === "\\" || nextChar === '"' || nextChar === "'" || nextChar === "`" || nextChar === "*" || nextChar === "?" || nextChar === "[" || nextChar === "]" || nextChar === "(" || nextChar === ")" || nextChar === "$" || nextChar === "-" || // Regex-specific metacharacters for [[ =~ ]] patterns
          nextChar === "." || nextChar === "^" || nextChar === "+" || nextChar === "{" || nextChar === "}") {
            value += char + nextChar;
          } else {
            value += nextChar;
          }
          pos += 2;
          col += 2;
          continue;
        }
      }
      if (char === "$" && pos + 1 < len && input[pos + 1] === "(" && !inSingleQuote) {
        value += char;
        pos++;
        col++;
        value += input[pos];
        pos++;
        col++;
        let depth = 1;
        let inSingleQuote2 = false;
        let inDoubleQuote2 = false;
        let caseDepth = 0;
        let inCasePattern = false;
        let wordBuffer = "";
        const isArithmetic = input[pos] === "(" && !this.dollarDparenIsSubshell(pos);
        while (depth > 0 && pos < len) {
          const c = input[pos];
          value += c;
          if (inSingleQuote2) {
            if (c === "'")
              inSingleQuote2 = false;
          } else if (inDoubleQuote2) {
            if (c === "\\" && pos + 1 < len) {
              value += input[pos + 1];
              pos++;
              col++;
            } else if (c === '"') {
              inDoubleQuote2 = false;
            }
          } else {
            if (c === "'") {
              inSingleQuote2 = true;
              wordBuffer = "";
            } else if (c === '"') {
              inDoubleQuote2 = true;
              wordBuffer = "";
            } else if (c === "\\" && pos + 1 < len) {
              value += input[pos + 1];
              pos++;
              col++;
              wordBuffer = "";
            } else if (c === "$" && pos + 1 < len && input[pos + 1] === "{") {
              pos++;
              col++;
              value += input[pos];
              pos++;
              col++;
              let braceDepth = 1;
              let inBraceSingleQuote = false;
              let inBraceDoubleQuote = false;
              while (braceDepth > 0 && pos < len) {
                const bc = input[pos];
                if (bc === "\\" && pos + 1 < len && !inBraceSingleQuote) {
                  value += bc;
                  pos++;
                  col++;
                  value += input[pos];
                  pos++;
                  col++;
                  continue;
                }
                value += bc;
                if (inBraceSingleQuote) {
                  if (bc === "'")
                    inBraceSingleQuote = false;
                } else if (inBraceDoubleQuote) {
                  if (bc === '"')
                    inBraceDoubleQuote = false;
                } else {
                  if (bc === "'")
                    inBraceSingleQuote = true;
                  else if (bc === '"')
                    inBraceDoubleQuote = true;
                  else if (bc === "{")
                    braceDepth++;
                  else if (bc === "}")
                    braceDepth--;
                }
                if (bc === "\n") {
                  ln++;
                  col = 0;
                } else {
                  col++;
                }
                pos++;
              }
              wordBuffer = "";
              continue;
            } else if (c === "#" && !isArithmetic && // # is NOT a comment in arithmetic expansion
            (wordBuffer === "" || /\s/.test(input[pos - 1] || ""))) {
              while (pos + 1 < len && input[pos + 1] !== "\n") {
                pos++;
                col++;
                value += input[pos];
              }
              wordBuffer = "";
            } else if (/[a-zA-Z_]/.test(c)) {
              wordBuffer += c;
            } else {
              if (wordBuffer === "case") {
                caseDepth++;
                inCasePattern = false;
              } else if (wordBuffer === "in" && caseDepth > 0) {
                inCasePattern = true;
              } else if (wordBuffer === "esac" && caseDepth > 0) {
                caseDepth--;
                inCasePattern = false;
              }
              wordBuffer = "";
              if (c === "(") {
                if (pos > 0 && input[pos - 1] === "$") {
                  depth++;
                } else if (!inCasePattern) {
                  depth++;
                }
              } else if (c === ")") {
                if (inCasePattern) {
                  inCasePattern = false;
                } else {
                  depth--;
                }
              } else if (c === ";") {
                if (caseDepth > 0 && pos + 1 < len && input[pos + 1] === ";") {
                  inCasePattern = true;
                }
              }
            }
          }
          if (c === "\n") {
            ln++;
            col = 0;
            wordBuffer = "";
          }
          pos++;
          col++;
        }
        continue;
      }
      if (char === "$" && pos + 1 < len && input[pos + 1] === "[" && !inSingleQuote) {
        value += char;
        pos++;
        col++;
        value += input[pos];
        pos++;
        col++;
        let depth = 1;
        while (depth > 0 && pos < len) {
          const c = input[pos];
          value += c;
          if (c === "[")
            depth++;
          else if (c === "]")
            depth--;
          else if (c === "\n") {
            ln++;
            col = 0;
          }
          pos++;
          col++;
        }
        continue;
      }
      if (char === "$" && pos + 1 < len && input[pos + 1] === "{" && !inSingleQuote) {
        value += char;
        pos++;
        col++;
        value += input[pos];
        pos++;
        col++;
        let depth = 1;
        let inParamSingleQuote = false;
        let inParamDoubleQuote = false;
        let singleQuoteStartLine = ln;
        let singleQuoteStartCol = col;
        let doubleQuoteStartLine = ln;
        let doubleQuoteStartCol = col;
        while (depth > 0 && pos < len) {
          const c = input[pos];
          if (c === "\\" && pos + 1 < len && input[pos + 1] === "\n") {
            pos += 2;
            ln++;
            col = 1;
            continue;
          }
          if (c === "\\" && pos + 1 < len && !inParamSingleQuote) {
            value += c;
            pos++;
            col++;
            value += input[pos];
            pos++;
            col++;
            continue;
          }
          value += c;
          if (inParamSingleQuote) {
            if (c === "'") {
              inParamSingleQuote = false;
            }
          } else if (inParamDoubleQuote) {
            if (c === '"') {
              inParamDoubleQuote = false;
            }
          } else {
            if (c === "'") {
              inParamSingleQuote = true;
              singleQuoteStartLine = ln;
              singleQuoteStartCol = col;
            } else if (c === '"') {
              inParamDoubleQuote = true;
              doubleQuoteStartLine = ln;
              doubleQuoteStartCol = col;
            } else if (c === "{") {
              depth++;
            } else if (c === "}") {
              depth--;
            }
          }
          if (c === "\n") {
            ln++;
            col = 0;
          }
          pos++;
          col++;
        }
        if (inParamSingleQuote) {
          throw new LexerError("unexpected EOF while looking for matching `''", singleQuoteStartLine, singleQuoteStartCol);
        }
        if (inParamDoubleQuote) {
          throw new LexerError("unexpected EOF while looking for matching `\"'", doubleQuoteStartLine, doubleQuoteStartCol);
        }
        continue;
      }
      if (char === "$" && pos + 1 < len && !inSingleQuote) {
        const next = input[pos + 1];
        if (next === "#" || next === "?" || next === "$" || next === "!" || next === "@" || next === "*" || next === "-" || next >= "0" && next <= "9") {
          value += char + next;
          pos += 2;
          col += 2;
          continue;
        }
      }
      if (char === "`" && !inSingleQuote) {
        value += char;
        pos++;
        col++;
        while (pos < len && input[pos] !== "`") {
          const c = input[pos];
          value += c;
          if (c === "\\" && pos + 1 < len) {
            value += input[pos + 1];
            pos++;
            col++;
          }
          if (c === "\n") {
            ln++;
            col = 0;
          }
          pos++;
          col++;
        }
        if (pos < len) {
          value += input[pos];
          pos++;
          col++;
        }
        continue;
      }
      value += char;
      pos++;
      if (char === "\n") {
        ln++;
        col = 1;
      } else {
        col++;
      }
    }
    this.pos = pos;
    this.column = col;
    this.line = ln;
    if (hasContentAfterQuote && startsWithQuote) {
      const openQuote = input[start];
      value = openQuote + value;
      quoted = false;
      singleQuoted = false;
    }
    if (inSingleQuote || inDoubleQuote) {
      const quoteType = inSingleQuote ? "'" : '"';
      throw new LexerError(`unexpected EOF while looking for matching \`${quoteType}'`, line, column);
    }
    if (!startsWithQuote && value.length >= 2) {
      if (value[0] === "'" && value[value.length - 1] === "'") {
        const inner = value.slice(1, -1);
        if (!inner.includes("'") && !inner.includes('"')) {
          value = inner;
          quoted = true;
          singleQuoted = true;
        }
      } else if (value[0] === '"' && value[value.length - 1] === '"') {
        const inner = value.slice(1, -1);
        let hasUnescapedQuote = false;
        for (let i = 0; i < inner.length; i++) {
          if (inner[i] === '"') {
            hasUnescapedQuote = true;
            break;
          }
          if (inner[i] === "\\" && i + 1 < inner.length) {
            i++;
          }
        }
        if (!hasUnescapedQuote) {
          value = inner;
          quoted = true;
          singleQuoted = false;
        }
      }
    }
    if (value === "") {
      return {
        type: TokenType.WORD,
        value: "",
        start,
        end: pos,
        line,
        column,
        quoted,
        singleQuoted
      };
    }
    if (!quoted && RESERVED_WORDS[value]) {
      return {
        type: RESERVED_WORDS[value],
        value,
        start,
        end: pos,
        line,
        column
      };
    }
    if (!startsWithQuote) {
      const eqIdx = findAssignmentEq(value);
      if (eqIdx > 0 && isValidAssignmentLHS(value.slice(0, eqIdx))) {
        return {
          type: TokenType.ASSIGNMENT_WORD,
          value,
          start,
          end: pos,
          line,
          column,
          quoted,
          singleQuoted
        };
      }
    }
    if (/^[0-9]+$/.test(value)) {
      return {
        type: TokenType.NUMBER,
        value,
        start,
        end: pos,
        line,
        column
      };
    }
    if (isValidName(value)) {
      return {
        type: TokenType.NAME,
        value,
        start,
        end: pos,
        line,
        column,
        quoted,
        singleQuoted
      };
    }
    return {
      type: TokenType.WORD,
      value,
      start,
      end: pos,
      line,
      column,
      quoted,
      singleQuoted
    };
  }
  readHeredocContent() {
    while (this.pendingHeredocs.length > 0) {
      const heredoc = this.pendingHeredocs.shift();
      if (!heredoc)
        break;
      const start = this.pos;
      const startLine = this.line;
      const startColumn = this.column;
      let content = "";
      while (this.pos < this.input.length) {
        const _lineStart = this.pos;
        let line = "";
        while (this.pos < this.input.length && this.input[this.pos] !== "\n") {
          line += this.input[this.pos];
          this.pos++;
          this.column++;
        }
        const lineToCheck = heredoc.stripTabs ? line.replace(/^\t+/, "") : line;
        if (lineToCheck === heredoc.delimiter) {
          if (this.pos < this.input.length && this.input[this.pos] === "\n") {
            this.pos++;
            this.line++;
            this.column = 1;
          }
          break;
        }
        content += line;
        if (this.pos < this.input.length && this.input[this.pos] === "\n") {
          content += "\n";
          this.pos++;
          this.line++;
          this.column = 1;
        }
      }
      this.tokens.push({
        type: TokenType.HEREDOC_CONTENT,
        value: content,
        start,
        end: this.pos,
        line: startLine,
        column: startColumn
      });
    }
  }
  /**
   * Register a here-document to be read after the next newline
   */
  addPendingHeredoc(delimiter, stripTabs, quoted) {
    this.pendingHeredocs.push({ delimiter, stripTabs, quoted });
  }
  /**
   * Look ahead from current position to find the here-doc delimiter
   * and register it as a pending here-doc
   */
  registerHeredocFromLookahead(stripTabs) {
    const savedPos = this.pos;
    const savedColumn = this.column;
    while (this.pos < this.input.length && (this.input[this.pos] === " " || this.input[this.pos] === "	")) {
      this.pos++;
      this.column++;
    }
    let delimiter = "";
    let quoted = false;
    while (this.pos < this.input.length) {
      const char = this.input[this.pos];
      if (/[\s;<>&|()]/.test(char)) {
        break;
      }
      if (char === "'" || char === '"') {
        quoted = true;
        const quoteChar = char;
        this.pos++;
        this.column++;
        while (this.pos < this.input.length && this.input[this.pos] !== quoteChar) {
          delimiter += this.input[this.pos];
          this.pos++;
          this.column++;
        }
        if (this.pos < this.input.length && this.input[this.pos] === quoteChar) {
          this.pos++;
          this.column++;
        }
      } else if (char === "\\") {
        quoted = true;
        this.pos++;
        this.column++;
        if (this.pos < this.input.length) {
          delimiter += this.input[this.pos];
          this.pos++;
          this.column++;
        }
      } else {
        delimiter += char;
        this.pos++;
        this.column++;
      }
    }
    this.pos = savedPos;
    this.column = savedColumn;
    if (delimiter) {
      this.pendingHeredocs.push({ delimiter, stripTabs, quoted });
    }
  }
  /**
   * Check if position is followed by word characters (not a word boundary).
   * Used to determine if } should be literal or RBRACE token.
   */
  isWordCharFollowing(pos) {
    if (pos >= this.input.length)
      return false;
    const c = this.input[pos];
    return !(c === " " || c === "	" || c === "\n" || c === ";" || c === "&" || c === "|" || c === "(" || c === ")" || c === "<" || c === ">");
  }
  /**
   * Read a word that starts with a brace expansion.
   * Includes the brace expansion plus any suffix characters and additional brace expansions.
   */
  readWordWithBraceExpansion(start, line, column) {
    const input = this.input;
    const len = input.length;
    let pos = start;
    let col = column;
    while (pos < len) {
      const c = input[pos];
      if (c === " " || c === "	" || c === "\n" || c === ";" || c === "&" || c === "|" || c === "(" || c === ")" || c === "<" || c === ">") {
        break;
      }
      if (c === "{") {
        const braceExp = this.scanBraceExpansion(pos);
        if (braceExp !== null) {
          let depth = 1;
          pos++;
          col++;
          while (pos < len && depth > 0) {
            if (input[pos] === "{")
              depth++;
            else if (input[pos] === "}")
              depth--;
            pos++;
            col++;
          }
          continue;
        }
        pos++;
        col++;
        continue;
      }
      if (c === "}") {
        pos++;
        col++;
        continue;
      }
      if (c === "$" && pos + 1 < len && input[pos + 1] === "(") {
        pos++;
        col++;
        pos++;
        col++;
        let depth = 1;
        while (depth > 0 && pos < len) {
          if (input[pos] === "(")
            depth++;
          else if (input[pos] === ")")
            depth--;
          pos++;
          col++;
        }
        continue;
      }
      if (c === "$" && pos + 1 < len && input[pos + 1] === "{") {
        pos++;
        col++;
        pos++;
        col++;
        let depth = 1;
        while (depth > 0 && pos < len) {
          if (input[pos] === "{")
            depth++;
          else if (input[pos] === "}")
            depth--;
          pos++;
          col++;
        }
        continue;
      }
      if (c === "`") {
        pos++;
        col++;
        while (pos < len && input[pos] !== "`") {
          if (input[pos] === "\\" && pos + 1 < len) {
            pos += 2;
            col += 2;
          } else {
            pos++;
            col++;
          }
        }
        if (pos < len) {
          pos++;
          col++;
        }
        continue;
      }
      pos++;
      col++;
    }
    const value = input.slice(start, pos);
    this.pos = pos;
    this.column = col;
    return {
      type: TokenType.WORD,
      value,
      start,
      end: pos,
      line,
      column,
      quoted: false,
      singleQuoted: false
    };
  }
  /**
   * Scan ahead to detect brace expansion pattern.
   * Returns the full brace expansion string if found, null otherwise.
   * Brace expansion must contain either:
   * - A comma (e.g., {a,b,c})
   * - A range with .. (e.g., {1..10})
   */
  scanBraceExpansion(startPos) {
    const input = this.input;
    const len = input.length;
    let pos = startPos + 1;
    let depth = 1;
    let hasComma = false;
    let hasRange = false;
    while (pos < len && depth > 0) {
      const c = input[pos];
      if (c === "{") {
        depth++;
        pos++;
      } else if (c === "}") {
        depth--;
        pos++;
      } else if (c === "," && depth === 1) {
        hasComma = true;
        pos++;
      } else if (c === "." && pos + 1 < len && input[pos + 1] === ".") {
        hasRange = true;
        pos += 2;
      } else if (c === " " || c === "	" || c === "\n" || c === ";" || c === "&" || c === "|") {
        return null;
      } else {
        pos++;
      }
    }
    if (depth === 0 && (hasComma || hasRange)) {
      return input.slice(startPos, pos);
    }
    return null;
  }
  /**
   * Scan a literal brace word like {foo} (no comma, no range).
   * Returns the literal string if found, null otherwise.
   * This is used when {} contains something but it's not a valid brace expansion.
   */
  scanLiteralBraceWord(startPos) {
    const input = this.input;
    const len = input.length;
    let pos = startPos + 1;
    let depth = 1;
    while (pos < len && depth > 0) {
      const c = input[pos];
      if (c === "{") {
        depth++;
        pos++;
      } else if (c === "}") {
        depth--;
        if (depth === 0) {
          return input.slice(startPos, pos + 1);
        }
        pos++;
      } else if (c === " " || c === "	" || c === "\n" || c === ";" || c === "&" || c === "|") {
        return null;
      } else {
        pos++;
      }
    }
    return null;
  }
  /**
   * Scan an extglob pattern starting at the opening parenthesis.
   * Extglob patterns are: @(...), *(...), +(...), ?(...), !(...)
   * The operator (@, *, +, ?, !) is already consumed; we start at the (.
   * Returns the content including parentheses, or null if not a valid extglob.
   */
  scanExtglobPattern(startPos) {
    const input = this.input;
    const len = input.length;
    let pos = startPos + 1;
    let depth = 1;
    while (pos < len && depth > 0) {
      const c = input[pos];
      if (c === "\\" && pos + 1 < len) {
        pos += 2;
        continue;
      }
      if ("@*+?!".includes(c) && pos + 1 < len && input[pos + 1] === "(") {
        pos++;
        depth++;
        pos++;
        continue;
      }
      if (c === "(") {
        depth++;
        pos++;
      } else if (c === ")") {
        depth--;
        pos++;
      } else if (c === "\n") {
        return null;
      } else {
        pos++;
      }
    }
    if (depth === 0) {
      return {
        content: input.slice(startPos, pos),
        end: pos
      };
    }
    return null;
  }
  /**
   * Scan for FD variable syntax: {varname} immediately followed by a redirect operator.
   * This is the bash 4.1+ feature where {fd}>file allocates an FD and stores it in variable.
   * Returns the variable name and end position if found, null otherwise.
   *
   * Valid patterns:
   * - {varname}>file, {varname}>>file, {varname}>|file
   * - {varname}<file, {varname}<<word, {varname}<<<word
   * - {varname}<>file
   * - {varname}>&N, {varname}<&N
   * - {varname}>&-, {varname}<&- (close FD)
   */
  scanFdVariable(startPos) {
    const input = this.input;
    const len = input.length;
    let pos = startPos + 1;
    const nameStart = pos;
    while (pos < len) {
      const c3 = input[pos];
      if (pos === nameStart) {
        if (!(c3 >= "a" && c3 <= "z" || c3 >= "A" && c3 <= "Z" || c3 === "_")) {
          return null;
        }
      } else {
        if (!(c3 >= "a" && c3 <= "z" || c3 >= "A" && c3 <= "Z" || c3 >= "0" && c3 <= "9" || c3 === "_")) {
          break;
        }
      }
      pos++;
    }
    if (pos === nameStart) {
      return null;
    }
    const varname = input.slice(nameStart, pos);
    if (pos >= len || input[pos] !== "}") {
      return null;
    }
    pos++;
    if (pos >= len) {
      return null;
    }
    const c = input[pos];
    const c2 = pos + 1 < len ? input[pos + 1] : "";
    const isRedirectOp = c === ">" || // >, >>, >&, >|
    c === "<" || // <, <<, <&, <<<, <>
    c === "&" && (c2 === ">" || c2 === "<");
    if (!isRedirectOp) {
      return null;
    }
    return { varname, end: pos };
  }
  /**
   * Scan ahead from a $(( position to determine if it should be treated as
   * $( ( subshell ) ) instead of $(( arithmetic )).
   * This handles cases like:
   *   echo $(( echo 1
   *   echo 2
   *   ) )
   * which should be a command substitution containing a subshell, not arithmetic.
   *
   * @param startPos - position at the second ( (i.e., at input[startPos] === "(")
   * @returns true if this is a subshell (closes with ) )), false if arithmetic (closes with )))
   */
  dollarDparenIsSubshell(startPos) {
    const input = this.input;
    const len = input.length;
    let pos = startPos + 1;
    let depth = 2;
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let hasNewline = false;
    while (pos < len && depth > 0) {
      const c = input[pos];
      if (inSingleQuote) {
        if (c === "'") {
          inSingleQuote = false;
        }
        if (c === "\n")
          hasNewline = true;
        pos++;
        continue;
      }
      if (inDoubleQuote) {
        if (c === "\\") {
          pos += 2;
          continue;
        }
        if (c === '"') {
          inDoubleQuote = false;
        }
        if (c === "\n")
          hasNewline = true;
        pos++;
        continue;
      }
      if (c === "'") {
        inSingleQuote = true;
        pos++;
        continue;
      }
      if (c === '"') {
        inDoubleQuote = true;
        pos++;
        continue;
      }
      if (c === "\\") {
        pos += 2;
        continue;
      }
      if (c === "\n") {
        hasNewline = true;
      }
      if (c === "(") {
        depth++;
        pos++;
        continue;
      }
      if (c === ")") {
        depth--;
        if (depth === 1) {
          const nextPos = pos + 1;
          if (nextPos < len && input[nextPos] === ")") {
            return false;
          }
          let scanPos = nextPos;
          let hasWhitespace = false;
          while (scanPos < len && (input[scanPos] === " " || input[scanPos] === "	" || input[scanPos] === "\n")) {
            hasWhitespace = true;
            scanPos++;
          }
          if (hasWhitespace && scanPos < len && input[scanPos] === ")") {
            return true;
          }
          if (hasNewline) {
            return true;
          }
        }
        if (depth === 0) {
          return false;
        }
        pos++;
        continue;
      }
      pos++;
    }
    return false;
  }
  /**
   * Scan ahead from a (( position to determine if it closes with ) ) (nested subshells)
   * or )) (arithmetic). We need to track paren depth and quotes to find the matching close.
   * @param startPos - position after the (( (i.e., at the first char of content)
   * @returns true if it closes with ) ) (space between parens), false otherwise
   */
  dparenClosesWithSpacedParens(startPos) {
    const input = this.input;
    const len = input.length;
    let pos = startPos;
    let depth = 2;
    let inSingleQuote = false;
    let inDoubleQuote = false;
    while (pos < len && depth > 0) {
      const c = input[pos];
      if (inSingleQuote) {
        if (c === "'") {
          inSingleQuote = false;
        }
        pos++;
        continue;
      }
      if (inDoubleQuote) {
        if (c === "\\") {
          pos += 2;
          continue;
        }
        if (c === '"') {
          inDoubleQuote = false;
        }
        pos++;
        continue;
      }
      if (c === "'") {
        inSingleQuote = true;
        pos++;
        continue;
      }
      if (c === '"') {
        inDoubleQuote = true;
        pos++;
        continue;
      }
      if (c === "\\") {
        pos += 2;
        continue;
      }
      if (c === "(") {
        depth++;
        pos++;
        continue;
      }
      if (c === ")") {
        depth--;
        if (depth === 1) {
          const nextPos = pos + 1;
          if (nextPos < len && input[nextPos] === ")") {
            return false;
          }
          let scanPos = nextPos;
          let hasWhitespace = false;
          while (scanPos < len && (input[scanPos] === " " || input[scanPos] === "	" || input[scanPos] === "\n")) {
            hasWhitespace = true;
            scanPos++;
          }
          if (hasWhitespace && scanPos < len && input[scanPos] === ")") {
            return true;
          }
        }
        if (depth === 0) {
          return false;
        }
        pos++;
        continue;
      }
      if (depth === 1) {
        if (c === "|" && pos + 1 < len && input[pos + 1] === "|") {
          return true;
        }
        if (c === "&" && pos + 1 < len && input[pos + 1] === "&") {
          return true;
        }
        if (c === "|" && pos + 1 < len && input[pos + 1] !== "|") {
          return true;
        }
      }
      pos++;
    }
    return false;
  }
};

// dist/parser/types.js
var MAX_INPUT_SIZE = 1e6;
var MAX_TOKENS = 1e5;
var MAX_PARSE_ITERATIONS = 1e6;
var REDIRECTION_TOKENS = /* @__PURE__ */ new Set([
  TokenType.LESS,
  TokenType.GREAT,
  TokenType.DLESS,
  TokenType.DGREAT,
  TokenType.LESSAND,
  TokenType.GREATAND,
  TokenType.LESSGREAT,
  TokenType.DLESSDASH,
  TokenType.CLOBBER,
  TokenType.TLESS,
  TokenType.AND_GREAT,
  TokenType.AND_DGREAT
]);
var REDIRECTION_AFTER_NUMBER = /* @__PURE__ */ new Set([
  TokenType.LESS,
  TokenType.GREAT,
  TokenType.DLESS,
  TokenType.DGREAT,
  TokenType.LESSAND,
  TokenType.GREATAND,
  TokenType.LESSGREAT,
  TokenType.DLESSDASH,
  TokenType.CLOBBER,
  TokenType.TLESS
]);
var REDIRECTION_AFTER_FD_VARIABLE = /* @__PURE__ */ new Set([
  TokenType.LESS,
  TokenType.GREAT,
  TokenType.DLESS,
  TokenType.DGREAT,
  TokenType.LESSAND,
  TokenType.GREATAND,
  TokenType.LESSGREAT,
  TokenType.DLESSDASH,
  TokenType.CLOBBER,
  TokenType.TLESS,
  TokenType.AND_GREAT,
  TokenType.AND_DGREAT
]);
var ParseException = class extends Error {
  static {
    __name(this, "ParseException");
  }
  line;
  column;
  token;
  constructor(message, line, column, token = void 0) {
    super(`Parse error at ${line}:${column}: ${message}`);
    this.line = line;
    this.column = column;
    this.token = token;
    this.name = "ParseException";
  }
};

// dist/parser/word-parser.js
function decodeUtf8WithRecovery(bytes) {
  let result = "";
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i];
    if (b0 < 128) {
      result += String.fromCharCode(b0);
      i++;
      continue;
    }
    if ((b0 & 224) === 192) {
      if (i + 1 < bytes.length && (bytes[i + 1] & 192) === 128 && b0 >= 194) {
        const codePoint = (b0 & 31) << 6 | bytes[i + 1] & 63;
        result += String.fromCharCode(codePoint);
        i += 2;
        continue;
      }
      result += String.fromCharCode(b0);
      i++;
      continue;
    }
    if ((b0 & 240) === 224) {
      if (i + 2 < bytes.length && (bytes[i + 1] & 192) === 128 && (bytes[i + 2] & 192) === 128) {
        if (b0 === 224 && bytes[i + 1] < 160) {
          result += String.fromCharCode(b0);
          i++;
          continue;
        }
        const codePoint = (b0 & 15) << 12 | (bytes[i + 1] & 63) << 6 | bytes[i + 2] & 63;
        if (codePoint >= 55296 && codePoint <= 57343) {
          result += String.fromCharCode(b0);
          i++;
          continue;
        }
        result += String.fromCharCode(codePoint);
        i += 3;
        continue;
      }
      result += String.fromCharCode(b0);
      i++;
      continue;
    }
    if ((b0 & 248) === 240 && b0 <= 244) {
      if (i + 3 < bytes.length && (bytes[i + 1] & 192) === 128 && (bytes[i + 2] & 192) === 128 && (bytes[i + 3] & 192) === 128) {
        if (b0 === 240 && bytes[i + 1] < 144) {
          result += String.fromCharCode(b0);
          i++;
          continue;
        }
        const codePoint = (b0 & 7) << 18 | (bytes[i + 1] & 63) << 12 | (bytes[i + 2] & 63) << 6 | bytes[i + 3] & 63;
        if (codePoint > 1114111) {
          result += String.fromCharCode(b0);
          i++;
          continue;
        }
        result += String.fromCodePoint(codePoint);
        i += 4;
        continue;
      }
      result += String.fromCharCode(b0);
      i++;
      continue;
    }
    result += String.fromCharCode(b0);
    i++;
  }
  return result;
}
__name(decodeUtf8WithRecovery, "decodeUtf8WithRecovery");
function findTildeEnd(_p, value, start) {
  let i = start + 1;
  while (i < value.length && /[a-zA-Z0-9_-]/.test(value[i])) {
    i++;
  }
  return i;
}
__name(findTildeEnd, "findTildeEnd");
function findMatchingBracket(_p, value, start, open, close) {
  let depth = 1;
  let i = start + 1;
  while (i < value.length && depth > 0) {
    if (value[i] === open)
      depth++;
    else if (value[i] === close)
      depth--;
    if (depth > 0)
      i++;
  }
  return depth === 0 ? i : -1;
}
__name(findMatchingBracket, "findMatchingBracket");
function findParameterOperationEnd(_p, value, start) {
  let i = start;
  let depth = 1;
  while (i < value.length && depth > 0) {
    const char = value[i];
    if (char === "\\" && i + 1 < value.length) {
      i += 2;
      continue;
    }
    if (char === "'") {
      const closeIdx = value.indexOf("'", i + 1);
      if (closeIdx !== -1) {
        i = closeIdx + 1;
        continue;
      }
    }
    if (char === '"') {
      i++;
      while (i < value.length && value[i] !== '"') {
        if (value[i] === "\\" && i + 1 < value.length) {
          i += 2;
        } else {
          i++;
        }
      }
      if (i < value.length)
        i++;
      continue;
    }
    if (char === "{")
      depth++;
    else if (char === "}")
      depth--;
    if (depth > 0)
      i++;
  }
  return i;
}
__name(findParameterOperationEnd, "findParameterOperationEnd");
function findPatternEnd(_p, value, start) {
  let i = start;
  let consumedAny = false;
  while (i < value.length) {
    const char = value[i];
    if (char === "/" && consumedAny || char === "}")
      break;
    if (char === "'") {
      const closeIdx = value.indexOf("'", i + 1);
      if (closeIdx !== -1) {
        i = closeIdx + 1;
        consumedAny = true;
        continue;
      }
    }
    if (char === '"') {
      i++;
      while (i < value.length && value[i] !== '"') {
        if (value[i] === "\\" && i + 1 < value.length) {
          i += 2;
        } else {
          i++;
        }
      }
      if (i < value.length)
        i++;
      consumedAny = true;
      continue;
    }
    if (char === "\\") {
      i += 2;
      consumedAny = true;
    } else {
      i++;
      consumedAny = true;
    }
  }
  return i;
}
__name(findPatternEnd, "findPatternEnd");
function parseGlobPattern(_p, value, start) {
  let i = start;
  let pattern = "";
  while (i < value.length) {
    const char = value[i];
    if (char === "*" || char === "?") {
      pattern += char;
      i++;
    } else if (char === "[") {
      const closeIdx = findCharacterClassEnd(value, i);
      if (closeIdx === -1) {
        pattern += char;
        i++;
      } else {
        pattern += value.slice(i, closeIdx + 1);
        i = closeIdx + 1;
      }
    } else {
      break;
    }
  }
  return { pattern, endIndex: i };
}
__name(parseGlobPattern, "parseGlobPattern");
function findCharacterClassEnd(value, start) {
  let i = start + 1;
  if (i < value.length && value[i] === "^") {
    i++;
  }
  if (i < value.length && value[i] === "]") {
    i++;
  }
  while (i < value.length) {
    const char = value[i];
    if (char === "\\" && i + 1 < value.length) {
      const next = value[i + 1];
      if (next === '"' || next === "'") {
        return -1;
      }
      i += 2;
      continue;
    }
    if (char === "]") {
      return i;
    }
    if (char === '"' || char === "$" || char === "`") {
      return -1;
    }
    if (char === "'") {
      const closeQuote = value.indexOf("'", i + 1);
      if (closeQuote !== -1) {
        i = closeQuote + 1;
        continue;
      }
    }
    if (char === "[" && i + 1 < value.length && value[i + 1] === ":") {
      const closePos = value.indexOf(":]", i + 2);
      if (closePos !== -1) {
        i = closePos + 2;
        continue;
      }
    }
    if (char === "[" && i + 1 < value.length && (value[i + 1] === "." || value[i + 1] === "=")) {
      const closeChar = value[i + 1];
      const closeSeq = `${closeChar}]`;
      const closePos = value.indexOf(closeSeq, i + 2);
      if (closePos !== -1) {
        i = closePos + 2;
        continue;
      }
    }
    i++;
  }
  return -1;
}
__name(findCharacterClassEnd, "findCharacterClassEnd");
function parseAnsiCQuoted(_p, value, start) {
  let result = "";
  let i = start;
  while (i < value.length && value[i] !== "'") {
    const char = value[i];
    if (char === "\\" && i + 1 < value.length) {
      const next = value[i + 1];
      switch (next) {
        case "n":
          result += "\n";
          i += 2;
          break;
        case "t":
          result += "	";
          i += 2;
          break;
        case "r":
          result += "\r";
          i += 2;
          break;
        case "\\":
          result += "\\";
          i += 2;
          break;
        case "'":
          result += "'";
          i += 2;
          break;
        case '"':
          result += '"';
          i += 2;
          break;
        case "a":
          result += "\x07";
          i += 2;
          break;
        case "b":
          result += "\b";
          i += 2;
          break;
        case "e":
        case "E":
          result += "\x1B";
          i += 2;
          break;
        case "f":
          result += "\f";
          i += 2;
          break;
        case "v":
          result += "\v";
          i += 2;
          break;
        case "x": {
          const bytes = [];
          let j = i;
          while (j + 1 < value.length && value[j] === "\\" && value[j + 1] === "x") {
            const hex = value.slice(j + 2, j + 4);
            const code = parseInt(hex, 16);
            if (!Number.isNaN(code) && hex.length > 0) {
              bytes.push(code);
              j += 2 + hex.length;
            } else {
              break;
            }
          }
          if (bytes.length > 0) {
            result += decodeUtf8WithRecovery(bytes);
            i = j;
          } else {
            result += "\\x";
            i += 2;
          }
          break;
        }
        case "u": {
          const hex = value.slice(i + 2, i + 6);
          const code = parseInt(hex, 16);
          if (!Number.isNaN(code)) {
            result += String.fromCharCode(code);
            i += 6;
          } else {
            result += "\\u";
            i += 2;
          }
          break;
        }
        case "c": {
          if (i + 2 < value.length) {
            const ctrlChar = value[i + 2];
            const code = ctrlChar.charCodeAt(0) & 31;
            result += String.fromCharCode(code);
            i += 3;
          } else {
            result += "\\c";
            i += 2;
          }
          break;
        }
        case "0":
        case "1":
        case "2":
        case "3":
        case "4":
        case "5":
        case "6":
        case "7": {
          let octal = "";
          let j = i + 1;
          while (j < value.length && j < i + 4 && /[0-7]/.test(value[j])) {
            octal += value[j];
            j++;
          }
          const code = parseInt(octal, 8);
          result += String.fromCharCode(code);
          i = j;
          break;
        }
        default:
          result += char;
          i++;
      }
    } else {
      result += char;
      i++;
    }
  }
  if (i < value.length && value[i] === "'") {
    i++;
  }
  return {
    part: AST.literal(result),
    endIndex: i
  };
}
__name(parseAnsiCQuoted, "parseAnsiCQuoted");
function parseArithExprFromString(p, str) {
  const trimmed = str.trim();
  if (trimmed === "") {
    return {
      type: "ArithmeticExpression",
      expression: { type: "ArithNumber", value: 0 }
    };
  }
  return parseArithmeticExpression(p, trimmed);
}
__name(parseArithExprFromString, "parseArithExprFromString");
function splitBraceItems(inner) {
  const items = [];
  let current = "";
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "{") {
      depth++;
      current += c;
    } else if (c === "}") {
      depth--;
      current += c;
    } else if (c === "," && depth === 0) {
      items.push(current);
      current = "";
    } else {
      current += c;
    }
  }
  items.push(current);
  return items;
}
__name(splitBraceItems, "splitBraceItems");
function tryParseBraceExpansion(p, value, start, parseWordPartsFn) {
  const closeIdx = findMatchingBracket(p, value, start, "{", "}");
  if (closeIdx === -1)
    return null;
  const inner = value.slice(start + 1, closeIdx);
  const rangeMatch = inner.match(/^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/);
  if (rangeMatch) {
    return {
      part: {
        type: "BraceExpansion",
        items: [
          {
            type: "Range",
            start: Number.parseInt(rangeMatch[1], 10),
            end: Number.parseInt(rangeMatch[2], 10),
            step: rangeMatch[3] ? Number.parseInt(rangeMatch[3], 10) : void 0,
            // Store original strings for zero-padding support
            startStr: rangeMatch[1],
            endStr: rangeMatch[2]
          }
        ]
      },
      endIndex: closeIdx + 1
    };
  }
  const charRangeMatch = inner.match(/^([a-zA-Z])\.\.([a-zA-Z])(?:\.\.(-?\d+))?$/);
  if (charRangeMatch) {
    return {
      part: {
        type: "BraceExpansion",
        items: [
          {
            type: "Range",
            start: charRangeMatch[1],
            end: charRangeMatch[2],
            step: charRangeMatch[3] ? Number.parseInt(charRangeMatch[3], 10) : void 0
          }
        ]
      },
      endIndex: closeIdx + 1
    };
  }
  if (inner.includes(",") && parseWordPartsFn) {
    const rawItems = splitBraceItems(inner);
    const items = rawItems.map((s) => ({
      type: "Word",
      word: AST.word(parseWordPartsFn(p, s, false, false, false))
    }));
    return {
      part: { type: "BraceExpansion", items },
      endIndex: closeIdx + 1
    };
  }
  if (inner.includes(",")) {
    const rawItems = splitBraceItems(inner);
    const items = rawItems.map((s) => ({
      type: "Word",
      word: AST.word([AST.literal(s)])
    }));
    return {
      part: { type: "BraceExpansion", items },
      endIndex: closeIdx + 1
    };
  }
  return null;
}
__name(tryParseBraceExpansion, "tryParseBraceExpansion");
function wordToString(_p, word) {
  let result = "";
  for (const part of word.parts) {
    switch (part.type) {
      case "Literal":
        result += part.value;
        break;
      case "SingleQuoted":
        result += `'${part.value}'`;
        break;
      case "Escaped":
        result += part.value;
        break;
      case "DoubleQuoted":
        result += '"';
        for (const inner of part.parts) {
          if (inner.type === "Literal" || inner.type === "Escaped") {
            result += inner.value;
          } else if (inner.type === "ParameterExpansion") {
            result += `\${${inner.parameter}}`;
          }
        }
        result += '"';
        break;
      case "ParameterExpansion":
        result += `\${${part.parameter}}`;
        break;
      case "Glob":
        result += part.pattern;
        break;
      case "TildeExpansion":
        result += "~";
        if (part.user) {
          result += part.user;
        }
        break;
      case "BraceExpansion": {
        result += "{";
        const braceItems = [];
        for (const item of part.items) {
          if (item.type === "Range") {
            const startVal = item.startStr ?? String(item.start);
            const endVal = item.endStr ?? String(item.end);
            if (item.step !== void 0) {
              braceItems.push(`${startVal}..${endVal}..${item.step}`);
            } else {
              braceItems.push(`${startVal}..${endVal}`);
            }
          } else {
            braceItems.push(wordToString(_p, item.word));
          }
        }
        if (braceItems.length === 1 && part.items[0].type === "Range") {
          result += braceItems[0];
        } else {
          result += braceItems.join(",");
        }
        result += "}";
        break;
      }
      default:
        result += part.type;
    }
  }
  return result;
}
__name(wordToString, "wordToString");
function tokenToRedirectOp(_p, type) {
  const map = {
    [TokenType.LESS]: "<",
    [TokenType.GREAT]: ">",
    [TokenType.DGREAT]: ">>",
    [TokenType.LESSAND]: "<&",
    [TokenType.GREATAND]: ">&",
    [TokenType.LESSGREAT]: "<>",
    [TokenType.CLOBBER]: ">|",
    [TokenType.TLESS]: "<<<",
    [TokenType.AND_GREAT]: "&>",
    [TokenType.AND_DGREAT]: "&>>",
    [TokenType.DLESS]: "<",
    // Here-doc operator is <
    [TokenType.DLESSDASH]: "<"
  };
  return map[type] || ">";
}
__name(tokenToRedirectOp, "tokenToRedirectOp");

// dist/parser/command-parser.js
function isRedirection(p) {
  const currentToken = p.current();
  const t = currentToken.type;
  if (t === TokenType.NUMBER) {
    const nextToken = p.peek(1);
    if (currentToken.end !== nextToken.start) {
      return false;
    }
    return REDIRECTION_AFTER_NUMBER.has(nextToken.type);
  }
  if (t === TokenType.FD_VARIABLE) {
    const nextToken = p.peek(1);
    return REDIRECTION_AFTER_FD_VARIABLE.has(nextToken.type);
  }
  return REDIRECTION_TOKENS.has(t);
}
__name(isRedirection, "isRedirection");
function parseRedirection(p) {
  let fd = null;
  let fdVariable;
  if (p.check(TokenType.NUMBER)) {
    fd = Number.parseInt(p.advance().value, 10);
  } else if (p.check(TokenType.FD_VARIABLE)) {
    fdVariable = p.advance().value;
  }
  const opToken = p.advance();
  const operator = tokenToRedirectOp(p, opToken.type);
  if (opToken.type === TokenType.DLESS || opToken.type === TokenType.DLESSDASH) {
    return parseHeredocStart(p, operator, fd, opToken.type === TokenType.DLESSDASH);
  }
  if (!p.isWord()) {
    p.error("Expected redirection target");
  }
  const target = p.parseWord();
  return AST.redirection(operator, target, fd, fdVariable);
}
__name(parseRedirection, "parseRedirection");
function parseHeredocStart(p, _operator, fd, stripTabs) {
  if (!p.isWord()) {
    p.error("Expected here-document delimiter");
  }
  const delimToken = p.advance();
  let delimiter = delimToken.value;
  const quoted = delimToken.quoted || false;
  if (delimiter.startsWith("'") && delimiter.endsWith("'")) {
    delimiter = delimiter.slice(1, -1);
  } else if (delimiter.startsWith('"') && delimiter.endsWith('"')) {
    delimiter = delimiter.slice(1, -1);
  }
  const redirect = AST.redirection(
    stripTabs ? "<<-" : "<<",
    // Use proper here-doc operator
    AST.hereDoc(delimiter, AST.word([]), stripTabs, quoted),
    fd
  );
  p.addPendingHeredoc(redirect, delimiter, stripTabs, quoted);
  return redirect;
}
__name(parseHeredocStart, "parseHeredocStart");
function parseSimpleCommand(p) {
  const startLine = p.current().line;
  const assignments = [];
  let name = null;
  const args = [];
  const redirections = [];
  while (p.check(TokenType.ASSIGNMENT_WORD) || isRedirection(p)) {
    p.checkIterationLimit();
    if (p.check(TokenType.ASSIGNMENT_WORD)) {
      assignments.push(parseAssignment(p));
    } else {
      redirections.push(parseRedirection(p));
    }
  }
  if (p.isWord()) {
    name = p.parseWord();
  } else if (assignments.length > 0 && (p.check(TokenType.DBRACK_START) || p.check(TokenType.DPAREN_START))) {
    const token = p.advance();
    name = AST.word([AST.literal(token.value)]);
  }
  while ((!p.isStatementEnd() || p.check(TokenType.RBRACE)) && !p.check(TokenType.PIPE, TokenType.PIPE_AMP)) {
    p.checkIterationLimit();
    if (isRedirection(p)) {
      redirections.push(parseRedirection(p));
    } else if (p.check(TokenType.RBRACE)) {
      const token = p.advance();
      args.push(p.parseWordFromString(token.value, false, false));
    } else if (p.check(TokenType.LBRACE)) {
      const token = p.advance();
      args.push(p.parseWordFromString(token.value, false, false));
    } else if (p.check(TokenType.DBRACK_END)) {
      const token = p.advance();
      args.push(p.parseWordFromString(token.value, false, false));
    } else if (p.isWord()) {
      args.push(p.parseWord());
    } else if (p.check(TokenType.ASSIGNMENT_WORD)) {
      const token = p.advance();
      const tokenValue = token.value;
      const endsWithEq = tokenValue.endsWith("=");
      const endsWithEqParen = tokenValue.endsWith("=(");
      if ((endsWithEq || endsWithEqParen) && (endsWithEqParen || p.check(TokenType.LPAREN))) {
        const baseName = endsWithEqParen ? tokenValue.slice(0, -2) : tokenValue.slice(0, -1);
        if (!endsWithEqParen) {
          p.expect(TokenType.LPAREN);
        }
        const elements = parseArrayElements(p);
        p.expect(TokenType.RPAREN);
        const elemStrings = elements.map((e) => wordToString(p, e));
        const arrayStr = `${baseName}=(${elemStrings.join(" ")})`;
        args.push(p.parseWordFromString(arrayStr, false, false));
      } else {
        args.push(p.parseWordFromString(tokenValue, token.quoted, token.singleQuoted));
      }
    } else if (p.check(TokenType.LPAREN)) {
      p.error(`syntax error near unexpected token \`('`);
    } else {
      break;
    }
  }
  const node = AST.simpleCommand(name, args, assignments, redirections);
  node.line = startLine;
  return node;
}
__name(parseSimpleCommand, "parseSimpleCommand");
function parseAssignment(p) {
  const token = p.expect(TokenType.ASSIGNMENT_WORD);
  const value = token.value;
  const nameMatch = value.match(/^[a-zA-Z_][a-zA-Z0-9_]*/);
  if (!nameMatch) {
    p.error(`Invalid assignment: ${value}`);
  }
  const name = nameMatch[0];
  let subscript;
  let pos = name.length;
  if (value[pos] === "[") {
    let depth = 0;
    const subscriptStart = pos + 1;
    for (; pos < value.length; pos++) {
      if (value[pos] === "[")
        depth++;
      else if (value[pos] === "]") {
        depth--;
        if (depth === 0)
          break;
      }
    }
    if (depth !== 0) {
      p.error(`Invalid assignment: ${value}`);
    }
    subscript = value.slice(subscriptStart, pos);
    pos++;
  }
  const append = value[pos] === "+";
  if (append)
    pos++;
  if (value[pos] !== "=") {
    p.error(`Invalid assignment: ${value}`);
  }
  pos++;
  const valueStr = value.slice(pos);
  if (valueStr === "(") {
    const elements = parseArrayElements(p);
    p.expect(TokenType.RPAREN);
    const assignName2 = subscript !== void 0 ? `${name}[${subscript}]` : name;
    return AST.assignment(assignName2, null, append, elements);
  }
  if (valueStr === "" && p.check(TokenType.LPAREN)) {
    const currentToken = p.current();
    if (token.end === currentToken.start) {
      p.advance();
      const elements = parseArrayElements(p);
      p.expect(TokenType.RPAREN);
      const assignName2 = subscript !== void 0 ? `${name}[${subscript}]` : name;
      return AST.assignment(assignName2, null, append, elements);
    }
  }
  const wordValue = valueStr ? p.parseWordFromString(valueStr, token.quoted, token.singleQuoted, true) : null;
  const assignName = subscript !== void 0 ? `${name}[${subscript}]` : name;
  return AST.assignment(assignName, wordValue, append, null);
}
__name(parseAssignment, "parseAssignment");
var INVALID_ARRAY_TOKENS = /* @__PURE__ */ new Set([
  TokenType.AMP,
  // &
  TokenType.PIPE,
  // |
  TokenType.PIPE_AMP,
  // |&
  TokenType.SEMICOLON,
  // ;
  TokenType.AND_AND,
  // &&
  TokenType.OR_OR,
  // ||
  TokenType.DSEMI,
  // ;;
  TokenType.SEMI_AND,
  // ;&
  TokenType.SEMI_SEMI_AND
  // ;;&
]);
function parseArrayElements(p) {
  const elements = [];
  p.skipNewlines();
  while (!p.check(TokenType.RPAREN, TokenType.EOF)) {
    p.checkIterationLimit();
    if (p.isWord()) {
      elements.push(p.parseWord());
    } else if (INVALID_ARRAY_TOKENS.has(p.current().type)) {
      p.error(`syntax error near unexpected token \`${p.current().value}'`);
    } else {
      p.advance();
    }
    p.skipNewlines();
  }
  return elements;
}
__name(parseArrayElements, "parseArrayElements");

// dist/parser/compound-parser.js
function parseIf(p, options) {
  p.expect(TokenType.IF);
  const clauses = [];
  const condition = p.parseCompoundList();
  p.expect(TokenType.THEN);
  const body = p.parseCompoundList();
  if (body.length === 0) {
    const nextTok = p.check(TokenType.FI) ? "fi" : p.check(TokenType.ELSE) ? "else" : p.check(TokenType.ELIF) ? "elif" : "fi";
    p.error(`syntax error near unexpected token \`${nextTok}'`);
  }
  clauses.push({ condition, body });
  while (p.check(TokenType.ELIF)) {
    p.advance();
    const elifCondition = p.parseCompoundList();
    p.expect(TokenType.THEN);
    const elifBody = p.parseCompoundList();
    if (elifBody.length === 0) {
      const nextTok = p.check(TokenType.FI) ? "fi" : p.check(TokenType.ELSE) ? "else" : p.check(TokenType.ELIF) ? "elif" : "fi";
      p.error(`syntax error near unexpected token \`${nextTok}'`);
    }
    clauses.push({ condition: elifCondition, body: elifBody });
  }
  let elseBody = null;
  if (p.check(TokenType.ELSE)) {
    p.advance();
    elseBody = p.parseCompoundList();
    if (elseBody.length === 0) {
      p.error("syntax error near unexpected token `fi'");
    }
  }
  p.expect(TokenType.FI);
  const redirections = options?.skipRedirections ? [] : p.parseOptionalRedirections();
  return AST.ifNode(clauses, elseBody, redirections);
}
__name(parseIf, "parseIf");
function parseFor(p, options) {
  const forToken = p.expect(TokenType.FOR);
  if (p.check(TokenType.DPAREN_START)) {
    return parseCStyleFor(p, options, forToken.line);
  }
  if (!p.isWord()) {
    p.error("Expected variable name in for loop");
  }
  const varToken = p.advance();
  const variable = varToken.value;
  let words = null;
  p.skipNewlines();
  if (p.check(TokenType.IN)) {
    p.advance();
    words = [];
    while (!p.check(TokenType.SEMICOLON, TokenType.NEWLINE, TokenType.DO, TokenType.EOF)) {
      if (p.isWord()) {
        words.push(p.parseWord());
      } else {
        break;
      }
    }
  }
  if (p.check(TokenType.SEMICOLON)) {
    p.advance();
  }
  p.skipNewlines();
  p.expect(TokenType.DO);
  const body = p.parseCompoundList();
  p.expect(TokenType.DONE);
  const redirections = options?.skipRedirections ? [] : p.parseOptionalRedirections();
  return AST.forNode(variable, words, body, redirections);
}
__name(parseFor, "parseFor");
function parseCStyleFor(p, options, startLine) {
  p.expect(TokenType.DPAREN_START);
  let init = null;
  let condition = null;
  let update = null;
  const parts = ["", "", ""];
  let partIdx = 0;
  let depth = 0;
  while (!p.check(TokenType.DPAREN_END, TokenType.EOF)) {
    const token = p.advance();
    if (token.type === TokenType.SEMICOLON && depth === 0) {
      partIdx++;
      if (partIdx > 2)
        break;
    } else {
      if (token.value === "(")
        depth++;
      if (token.value === ")")
        depth--;
      parts[partIdx] += token.value;
    }
  }
  p.expect(TokenType.DPAREN_END);
  if (parts[0].trim()) {
    init = parseArithmeticExpression(p, parts[0].trim());
  }
  if (parts[1].trim()) {
    condition = parseArithmeticExpression(p, parts[1].trim());
  }
  if (parts[2].trim()) {
    update = parseArithmeticExpression(p, parts[2].trim());
  }
  p.skipNewlines();
  if (p.check(TokenType.SEMICOLON)) {
    p.advance();
  }
  p.skipNewlines();
  let body;
  if (p.check(TokenType.LBRACE)) {
    p.advance();
    body = p.parseCompoundList();
    p.expect(TokenType.RBRACE);
  } else {
    p.expect(TokenType.DO);
    body = p.parseCompoundList();
    p.expect(TokenType.DONE);
  }
  const redirections = options?.skipRedirections ? [] : p.parseOptionalRedirections();
  return {
    type: "CStyleFor",
    init,
    condition,
    update,
    body,
    redirections,
    line: startLine
  };
}
__name(parseCStyleFor, "parseCStyleFor");
function parseWhile(p, options) {
  p.expect(TokenType.WHILE);
  const condition = p.parseCompoundList();
  p.expect(TokenType.DO);
  const body = p.parseCompoundList();
  if (body.length === 0) {
    p.error("syntax error near unexpected token `done'");
  }
  p.expect(TokenType.DONE);
  const redirections = options?.skipRedirections ? [] : p.parseOptionalRedirections();
  return AST.whileNode(condition, body, redirections);
}
__name(parseWhile, "parseWhile");
function parseUntil(p, options) {
  p.expect(TokenType.UNTIL);
  const condition = p.parseCompoundList();
  p.expect(TokenType.DO);
  const body = p.parseCompoundList();
  if (body.length === 0) {
    p.error("syntax error near unexpected token `done'");
  }
  p.expect(TokenType.DONE);
  const redirections = options?.skipRedirections ? [] : p.parseOptionalRedirections();
  return AST.untilNode(condition, body, redirections);
}
__name(parseUntil, "parseUntil");
function parseCase(p, options) {
  p.expect(TokenType.CASE);
  if (!p.isWord()) {
    p.error("Expected word after 'case'");
  }
  const word = p.parseWord();
  p.skipNewlines();
  p.expect(TokenType.IN);
  p.skipNewlines();
  const items = [];
  while (!p.check(TokenType.ESAC, TokenType.EOF)) {
    p.checkIterationLimit();
    const posBefore = p.getPos();
    const item = parseCaseItem(p);
    if (item) {
      items.push(item);
    }
    p.skipNewlines();
    if (p.getPos() === posBefore && !item) {
      break;
    }
  }
  p.expect(TokenType.ESAC);
  const redirections = options?.skipRedirections ? [] : p.parseOptionalRedirections();
  return AST.caseNode(word, items, redirections);
}
__name(parseCase, "parseCase");
function parseCaseItem(p) {
  if (p.check(TokenType.LPAREN)) {
    p.advance();
  }
  const patterns = [];
  while (p.isWord()) {
    patterns.push(p.parseWord());
    if (p.check(TokenType.PIPE)) {
      p.advance();
    } else {
      break;
    }
  }
  if (patterns.length === 0) {
    return null;
  }
  p.expect(TokenType.RPAREN);
  p.skipNewlines();
  const body = [];
  while (!p.check(TokenType.DSEMI, TokenType.SEMI_AND, TokenType.SEMI_SEMI_AND, TokenType.ESAC, TokenType.EOF)) {
    p.checkIterationLimit();
    if (p.isWord() && p.peek(1).type === TokenType.RPAREN) {
      p.error(`syntax error near unexpected token \`)'`);
    }
    if (p.check(TokenType.LPAREN) && p.peek(1).type === TokenType.WORD) {
      p.error(`syntax error near unexpected token \`${p.peek(1).value}'`);
    }
    const posBefore = p.getPos();
    const stmt = p.parseStatement();
    if (stmt) {
      body.push(stmt);
    }
    p.skipSeparators(false);
    if (p.getPos() === posBefore && !stmt) {
      break;
    }
  }
  let terminator = ";;";
  if (p.check(TokenType.DSEMI)) {
    p.advance();
    terminator = ";;";
  } else if (p.check(TokenType.SEMI_AND)) {
    p.advance();
    terminator = ";&";
  } else if (p.check(TokenType.SEMI_SEMI_AND)) {
    p.advance();
    terminator = ";;&";
  }
  return AST.caseItem(patterns, body, terminator);
}
__name(parseCaseItem, "parseCaseItem");
function parseSubshell(p, options) {
  p.expect(TokenType.LPAREN);
  const body = p.parseCompoundList();
  p.expect(TokenType.RPAREN);
  const redirections = options?.skipRedirections ? [] : p.parseOptionalRedirections();
  return AST.subshell(body, redirections);
}
__name(parseSubshell, "parseSubshell");
function parseGroup(p, options) {
  p.expect(TokenType.LBRACE);
  const body = p.parseCompoundList();
  p.expect(TokenType.RBRACE);
  const redirections = options?.skipRedirections ? [] : p.parseOptionalRedirections();
  return AST.group(body, redirections);
}
__name(parseGroup, "parseGroup");

// dist/parser/conditional-parser.js
var UNARY_OPS = [
  "-a",
  "-b",
  "-c",
  "-d",
  "-e",
  "-f",
  "-g",
  "-h",
  "-k",
  "-p",
  "-r",
  "-s",
  "-t",
  "-u",
  "-w",
  "-x",
  "-G",
  "-L",
  "-N",
  "-O",
  "-S",
  "-z",
  "-n",
  "-o",
  "-v",
  "-R"
];
var BINARY_OPS = [
  "==",
  "!=",
  "=~",
  "<",
  ">",
  "-eq",
  "-ne",
  "-lt",
  "-le",
  "-gt",
  "-ge",
  "-nt",
  "-ot",
  "-ef"
];
function isCondOperand(p) {
  return p.isWord() || p.check(TokenType.LBRACE) || p.check(TokenType.RBRACE) || p.check(TokenType.ASSIGNMENT_WORD);
}
__name(isCondOperand, "isCondOperand");
function parsePatternWord(p) {
  if (p.check(TokenType.BANG) && p.peek(1).type === TokenType.LPAREN) {
    p.advance();
    p.advance();
    let depth = 1;
    let pattern = "!(";
    while (depth > 0 && !p.check(TokenType.EOF)) {
      if (p.check(TokenType.LPAREN)) {
        depth++;
        pattern += "(";
        p.advance();
      } else if (p.check(TokenType.RPAREN)) {
        depth--;
        if (depth > 0) {
          pattern += ")";
        }
        p.advance();
      } else if (p.isWord()) {
        pattern += p.advance().value;
      } else if (p.check(TokenType.PIPE)) {
        pattern += "|";
        p.advance();
      } else {
        break;
      }
    }
    pattern += ")";
    return p.parseWordFromString(pattern, false, false, false, false, true);
  }
  return p.parseWordNoBraceExpansion();
}
__name(parsePatternWord, "parsePatternWord");
function parseConditionalExpression(p) {
  p.skipNewlines();
  return parseCondOr(p);
}
__name(parseConditionalExpression, "parseConditionalExpression");
function parseCondOr(p) {
  let left = parseCondAnd(p);
  p.skipNewlines();
  while (p.check(TokenType.OR_OR)) {
    p.advance();
    p.skipNewlines();
    const right = parseCondAnd(p);
    left = { type: "CondOr", left, right };
    p.skipNewlines();
  }
  return left;
}
__name(parseCondOr, "parseCondOr");
function parseCondAnd(p) {
  let left = parseCondNot(p);
  p.skipNewlines();
  while (p.check(TokenType.AND_AND)) {
    p.advance();
    p.skipNewlines();
    const right = parseCondNot(p);
    left = { type: "CondAnd", left, right };
    p.skipNewlines();
  }
  return left;
}
__name(parseCondAnd, "parseCondAnd");
function parseCondNot(p) {
  p.skipNewlines();
  if (p.check(TokenType.BANG)) {
    p.advance();
    p.skipNewlines();
    const operand = parseCondNot(p);
    return { type: "CondNot", operand };
  }
  return parseCondPrimary(p);
}
__name(parseCondNot, "parseCondNot");
function parseCondPrimary(p) {
  if (p.check(TokenType.LPAREN)) {
    p.advance();
    const expression = parseConditionalExpression(p);
    p.expect(TokenType.RPAREN);
    return { type: "CondGroup", expression };
  }
  if (isCondOperand(p)) {
    const firstToken = p.current();
    const first = firstToken.value;
    if (UNARY_OPS.includes(first) && !firstToken.quoted) {
      p.advance();
      if (p.check(TokenType.DBRACK_END)) {
        p.error(`Expected operand after ${first}`);
      }
      if (isCondOperand(p)) {
        const operand = p.parseWordNoBraceExpansion();
        return {
          type: "CondUnary",
          operator: first,
          operand
        };
      }
      const badToken = p.current();
      p.error(`unexpected argument \`${badToken.value}' to conditional unary operator`);
    }
    const left = p.parseWordNoBraceExpansion();
    if (p.isWord() && BINARY_OPS.includes(p.current().value)) {
      const operator = p.advance().value;
      let right;
      if (operator === "=~") {
        right = parseRegexPattern(p);
      } else if (operator === "==" || operator === "!=") {
        right = parsePatternWord(p);
      } else {
        right = p.parseWordNoBraceExpansion();
      }
      return {
        type: "CondBinary",
        operator,
        left,
        right
      };
    }
    if (p.check(TokenType.LESS)) {
      p.advance();
      const right = p.parseWordNoBraceExpansion();
      return {
        type: "CondBinary",
        operator: "<",
        left,
        right
      };
    }
    if (p.check(TokenType.GREAT)) {
      p.advance();
      const right = p.parseWordNoBraceExpansion();
      return {
        type: "CondBinary",
        operator: ">",
        left,
        right
      };
    }
    if (p.isWord() && p.current().value === "=") {
      p.advance();
      const right = parsePatternWord(p);
      return {
        type: "CondBinary",
        operator: "==",
        left,
        right
      };
    }
    return { type: "CondWord", word: left };
  }
  p.error("Expected conditional expression");
}
__name(parseCondPrimary, "parseCondPrimary");
function parseRegexPattern(p) {
  const parts = [];
  let parenDepth = 0;
  let lastTokenEnd = -1;
  const input = p.getInput();
  const isTerminator = /* @__PURE__ */ __name(() => p.check(TokenType.DBRACK_END) || p.check(TokenType.AND_AND) || p.check(TokenType.OR_OR) || p.check(TokenType.NEWLINE) || p.check(TokenType.EOF), "isTerminator");
  while (!isTerminator()) {
    const currentToken = p.current();
    const hasGap = lastTokenEnd >= 0 && currentToken.start > lastTokenEnd;
    if (parenDepth === 0 && hasGap) {
      break;
    }
    if (parenDepth > 0 && hasGap) {
      const whitespace = input.slice(lastTokenEnd, currentToken.start);
      parts.push({ type: "Literal", value: whitespace });
    }
    if (p.isWord() || p.check(TokenType.ASSIGNMENT_WORD)) {
      const word = p.parseWordForRegex();
      parts.push(...word.parts);
      lastTokenEnd = p.peek(-1).end;
    } else if (p.check(TokenType.LPAREN)) {
      const token = p.advance();
      parts.push({ type: "Literal", value: "(" });
      parenDepth++;
      lastTokenEnd = token.end;
    } else if (p.check(TokenType.DPAREN_START)) {
      const token = p.advance();
      parts.push({ type: "Literal", value: "((" });
      parenDepth += 2;
      lastTokenEnd = token.end;
    } else if (p.check(TokenType.DPAREN_END)) {
      if (parenDepth >= 2) {
        const token = p.advance();
        parts.push({ type: "Literal", value: "))" });
        parenDepth -= 2;
        lastTokenEnd = token.end;
      } else if (parenDepth === 1) {
        break;
      } else {
        break;
      }
    } else if (p.check(TokenType.RPAREN)) {
      if (parenDepth > 0) {
        const token = p.advance();
        parts.push({ type: "Literal", value: ")" });
        parenDepth--;
        lastTokenEnd = token.end;
      } else {
        break;
      }
    } else if (p.check(TokenType.PIPE)) {
      const token = p.advance();
      parts.push({ type: "Literal", value: "|" });
      lastTokenEnd = token.end;
    } else if (p.check(TokenType.SEMICOLON)) {
      if (parenDepth > 0) {
        const token = p.advance();
        parts.push({ type: "Literal", value: ";" });
        lastTokenEnd = token.end;
      } else {
        break;
      }
    } else if (parenDepth > 0 && p.check(TokenType.LESS)) {
      const token = p.advance();
      parts.push({ type: "Literal", value: "<" });
      lastTokenEnd = token.end;
    } else if (parenDepth > 0 && p.check(TokenType.GREAT)) {
      const token = p.advance();
      parts.push({ type: "Literal", value: ">" });
      lastTokenEnd = token.end;
    } else if (parenDepth > 0 && p.check(TokenType.DGREAT)) {
      const token = p.advance();
      parts.push({ type: "Literal", value: ">>" });
      lastTokenEnd = token.end;
    } else if (parenDepth > 0 && p.check(TokenType.DLESS)) {
      const token = p.advance();
      parts.push({ type: "Literal", value: "<<" });
      lastTokenEnd = token.end;
    } else if (parenDepth > 0 && p.check(TokenType.LESSAND)) {
      const token = p.advance();
      parts.push({ type: "Literal", value: "<&" });
      lastTokenEnd = token.end;
    } else if (parenDepth > 0 && p.check(TokenType.GREATAND)) {
      const token = p.advance();
      parts.push({ type: "Literal", value: ">&" });
      lastTokenEnd = token.end;
    } else if (parenDepth > 0 && p.check(TokenType.LESSGREAT)) {
      const token = p.advance();
      parts.push({ type: "Literal", value: "<>" });
      lastTokenEnd = token.end;
    } else if (parenDepth > 0 && p.check(TokenType.CLOBBER)) {
      const token = p.advance();
      parts.push({ type: "Literal", value: ">|" });
      lastTokenEnd = token.end;
    } else if (parenDepth > 0 && p.check(TokenType.TLESS)) {
      const token = p.advance();
      parts.push({ type: "Literal", value: "<<<" });
      lastTokenEnd = token.end;
    } else if (parenDepth > 0 && p.check(TokenType.AMP)) {
      const token = p.advance();
      parts.push({ type: "Literal", value: "&" });
      lastTokenEnd = token.end;
    } else if (parenDepth > 0 && p.check(TokenType.LBRACE)) {
      const token = p.advance();
      parts.push({ type: "Literal", value: "{" });
      lastTokenEnd = token.end;
    } else if (parenDepth > 0 && p.check(TokenType.RBRACE)) {
      const token = p.advance();
      parts.push({ type: "Literal", value: "}" });
      lastTokenEnd = token.end;
    } else {
      break;
    }
  }
  if (parts.length === 0) {
    p.error("Expected regex pattern after =~");
  }
  return { type: "Word", parts };
}
__name(parseRegexPattern, "parseRegexPattern");

// dist/parser/expansion-parser.js
function findExtglobClose(value, openIdx) {
  let depth = 1;
  let i = openIdx + 1;
  while (i < value.length && depth > 0) {
    const c = value[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if ("@*+?!".includes(c) && i + 1 < value.length && value[i + 1] === "(") {
      i++;
      depth++;
      i++;
      continue;
    }
    if (c === "(") {
      depth++;
    } else if (c === ")") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
    i++;
  }
  return -1;
}
__name(findExtglobClose, "findExtglobClose");
function parseSimpleParameter(_p, value, start) {
  let i = start + 1;
  const char = value[i];
  if ("@*#?$!-0123456789".includes(char)) {
    return {
      part: AST.parameterExpansion(char),
      endIndex: i + 1
    };
  }
  let name = "";
  while (i < value.length && /[a-zA-Z0-9_]/.test(value[i])) {
    name += value[i];
    i++;
  }
  return {
    part: AST.parameterExpansion(name),
    endIndex: i
  };
}
__name(parseSimpleParameter, "parseSimpleParameter");
function parseParameterExpansion(p, value, start, quoted = false) {
  let i = start + 2;
  let indirection = false;
  if (value[i] === "!") {
    indirection = true;
    i++;
  }
  let lengthOp = false;
  if (value[i] === "#" && !/[}:#%/^,]/.test(value[i + 1] || "}")) {
    lengthOp = true;
    i++;
  }
  let name = "";
  const firstChar = value[i];
  if (/[@*#?$!-]/.test(firstChar) && !/[a-zA-Z0-9_]/.test(value[i + 1] || "")) {
    name = firstChar;
    i++;
  } else {
    while (i < value.length && /[a-zA-Z0-9_]/.test(value[i])) {
      name += value[i];
      i++;
    }
  }
  if (value[i] === "[") {
    const closeIdx = findMatchingBracket(p, value, i, "[", "]");
    name += value.slice(i, closeIdx + 1);
    i = closeIdx + 1;
    if (value[i] === "[") {
      let depth = 1;
      let j = i;
      while (j < value.length && depth > 0) {
        if (value[j] === "{")
          depth++;
        else if (value[j] === "}")
          depth--;
        if (depth > 0)
          j++;
      }
      const badText = value.slice(start + 2, j);
      return {
        part: AST.parameterExpansion("", {
          type: "BadSubstitution",
          text: badText
        }),
        endIndex: j + 1
      };
    }
  }
  if (name === "" && !indirection && !lengthOp && value[i] !== "}") {
    let depth = 1;
    let j = i;
    while (j < value.length && depth > 0) {
      if (value[j] === "{")
        depth++;
      else if (value[j] === "}")
        depth--;
      if (depth > 0)
        j++;
    }
    if (depth > 0) {
      throw new ParseException("unexpected EOF while looking for matching '}'", 0, 0);
    }
    const badText = value.slice(start + 2, j);
    return {
      part: AST.parameterExpansion("", {
        type: "BadSubstitution",
        text: badText
      }),
      endIndex: j + 1
    };
  }
  let operation = null;
  if (indirection) {
    const arrayKeysMatch = name.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[([@*])\]$/);
    if (arrayKeysMatch) {
      if (i < value.length && value[i] !== "}" && /[:=\-+?#%/^,@]/.test(value[i])) {
        const opResult = parseParameterOperation(p, value, i, name, quoted);
        if (opResult.operation) {
          operation = {
            type: "Indirection",
            innerOp: opResult.operation
          };
          i = opResult.endIndex;
        } else {
          operation = {
            type: "ArrayKeys",
            array: arrayKeysMatch[1],
            star: arrayKeysMatch[2] === "*"
          };
          name = "";
        }
      } else {
        operation = {
          type: "ArrayKeys",
          array: arrayKeysMatch[1],
          star: arrayKeysMatch[2] === "*"
        };
        name = "";
      }
    } else if (value[i] === "*" || value[i] === "@" && !/[QPaAEKkuUL]/.test(value[i + 1] || "")) {
      const suffix = value[i];
      i++;
      operation = {
        type: "VarNamePrefix",
        prefix: name,
        star: suffix === "*"
      };
      name = "";
    } else {
      if (i < value.length && value[i] !== "}" && /[:=\-+?#%/^,@]/.test(value[i])) {
        const opResult = parseParameterOperation(p, value, i, name, quoted);
        if (opResult.operation) {
          operation = {
            type: "Indirection",
            innerOp: opResult.operation
          };
          i = opResult.endIndex;
        } else {
          operation = { type: "Indirection" };
        }
      } else {
        operation = { type: "Indirection" };
      }
    }
  } else if (lengthOp) {
    if (value[i] === ":") {
      operation = { type: "LengthSliceError" };
      while (i < value.length && value[i] !== "}") {
        i++;
      }
    } else if (value[i] !== "}" && /[-+=?]/.test(value[i])) {
      p.error(`\${#${name}${value.slice(i, value.indexOf("}", i))}}: bad substitution`);
    } else if (value[i] === "/") {
      p.error(`\${#${name}${value.slice(i, value.indexOf("}", i))}}: bad substitution`);
    } else {
      operation = { type: "Length" };
    }
  }
  if (!operation && i < value.length && value[i] !== "}") {
    const opResult = parseParameterOperation(p, value, i, name, quoted);
    operation = opResult.operation;
    i = opResult.endIndex;
  }
  if (i < value.length && value[i] !== "}") {
    const c = value[i];
    if (!/[:\-+=?#%/^,@[]/.test(c)) {
      let endIdx = i;
      while (endIdx < value.length && value[endIdx] !== "}")
        endIdx++;
      const badExp = value.slice(start, endIdx + 1);
      p.error(`\${${badExp.slice(2, -1)}}: bad substitution`);
    }
  }
  while (i < value.length && value[i] !== "}") {
    i++;
  }
  if (i >= value.length) {
    throw new ParseException("unexpected EOF while looking for matching '}'", 0, 0);
  }
  return {
    part: AST.parameterExpansion(name, operation),
    endIndex: i + 1
  };
}
__name(parseParameterExpansion, "parseParameterExpansion");
function parseParameterOperation(p, value, start, _paramName, quoted = false) {
  let i = start;
  const char = value[i];
  const nextChar = value[i + 1] || "";
  if (char === ":") {
    const op = nextChar;
    if ("-=?+".includes(op)) {
      const checkEmpty = true;
      i += 2;
      const wordEnd2 = findParameterOperationEnd(p, value, i);
      const wordStr2 = value.slice(i, wordEnd2);
      const wordParts = parseWordParts(
        p,
        wordStr2,
        false,
        false,
        true,
        // isAssignment=true for tilde expansion after : in default values
        false,
        quoted,
        false,
        // noBraceExpansion
        false,
        // regexPattern
        true
      );
      const word = AST.word(wordParts.length > 0 ? wordParts : [AST.literal("")]);
      if (op === "-") {
        return {
          operation: { type: "DefaultValue", word, checkEmpty },
          endIndex: wordEnd2
        };
      }
      if (op === "=") {
        return {
          operation: { type: "AssignDefault", word, checkEmpty },
          endIndex: wordEnd2
        };
      }
      if (op === "?") {
        return {
          operation: { type: "ErrorIfUnset", word, checkEmpty },
          endIndex: wordEnd2
        };
      }
      if (op === "+") {
        return {
          operation: { type: "UseAlternative", word, checkEmpty },
          endIndex: wordEnd2
        };
      }
    }
    i++;
    const wordEnd = findParameterOperationEnd(p, value, i);
    const wordStr = value.slice(i, wordEnd);
    let colonIdx = -1;
    let depth = 0;
    let ternaryDepth = 0;
    for (let j = 0; j < wordStr.length; j++) {
      const c = wordStr[j];
      if (c === "(" || c === "[")
        depth++;
      else if (c === ")" || c === "]")
        depth--;
      else if (c === "?" && depth === 0)
        ternaryDepth++;
      else if (c === ":" && depth === 0) {
        if (ternaryDepth > 0) {
          ternaryDepth--;
        } else {
          colonIdx = j;
          break;
        }
      }
    }
    const offsetStr = colonIdx >= 0 ? wordStr.slice(0, colonIdx) : wordStr;
    const lengthStr = colonIdx >= 0 ? wordStr.slice(colonIdx + 1) : null;
    return {
      operation: {
        type: "Substring",
        offset: parseArithExprFromString(p, offsetStr),
        // Note: lengthStr can be "" (empty string after second colon like ${a::})
        // which should be treated as length 0, not "no length specified"
        length: lengthStr !== null ? parseArithExprFromString(p, lengthStr) : null
      },
      endIndex: wordEnd
    };
  }
  if ("-=?+".includes(char)) {
    i++;
    const wordEnd = findParameterOperationEnd(p, value, i);
    const wordStr = value.slice(i, wordEnd);
    const wordParts = parseWordParts(
      p,
      wordStr,
      false,
      false,
      true,
      // isAssignment=true for tilde expansion after : in default values
      false,
      quoted,
      false,
      // noBraceExpansion
      false,
      // regexPattern
      true
    );
    const word = AST.word(wordParts.length > 0 ? wordParts : [AST.literal("")]);
    if (char === "-") {
      return {
        operation: { type: "DefaultValue", word, checkEmpty: false },
        endIndex: wordEnd
      };
    }
    if (char === "=") {
      return {
        operation: { type: "AssignDefault", word, checkEmpty: false },
        endIndex: wordEnd
      };
    }
    if (char === "?") {
      return {
        operation: {
          type: "ErrorIfUnset",
          word: wordStr ? word : null,
          checkEmpty: false
        },
        endIndex: wordEnd
      };
    }
    if (char === "+") {
      return {
        operation: { type: "UseAlternative", word, checkEmpty: false },
        endIndex: wordEnd
      };
    }
  }
  if (char === "#" || char === "%") {
    const greedy = nextChar === char;
    const side = char === "#" ? "prefix" : "suffix";
    i += greedy ? 2 : 1;
    const patternEnd = findParameterOperationEnd(p, value, i);
    const patternStr = value.slice(i, patternEnd);
    const patternParts = parseWordParts(p, patternStr, false, false, false);
    const pattern = AST.word(patternParts.length > 0 ? patternParts : [AST.literal("")]);
    return {
      operation: { type: "PatternRemoval", pattern, side, greedy },
      endIndex: patternEnd
    };
  }
  if (char === "/") {
    const all = nextChar === "/";
    i += all ? 2 : 1;
    let anchor = null;
    if (value[i] === "#") {
      anchor = "start";
      i++;
    } else if (value[i] === "%") {
      anchor = "end";
      i++;
    }
    let patternEnd;
    if (anchor !== null && (value[i] === "/" || value[i] === "}")) {
      patternEnd = i;
    } else {
      patternEnd = findPatternEnd(p, value, i);
    }
    const patternStr = value.slice(i, patternEnd);
    const patternParts = parseWordParts(p, patternStr, false, false, false);
    const pattern = AST.word(patternParts.length > 0 ? patternParts : [AST.literal("")]);
    let replacement = null;
    let endIdx = patternEnd;
    if (value[patternEnd] === "/") {
      const replaceStart = patternEnd + 1;
      const replaceEnd = findParameterOperationEnd(p, value, replaceStart);
      const replaceStr = value.slice(replaceStart, replaceEnd);
      const replaceParts = parseWordParts(p, replaceStr, false, false, false);
      replacement = AST.word(replaceParts.length > 0 ? replaceParts : [AST.literal("")]);
      endIdx = replaceEnd;
    }
    return {
      operation: {
        type: "PatternReplacement",
        pattern,
        replacement,
        all,
        anchor
      },
      endIndex: endIdx
    };
  }
  if (char === "^" || char === ",") {
    const all = nextChar === char;
    const direction = char === "^" ? "upper" : "lower";
    i += all ? 2 : 1;
    const patternEnd = findParameterOperationEnd(p, value, i);
    const patternStr = value.slice(i, patternEnd);
    const pattern = patternStr ? AST.word([AST.literal(patternStr)]) : null;
    return {
      operation: {
        type: "CaseModification",
        direction,
        all,
        pattern
      },
      endIndex: patternEnd
    };
  }
  if (char === "@" && /[QPaAEKkuUL]/.test(nextChar)) {
    const operator = nextChar;
    return {
      operation: {
        type: "Transform",
        operator
      },
      endIndex: i + 2
    };
  }
  return { operation: null, endIndex: i };
}
__name(parseParameterOperation, "parseParameterOperation");
function parseExpansion(p, value, start, quoted = false) {
  const i = start + 1;
  if (i >= value.length) {
    return { part: AST.literal("$"), endIndex: i };
  }
  const char = value[i];
  if (char === "(" && value[i + 1] === "(") {
    if (p.isDollarDparenSubshell(value, start)) {
      return p.parseCommandSubstitution(value, start);
    }
    return p.parseArithmeticExpansion(value, start);
  }
  if (char === "[") {
    let depth = 1;
    let j = i + 1;
    while (j < value.length && depth > 0) {
      if (value[j] === "[")
        depth++;
      else if (value[j] === "]")
        depth--;
      if (depth > 0)
        j++;
    }
    if (depth === 0) {
      const expr = value.slice(i + 1, j);
      const arithExpr = parseArithmeticExpression(p, expr);
      return { part: AST.arithmeticExpansion(arithExpr), endIndex: j + 1 };
    }
  }
  if (char === "(") {
    return p.parseCommandSubstitution(value, start);
  }
  if (char === "{") {
    return parseParameterExpansion(p, value, start, quoted);
  }
  if (/[a-zA-Z_0-9@*#?$!-]/.test(char)) {
    return parseSimpleParameter(p, value, start);
  }
  return { part: AST.literal("$"), endIndex: i };
}
__name(parseExpansion, "parseExpansion");
function parseDoubleQuotedContent(p, value) {
  const parts = [];
  let i = 0;
  let literal = "";
  const flushLiteral = /* @__PURE__ */ __name(() => {
    if (literal) {
      parts.push(AST.literal(literal));
      literal = "";
    }
  }, "flushLiteral");
  while (i < value.length) {
    const char = value[i];
    if (char === "\\" && i + 1 < value.length) {
      const next = value[i + 1];
      if (next === "$" || next === "`" || next === '"' || next === "\\") {
        literal += next;
        i += 2;
        continue;
      }
      literal += char;
      i++;
      continue;
    }
    if (char === "$") {
      flushLiteral();
      const { part, endIndex } = parseExpansion(p, value, i, true);
      if (part) {
        parts.push(part);
      }
      i = endIndex;
      continue;
    }
    if (char === "`") {
      flushLiteral();
      const { part, endIndex } = p.parseBacktickSubstitution(value, i, true);
      parts.push(part);
      i = endIndex;
      continue;
    }
    literal += char;
    i++;
  }
  flushLiteral();
  return parts;
}
__name(parseDoubleQuotedContent, "parseDoubleQuotedContent");
function parseDoubleQuoted(p, value, start) {
  const innerParts = [];
  let i = start;
  let literal = "";
  const flushLiteral = /* @__PURE__ */ __name(() => {
    if (literal) {
      innerParts.push(AST.literal(literal));
      literal = "";
    }
  }, "flushLiteral");
  while (i < value.length && value[i] !== '"') {
    const char = value[i];
    if (char === "\\" && i + 1 < value.length) {
      const next = value[i + 1];
      if ('"\\$`\n'.includes(next)) {
        literal += next;
        i += 2;
        continue;
      }
      literal += char;
      i++;
      continue;
    }
    if (char === "$") {
      flushLiteral();
      const { part, endIndex } = parseExpansion(p, value, i, true);
      if (part) {
        innerParts.push(part);
      }
      i = endIndex;
      continue;
    }
    if (char === "`") {
      flushLiteral();
      const { part, endIndex } = p.parseBacktickSubstitution(value, i, true);
      innerParts.push(part);
      i = endIndex;
      continue;
    }
    literal += char;
    i++;
  }
  flushLiteral();
  return {
    part: AST.doubleQuoted(innerParts),
    endIndex: i
  };
}
__name(parseDoubleQuoted, "parseDoubleQuoted");
function parseWordParts(p, value, quoted = false, singleQuoted = false, isAssignment = false, hereDoc = false, singleQuotesAreLiteral = false, noBraceExpansion = false, regexPattern = false, inParameterExpansion = false) {
  if (singleQuoted) {
    return [AST.singleQuoted(value)];
  }
  if (quoted) {
    const innerParts = parseDoubleQuotedContent(p, value);
    return [AST.doubleQuoted(innerParts)];
  }
  if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
    const inner = value.slice(1, -1);
    let hasUnescapedQuote = false;
    for (let j = 0; j < inner.length; j++) {
      if (inner[j] === '"') {
        hasUnescapedQuote = true;
        break;
      }
      if (inner[j] === "\\" && j + 1 < inner.length) {
        j++;
      }
    }
    if (!hasUnescapedQuote) {
      const innerParts = parseDoubleQuotedContent(p, inner);
      return [AST.doubleQuoted(innerParts)];
    }
  }
  const parts = [];
  let i = 0;
  let literal = "";
  const flushLiteral = /* @__PURE__ */ __name(() => {
    if (literal) {
      parts.push(AST.literal(literal));
      literal = "";
    }
  }, "flushLiteral");
  while (i < value.length) {
    const char = value[i];
    if (char === "\\" && i + 1 < value.length) {
      const next = value[i + 1];
      if (regexPattern) {
        flushLiteral();
        parts.push(AST.escaped(next));
        i += 2;
        continue;
      }
      const isEscapable = hereDoc ? next === "$" || next === "`" || next === "\n" : next === "$" || next === "`" || next === '"' || next === "'" || next === "\n" || inParameterExpansion && next === "}";
      const isGlobMetaOrBackslash = singleQuotesAreLiteral ? "*?[]\\".includes(next) : "*?[]\\(){}.^+".includes(next);
      if (isEscapable) {
        literal += next;
      } else if (isGlobMetaOrBackslash) {
        flushLiteral();
        parts.push(AST.escaped(next));
      } else {
        literal += `\\${next}`;
      }
      i += 2;
      continue;
    }
    if (char === "'" && !singleQuotesAreLiteral && !hereDoc) {
      flushLiteral();
      const closeQuote = value.indexOf("'", i + 1);
      if (closeQuote === -1) {
        literal += value.slice(i);
        break;
      }
      parts.push(AST.singleQuoted(value.slice(i + 1, closeQuote)));
      i = closeQuote + 1;
      continue;
    }
    if (char === '"' && !hereDoc) {
      flushLiteral();
      const { part, endIndex } = parseDoubleQuoted(p, value, i + 1);
      parts.push(part);
      i = endIndex + 1;
      continue;
    }
    if (char === "$" && value[i + 1] === "'") {
      flushLiteral();
      const { part, endIndex } = parseAnsiCQuoted(p, value, i + 2);
      parts.push(part);
      i = endIndex;
      continue;
    }
    if (char === "$") {
      flushLiteral();
      const { part, endIndex } = parseExpansion(p, value, i);
      if (part) {
        parts.push(part);
      }
      i = endIndex;
      continue;
    }
    if (char === "`") {
      flushLiteral();
      const { part, endIndex } = p.parseBacktickSubstitution(value, i);
      parts.push(part);
      i = endIndex;
      continue;
    }
    if (char === "~") {
      const prevChar = i > 0 ? value[i - 1] : "";
      const canExpandAfterColon = isAssignment && prevChar === ":";
      if (i === 0 || prevChar === "=" || canExpandAfterColon) {
        const tildeEnd = findTildeEnd(p, value, i);
        const afterTilde = value[tildeEnd];
        if (afterTilde === void 0 || afterTilde === "/" || afterTilde === ":") {
          flushLiteral();
          const user = value.slice(i + 1, tildeEnd) || null;
          parts.push({ type: "TildeExpansion", user });
          i = tildeEnd;
          continue;
        }
      }
    }
    if ("@*+?!".includes(char) && i + 1 < value.length && value[i + 1] === "(") {
      const closeIdx = findExtglobClose(value, i + 1);
      if (closeIdx !== -1) {
        flushLiteral();
        const pattern = value.slice(i, closeIdx + 1);
        parts.push({ type: "Glob", pattern });
        i = closeIdx + 1;
        continue;
      }
    }
    if (char === "*" || char === "?" || char === "[") {
      flushLiteral();
      const { pattern, endIndex } = parseGlobPattern(p, value, i);
      parts.push({ type: "Glob", pattern });
      i = endIndex;
      continue;
    }
    if (char === "{" && !isAssignment && !noBraceExpansion) {
      const braceResult = tryParseBraceExpansion(p, value, i, parseWordParts);
      if (braceResult) {
        flushLiteral();
        parts.push(braceResult.part);
        i = braceResult.endIndex;
        continue;
      }
    }
    literal += char;
    i++;
  }
  flushLiteral();
  return parts;
}
__name(parseWordParts, "parseWordParts");

// dist/parser/parser-substitution.js
function isDollarDparenSubshell(value, start) {
  const len = value.length;
  let pos = start + 3;
  let depth = 2;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  while (pos < len && depth > 0) {
    const c = value[pos];
    if (inSingleQuote) {
      if (c === "'") {
        inSingleQuote = false;
      }
      pos++;
      continue;
    }
    if (inDoubleQuote) {
      if (c === "\\") {
        pos += 2;
        continue;
      }
      if (c === '"') {
        inDoubleQuote = false;
      }
      pos++;
      continue;
    }
    if (c === "'") {
      inSingleQuote = true;
      pos++;
      continue;
    }
    if (c === '"') {
      inDoubleQuote = true;
      pos++;
      continue;
    }
    if (c === "\\") {
      pos += 2;
      continue;
    }
    if (c === "(") {
      depth++;
      pos++;
      continue;
    }
    if (c === ")") {
      depth--;
      if (depth === 1) {
        const nextPos = pos + 1;
        if (nextPos < len && value[nextPos] === ")") {
          return false;
        }
        return true;
      }
      if (depth === 0) {
        return false;
      }
      pos++;
      continue;
    }
    if (depth === 1) {
      if (c === "|" && pos + 1 < len && value[pos + 1] === "|") {
        return true;
      }
      if (c === "&" && pos + 1 < len && value[pos + 1] === "&") {
        return true;
      }
      if (c === "|" && pos + 1 < len && value[pos + 1] !== "|") {
        return true;
      }
    }
    pos++;
  }
  return false;
}
__name(isDollarDparenSubshell, "isDollarDparenSubshell");
function parseCommandSubstitutionFromString(value, start, createParser, error) {
  const cmdStart = start + 2;
  let depth = 1;
  let i = cmdStart;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let caseDepth = 0;
  let inCasePattern = false;
  let wordBuffer = "";
  while (i < value.length && depth > 0) {
    const c = value[i];
    if (inSingleQuote) {
      if (c === "'")
        inSingleQuote = false;
    } else if (inDoubleQuote) {
      if (c === "\\" && i + 1 < value.length) {
        i++;
      } else if (c === '"') {
        inDoubleQuote = false;
      }
    } else {
      if (c === "'") {
        inSingleQuote = true;
        wordBuffer = "";
      } else if (c === '"') {
        inDoubleQuote = true;
        wordBuffer = "";
      } else if (c === "\\" && i + 1 < value.length) {
        i++;
        wordBuffer = "";
      } else if (/[a-zA-Z_]/.test(c)) {
        wordBuffer += c;
      } else {
        if (wordBuffer === "case") {
          caseDepth++;
          inCasePattern = false;
        } else if (wordBuffer === "in" && caseDepth > 0) {
          inCasePattern = true;
        } else if (wordBuffer === "esac" && caseDepth > 0) {
          caseDepth--;
          inCasePattern = false;
        }
        wordBuffer = "";
        if (c === "(") {
          if (i > 0 && value[i - 1] === "$") {
            depth++;
          } else if (!inCasePattern) {
            depth++;
          }
        } else if (c === ")") {
          if (inCasePattern) {
            inCasePattern = false;
          } else {
            depth--;
          }
        } else if (c === ";") {
          if (caseDepth > 0 && i + 1 < value.length && value[i + 1] === ";") {
            inCasePattern = true;
          }
        }
      }
    }
    if (depth > 0)
      i++;
  }
  if (depth > 0) {
    error("unexpected EOF while looking for matching `)'");
  }
  const cmdStr = value.slice(cmdStart, i);
  const nestedParser = createParser();
  const body = nestedParser.parse(cmdStr);
  return {
    part: AST.commandSubstitution(body, false),
    endIndex: i + 1
  };
}
__name(parseCommandSubstitutionFromString, "parseCommandSubstitutionFromString");
function parseBacktickSubstitutionFromString(value, start, inDoubleQuotes, createParser, error) {
  const cmdStart = start + 1;
  let i = cmdStart;
  let cmdStr = "";
  while (i < value.length && value[i] !== "`") {
    if (value[i] === "\\") {
      const next = value[i + 1];
      const isSpecial = next === "$" || next === "`" || next === "\\" || next === "\n" || inDoubleQuotes && next === '"';
      if (isSpecial) {
        if (next !== "\n") {
          cmdStr += next;
        }
        i += 2;
      } else {
        cmdStr += value[i];
        i++;
      }
    } else {
      cmdStr += value[i];
      i++;
    }
  }
  if (i >= value.length) {
    error("unexpected EOF while looking for matching ``'");
  }
  const nestedParser = createParser();
  const body = nestedParser.parse(cmdStr);
  return {
    part: AST.commandSubstitution(body, true),
    endIndex: i + 1
  };
}
__name(parseBacktickSubstitutionFromString, "parseBacktickSubstitutionFromString");

// dist/parser/parser.js
var Parser = class _Parser {
  static {
    __name(this, "Parser");
  }
  tokens = [];
  pos = 0;
  pendingHeredocs = [];
  parseIterations = 0;
  _input = "";
  /**
   * Get the raw input string being parsed.
   * Used by conditional-parser for extracting exact whitespace in regex patterns.
   */
  getInput() {
    return this._input;
  }
  /**
   * Check parse iteration limit to prevent infinite loops
   */
  checkIterationLimit() {
    this.parseIterations++;
    if (this.parseIterations > MAX_PARSE_ITERATIONS) {
      throw new ParseException("Maximum parse iterations exceeded (possible infinite loop)", this.current().line, this.current().column);
    }
  }
  /**
   * Parse a bash script string
   */
  parse(input) {
    if (input.length > MAX_INPUT_SIZE) {
      throw new ParseException(`Input too large: ${input.length} bytes exceeds limit of ${MAX_INPUT_SIZE}`, 1, 1);
    }
    this._input = input;
    const lexer = new Lexer(input);
    this.tokens = lexer.tokenize();
    if (this.tokens.length > MAX_TOKENS) {
      throw new ParseException(`Too many tokens: ${this.tokens.length} exceeds limit of ${MAX_TOKENS}`, 1, 1);
    }
    this.pos = 0;
    this.pendingHeredocs = [];
    this.parseIterations = 0;
    return this.parseScript();
  }
  /**
   * Parse from pre-tokenized input
   */
  parseTokens(tokens) {
    this.tokens = tokens;
    this.pos = 0;
    this.pendingHeredocs = [];
    return this.parseScript();
  }
  // ===========================================================================
  // HELPER METHODS
  // ===========================================================================
  current() {
    return this.tokens[this.pos] || this.tokens[this.tokens.length - 1];
  }
  peek(offset = 0) {
    return this.tokens[this.pos + offset] || this.tokens[this.tokens.length - 1];
  }
  advance() {
    const token = this.current();
    if (this.pos < this.tokens.length - 1) {
      this.pos++;
    }
    return token;
  }
  getPos() {
    return this.pos;
  }
  /**
   * Check if current token matches any of the given types.
   * Optimized to avoid array allocation for common cases (1-4 args).
   */
  check(t1, t2, t3, t4, ...rest) {
    const type = this.tokens[this.pos]?.type;
    if (type === t1)
      return true;
    if (t2 !== void 0 && type === t2)
      return true;
    if (t3 !== void 0 && type === t3)
      return true;
    if (t4 !== void 0 && type === t4)
      return true;
    if (rest.length > 0)
      return rest.includes(type);
    return false;
  }
  expect(type, message) {
    if (this.check(type)) {
      return this.advance();
    }
    const token = this.current();
    throw new ParseException(message || `Expected ${type}, got ${token.type}`, token.line, token.column, token);
  }
  error(message) {
    const token = this.current();
    throw new ParseException(message, token.line, token.column, token);
  }
  skipNewlines() {
    while (this.check(TokenType.NEWLINE, TokenType.COMMENT)) {
      if (this.check(TokenType.NEWLINE)) {
        this.advance();
        this.processHeredocs();
      } else {
        this.advance();
      }
    }
  }
  skipSeparators(includeCaseTerminators = true) {
    while (true) {
      if (this.check(TokenType.NEWLINE)) {
        this.advance();
        this.processHeredocs();
        continue;
      }
      if (this.check(TokenType.SEMICOLON, TokenType.COMMENT)) {
        this.advance();
        continue;
      }
      if (includeCaseTerminators && this.check(TokenType.DSEMI, TokenType.SEMI_AND, TokenType.SEMI_SEMI_AND)) {
        this.advance();
        continue;
      }
      break;
    }
  }
  addPendingHeredoc(redirect, delimiter, stripTabs, quoted) {
    this.pendingHeredocs.push({ redirect, delimiter, stripTabs, quoted });
  }
  processHeredocs() {
    for (const heredoc of this.pendingHeredocs) {
      if (this.check(TokenType.HEREDOC_CONTENT)) {
        const content = this.advance();
        let contentWord;
        if (heredoc.quoted) {
          contentWord = AST.word([AST.literal(content.value)]);
        } else {
          contentWord = this.parseWordFromString(content.value, false, false, false, true);
        }
        heredoc.redirect.target = AST.hereDoc(heredoc.delimiter, contentWord, heredoc.stripTabs, heredoc.quoted);
      }
    }
    this.pendingHeredocs = [];
  }
  isStatementEnd() {
    return this.check(TokenType.EOF, TokenType.NEWLINE, TokenType.SEMICOLON, TokenType.AMP, TokenType.AND_AND, TokenType.OR_OR, TokenType.RPAREN, TokenType.RBRACE, TokenType.DSEMI, TokenType.SEMI_AND, TokenType.SEMI_SEMI_AND);
  }
  isCommandStart() {
    const t = this.current().type;
    return t === TokenType.WORD || t === TokenType.NAME || t === TokenType.NUMBER || t === TokenType.ASSIGNMENT_WORD || t === TokenType.IF || t === TokenType.FOR || t === TokenType.WHILE || t === TokenType.UNTIL || t === TokenType.CASE || t === TokenType.LPAREN || t === TokenType.LBRACE || t === TokenType.DPAREN_START || t === TokenType.DBRACK_START || t === TokenType.FUNCTION || t === TokenType.BANG || // 'time' is a pipeline prefix that can start a command
    t === TokenType.TIME || // 'in' can appear as a command name (e.g., 'in' is not reserved outside for/case)
    t === TokenType.IN || // Redirections can appear before command name (e.g., <<EOF tac)
    // POSIX allows simple_command to start with io_redirect
    t === TokenType.LESS || t === TokenType.GREAT || t === TokenType.DLESS || t === TokenType.DGREAT || t === TokenType.LESSAND || t === TokenType.GREATAND || t === TokenType.LESSGREAT || t === TokenType.DLESSDASH || t === TokenType.CLOBBER || t === TokenType.TLESS || t === TokenType.AND_GREAT || t === TokenType.AND_DGREAT;
  }
  // ===========================================================================
  // SCRIPT PARSING
  // ===========================================================================
  parseScript() {
    const statements = [];
    const maxIterations = 1e4;
    let iterations = 0;
    this.skipNewlines();
    while (!this.check(TokenType.EOF)) {
      iterations++;
      if (iterations > maxIterations) {
        this.error(`Parser stuck: too many iterations (>${maxIterations})`);
      }
      const deferredErrorStmt = this.checkUnexpectedToken();
      if (deferredErrorStmt) {
        statements.push(deferredErrorStmt);
        this.skipSeparators(false);
        continue;
      }
      const posBefore = this.pos;
      const stmt = this.parseStatement();
      if (stmt) {
        statements.push(stmt);
      }
      this.skipSeparators(false);
      if (this.check(TokenType.DSEMI, TokenType.SEMI_AND, TokenType.SEMI_SEMI_AND)) {
        this.error(`syntax error near unexpected token \`${this.current().value}'`);
      }
      if (this.pos === posBefore && !this.check(TokenType.EOF)) {
        this.advance();
      }
    }
    return AST.script(statements);
  }
  /**
   * Check for unexpected tokens that can't appear at statement start.
   * Returns a deferred error statement for tokens that should cause errors
   * at execution time rather than parse time (to match bash's incremental behavior).
   */
  checkUnexpectedToken() {
    const t = this.current().type;
    const v = this.current().value;
    if (t === TokenType.DO || t === TokenType.DONE || t === TokenType.THEN || t === TokenType.ELSE || t === TokenType.ELIF || t === TokenType.FI || t === TokenType.ESAC) {
      this.error(`syntax error near unexpected token \`${v}'`);
    }
    if (t === TokenType.RBRACE || t === TokenType.RPAREN) {
      const errorMsg = `syntax error near unexpected token \`${v}'`;
      this.advance();
      return AST.statement([AST.pipeline([AST.simpleCommand(null, [], [], [])])], [], false, { message: errorMsg, token: v });
    }
    if (t === TokenType.DSEMI || t === TokenType.SEMI_AND || t === TokenType.SEMI_SEMI_AND) {
      this.error(`syntax error near unexpected token \`${v}'`);
    }
    if (t === TokenType.SEMICOLON) {
      this.error(`syntax error near unexpected token \`${v}'`);
    }
    if (t === TokenType.PIPE || t === TokenType.PIPE_AMP) {
      this.error(`syntax error near unexpected token \`${v}'`);
    }
    return null;
  }
  // ===========================================================================
  // STATEMENT PARSING
  // ===========================================================================
  parseStatement() {
    this.skipNewlines();
    if (!this.isCommandStart()) {
      return null;
    }
    const startOffset = this.current().start;
    const pipelines = [];
    const operators = [];
    let background = false;
    const firstPipeline = this.parsePipeline();
    pipelines.push(firstPipeline);
    while (this.check(TokenType.AND_AND, TokenType.OR_OR)) {
      const op = this.advance();
      operators.push(op.type === TokenType.AND_AND ? "&&" : "||");
      this.skipNewlines();
      const nextPipeline = this.parsePipeline();
      pipelines.push(nextPipeline);
    }
    if (this.check(TokenType.AMP)) {
      this.advance();
      background = true;
    }
    const endOffset = this.pos > 0 ? this.tokens[this.pos - 1].end : startOffset;
    const sourceText = this._input.slice(startOffset, endOffset);
    return AST.statement(pipelines, operators, background, void 0, sourceText);
  }
  // ===========================================================================
  // PIPELINE PARSING
  // ===========================================================================
  parsePipeline() {
    let timed = false;
    let timePosix = false;
    if (this.check(TokenType.TIME)) {
      this.advance();
      timed = true;
      if (this.check(TokenType.WORD, TokenType.NAME) && this.current().value === "-p") {
        this.advance();
        timePosix = true;
      }
    }
    let negationCount = 0;
    while (this.check(TokenType.BANG)) {
      this.advance();
      negationCount++;
    }
    const negated = negationCount % 2 === 1;
    const commands = [];
    const pipeStderr = [];
    const firstCmd = this.parseCommand();
    commands.push(firstCmd);
    while (this.check(TokenType.PIPE, TokenType.PIPE_AMP)) {
      const pipeToken = this.advance();
      this.skipNewlines();
      pipeStderr.push(pipeToken.type === TokenType.PIPE_AMP);
      const nextCmd = this.parseCommand();
      commands.push(nextCmd);
    }
    return AST.pipeline(commands, negated, timed, timePosix, pipeStderr.length > 0 ? pipeStderr : void 0);
  }
  // ===========================================================================
  // COMMAND PARSING
  // ===========================================================================
  parseCommand() {
    if (this.check(TokenType.IF)) {
      return parseIf(this);
    }
    if (this.check(TokenType.FOR)) {
      return parseFor(this);
    }
    if (this.check(TokenType.WHILE)) {
      return parseWhile(this);
    }
    if (this.check(TokenType.UNTIL)) {
      return parseUntil(this);
    }
    if (this.check(TokenType.CASE)) {
      return parseCase(this);
    }
    if (this.check(TokenType.LPAREN)) {
      return parseSubshell(this);
    }
    if (this.check(TokenType.LBRACE)) {
      return parseGroup(this);
    }
    if (this.check(TokenType.DPAREN_START)) {
      if (this.dparenClosesWithSpacedParens()) {
        return this.parseNestedSubshellsFromDparen();
      }
      return this.parseArithmeticCommand();
    }
    if (this.check(TokenType.DBRACK_START)) {
      return this.parseConditionalCommand();
    }
    if (this.check(TokenType.FUNCTION)) {
      return this.parseFunctionDef();
    }
    if (this.check(TokenType.NAME, TokenType.WORD) && this.peek(1).type === TokenType.LPAREN && this.peek(2).type === TokenType.RPAREN) {
      return this.parseFunctionDef();
    }
    return parseSimpleCommand(this);
  }
  /**
   * Scan ahead from current DPAREN_START to determine if it closes with ) )
   * (two separate RPAREN tokens) or )) (DPAREN_END token).
   * Returns true if it closes with ) ) (nested subshells case).
   */
  dparenClosesWithSpacedParens() {
    let depth = 1;
    let offset = 1;
    while (offset < this.tokens.length - this.pos) {
      const tok = this.peek(offset);
      if (tok.type === TokenType.EOF) {
        return false;
      }
      if (tok.type === TokenType.DPAREN_START || tok.type === TokenType.LPAREN) {
        depth++;
      } else if (tok.type === TokenType.DPAREN_END) {
        depth -= 2;
        if (depth <= 0) {
          return false;
        }
      } else if (tok.type === TokenType.RPAREN) {
        depth--;
        if (depth === 0) {
          const nextTok = this.peek(offset + 1);
          if (nextTok.type === TokenType.RPAREN) {
            return true;
          }
        }
      }
      offset++;
    }
    return false;
  }
  /**
   * Parse (( ... ) ) as nested subshells when we know it closes with ) ).
   * We've already determined via dparenClosesWithSpacedParens() that this
   * DPAREN_START should be treated as two LPAREN tokens.
   */
  parseNestedSubshellsFromDparen() {
    this.advance();
    const innerBody = this.parseCompoundList();
    this.expect(TokenType.RPAREN);
    this.expect(TokenType.RPAREN);
    const redirections = this.parseOptionalRedirections();
    const innerSubshell = AST.subshell(innerBody, []);
    return AST.subshell([AST.statement([AST.pipeline([innerSubshell], false, false, false)])], redirections);
  }
  // ===========================================================================
  // WORD PARSING
  // ===========================================================================
  isWord() {
    const t = this.current().type;
    return t === TokenType.WORD || t === TokenType.NAME || t === TokenType.NUMBER || // Reserved words can be used as words in certain contexts (e.g., "echo if")
    t === TokenType.IF || t === TokenType.FOR || t === TokenType.WHILE || t === TokenType.UNTIL || t === TokenType.CASE || t === TokenType.FUNCTION || t === TokenType.ELSE || t === TokenType.ELIF || t === TokenType.FI || t === TokenType.THEN || t === TokenType.DO || t === TokenType.DONE || t === TokenType.ESAC || t === TokenType.IN || t === TokenType.SELECT || t === TokenType.TIME || t === TokenType.COPROC || // Operators that can appear as words in command arguments (e.g., "[ ! -z foo ]")
    t === TokenType.BANG;
  }
  parseWord() {
    const token = this.advance();
    return this.parseWordFromString(token.value, token.quoted, token.singleQuoted);
  }
  /**
   * Parse a word without brace expansion (for [[ ]] conditionals).
   * In bash, brace expansion does not occur inside [[ ]].
   */
  parseWordNoBraceExpansion() {
    const token = this.advance();
    return this.parseWordFromString(
      token.value,
      token.quoted,
      token.singleQuoted,
      false,
      // isAssignment
      false,
      // hereDoc
      true
    );
  }
  /**
   * Parse a word for regex patterns (in [[ =~ ]]).
   * All escaped characters create Escaped nodes so the backslash is preserved
   * for the regex engine. For example, \$ creates Escaped("$") which becomes \$
   * in the final regex pattern.
   */
  parseWordForRegex() {
    const token = this.advance();
    return this.parseWordFromString(
      token.value,
      token.quoted,
      token.singleQuoted,
      false,
      // isAssignment
      false,
      // hereDoc
      true,
      // noBraceExpansion
      true
    );
  }
  parseWordFromString(value, quoted = false, singleQuoted = false, isAssignment = false, hereDoc = false, noBraceExpansion = false, regexPattern = false) {
    const parts = parseWordParts(
      this,
      value,
      quoted,
      singleQuoted,
      isAssignment,
      hereDoc,
      false,
      // singleQuotesAreLiteral
      noBraceExpansion,
      regexPattern
    );
    return AST.word(parts);
  }
  parseCommandSubstitution(value, start) {
    return parseCommandSubstitutionFromString(value, start, () => new _Parser(), (msg) => this.error(msg));
  }
  parseBacktickSubstitution(value, start, inDoubleQuotes = false) {
    return parseBacktickSubstitutionFromString(value, start, inDoubleQuotes, () => new _Parser(), (msg) => this.error(msg));
  }
  /**
   * Check if $(( at position `start` in `value` is a command substitution with nested
   * subshell rather than arithmetic expansion.
   */
  isDollarDparenSubshell(value, start) {
    return isDollarDparenSubshell(value, start);
  }
  parseArithmeticExpansion(value, start) {
    const exprStart = start + 3;
    let arithDepth = 1;
    let parenDepth = 0;
    let i = exprStart;
    while (i < value.length - 1 && arithDepth > 0) {
      if (value[i] === "$" && value[i + 1] === "(") {
        if (value[i + 2] === "(") {
          arithDepth++;
          i += 3;
        } else {
          parenDepth++;
          i += 2;
        }
      } else if (value[i] === "(" && value[i + 1] === "(") {
        arithDepth++;
        i += 2;
      } else if (value[i] === ")" && value[i + 1] === ")") {
        if (parenDepth > 0) {
          parenDepth--;
          i++;
        } else {
          arithDepth--;
          if (arithDepth > 0)
            i += 2;
        }
      } else if (value[i] === "(") {
        parenDepth++;
        i++;
      } else if (value[i] === ")") {
        if (parenDepth > 0) {
          parenDepth--;
        }
        i++;
      } else {
        i++;
      }
    }
    const exprStr = value.slice(exprStart, i);
    const expression = this.parseArithmeticExpression(exprStr);
    return {
      part: AST.arithmeticExpansion(expression),
      endIndex: i + 2
    };
  }
  parseArithmeticCommand() {
    const startToken = this.expect(TokenType.DPAREN_START);
    let exprStr = "";
    let dparenDepth = 1;
    let parenDepth = 0;
    let pendingRparen = false;
    let foundClosing = false;
    while (dparenDepth > 0 && !this.check(TokenType.EOF)) {
      if (pendingRparen) {
        pendingRparen = false;
        if (parenDepth > 0) {
          parenDepth--;
          exprStr += ")";
          continue;
        }
        if (this.check(TokenType.RPAREN)) {
          dparenDepth--;
          foundClosing = true;
          this.advance();
          continue;
        }
        if (this.check(TokenType.DPAREN_END)) {
          dparenDepth--;
          foundClosing = true;
          continue;
        }
        exprStr += ")";
        continue;
      }
      if (this.check(TokenType.DPAREN_START)) {
        dparenDepth++;
        exprStr += "((";
        this.advance();
      } else if (this.check(TokenType.DPAREN_END)) {
        if (parenDepth >= 2) {
          parenDepth -= 2;
          exprStr += "))";
          this.advance();
        } else if (parenDepth === 1) {
          parenDepth--;
          exprStr += ")";
          pendingRparen = true;
          this.advance();
        } else {
          dparenDepth--;
          foundClosing = true;
          if (dparenDepth > 0) {
            exprStr += "))";
          }
          this.advance();
        }
      } else if (this.check(TokenType.LPAREN)) {
        parenDepth++;
        exprStr += "(";
        this.advance();
      } else if (this.check(TokenType.RPAREN)) {
        if (parenDepth > 0) {
          parenDepth--;
        }
        exprStr += ")";
        this.advance();
      } else {
        const value = this.current().value;
        const lastChar = exprStr.length > 0 ? exprStr[exprStr.length - 1] : "";
        const needsSpace = exprStr.length > 0 && !exprStr.endsWith(" ") && // Don't add space before = after operators that can form compound assignments
        !(value === "=" && /[|&^+\-*/%<>]$/.test(exprStr)) && // Don't add space before second < or > (for << or >>)
        !(value === "<" && lastChar === "<") && !(value === ">" && lastChar === ">");
        if (needsSpace) {
          exprStr += " ";
        }
        exprStr += value;
        this.advance();
      }
    }
    if (!foundClosing) {
      this.expect(TokenType.DPAREN_END);
    }
    const expression = this.parseArithmeticExpression(exprStr.trim());
    const redirections = this.parseOptionalRedirections();
    return AST.arithmeticCommand(expression, redirections, startToken.line);
  }
  parseConditionalCommand() {
    const startToken = this.expect(TokenType.DBRACK_START);
    const expression = parseConditionalExpression(this);
    this.expect(TokenType.DBRACK_END);
    const redirections = this.parseOptionalRedirections();
    return AST.conditionalCommand(expression, redirections, startToken.line);
  }
  parseFunctionDef() {
    let name;
    if (this.check(TokenType.FUNCTION)) {
      this.advance();
      if (this.check(TokenType.NAME) || this.check(TokenType.WORD)) {
        name = this.advance().value;
      } else {
        const token = this.current();
        throw new ParseException("Expected function name", token.line, token.column, token);
      }
      if (this.check(TokenType.LPAREN)) {
        this.advance();
        this.expect(TokenType.RPAREN);
      }
    } else {
      name = this.advance().value;
      if (name.includes("$")) {
        this.error(`\`${name}': not a valid identifier`);
      }
      this.expect(TokenType.LPAREN);
      this.expect(TokenType.RPAREN);
    }
    this.skipNewlines();
    const body = this.parseCompoundCommandBody({ forFunctionBody: true });
    const redirections = this.parseOptionalRedirections();
    return AST.functionDef(name, body, redirections);
  }
  parseCompoundCommandBody(options) {
    const skipRedirections = options?.forFunctionBody;
    if (this.check(TokenType.LBRACE)) {
      return parseGroup(this, { skipRedirections });
    }
    if (this.check(TokenType.LPAREN)) {
      return parseSubshell(this, { skipRedirections });
    }
    if (this.check(TokenType.IF)) {
      return parseIf(this, { skipRedirections });
    }
    if (this.check(TokenType.FOR)) {
      return parseFor(this, { skipRedirections });
    }
    if (this.check(TokenType.WHILE)) {
      return parseWhile(this, { skipRedirections });
    }
    if (this.check(TokenType.UNTIL)) {
      return parseUntil(this, { skipRedirections });
    }
    if (this.check(TokenType.CASE)) {
      return parseCase(this, { skipRedirections });
    }
    this.error("Expected compound command for function body");
  }
  // ===========================================================================
  // HELPER PARSING
  // ===========================================================================
  parseCompoundList() {
    const statements = [];
    this.skipNewlines();
    while (!this.check(TokenType.EOF, TokenType.FI, TokenType.ELSE, TokenType.ELIF, TokenType.THEN, TokenType.DO, TokenType.DONE, TokenType.ESAC, TokenType.RPAREN, TokenType.RBRACE, TokenType.DSEMI, TokenType.SEMI_AND, TokenType.SEMI_SEMI_AND) && this.isCommandStart()) {
      this.checkIterationLimit();
      const posBefore = this.pos;
      const stmt = this.parseStatement();
      if (stmt) {
        statements.push(stmt);
      }
      this.skipSeparators();
      if (this.pos === posBefore && !stmt) {
        break;
      }
    }
    return statements;
  }
  parseOptionalRedirections() {
    const redirections = [];
    while (isRedirection(this)) {
      this.checkIterationLimit();
      const posBefore = this.pos;
      redirections.push(parseRedirection(this));
      if (this.pos === posBefore) {
        break;
      }
    }
    return redirections;
  }
  // ===========================================================================
  // ARITHMETIC EXPRESSION PARSING
  // ===========================================================================
  parseArithmeticExpression(input) {
    return parseArithmeticExpression(this, input);
  }
};
function parse(input) {
  const parser = new Parser();
  return parser.parse(input);
}
__name(parse, "parse");

// dist/shell/glob-to-regex.js
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
  xdigit: "0-9a-fA-F"
};
function posixClassToRegex(className) {
  return POSIX_CLASSES[className] || "";
}
__name(posixClassToRegex, "posixClassToRegex");
function splitGlobignorePatterns(globignore) {
  const patterns = [];
  let current = "";
  let i = 0;
  while (i < globignore.length) {
    const c = globignore[i];
    if (c === "[") {
      current += c;
      i++;
      if (i < globignore.length && (globignore[i] === "!" || globignore[i] === "^")) {
        current += globignore[i];
        i++;
      }
      if (i < globignore.length && globignore[i] === "]") {
        current += globignore[i];
        i++;
      }
      while (i < globignore.length && globignore[i] !== "]") {
        if (globignore[i] === "[" && i + 1 < globignore.length && globignore[i + 1] === ":") {
          const posixEnd = globignore.indexOf(":]", i + 2);
          if (posixEnd !== -1) {
            current += globignore.slice(i, posixEnd + 2);
            i = posixEnd + 2;
            continue;
          }
        }
        if (globignore[i] === "\\" && i + 1 < globignore.length) {
          current += globignore[i] + globignore[i + 1];
          i += 2;
          continue;
        }
        current += globignore[i];
        i++;
      }
      if (i < globignore.length && globignore[i] === "]") {
        current += globignore[i];
        i++;
      }
    } else if (c === ":") {
      if (current !== "") {
        patterns.push(current);
      }
      current = "";
      i++;
    } else if (c === "\\" && i + 1 < globignore.length) {
      current += c + globignore[i + 1];
      i += 2;
    } else {
      current += c;
      i++;
    }
  }
  if (current !== "") {
    patterns.push(current);
  }
  return patterns;
}
__name(splitGlobignorePatterns, "splitGlobignorePatterns");
function globignorePatternToRegex(pattern) {
  let regex = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      regex += "[^/]*";
    } else if (c === "?") {
      regex += "[^/]";
    } else if (c === "[") {
      let j = i + 1;
      let classContent = "[";
      if (j < pattern.length && (pattern[j] === "^" || pattern[j] === "!")) {
        classContent += "^";
        j++;
      }
      if (j < pattern.length && pattern[j] === "]") {
        classContent += "\\]";
        j++;
      }
      let classEnd = j;
      while (classEnd < pattern.length) {
        if (pattern[classEnd] === "\\" && classEnd + 1 < pattern.length) {
          classEnd += 2;
          continue;
        }
        if (pattern[classEnd] === "[" && classEnd + 1 < pattern.length && pattern[classEnd + 1] === ":") {
          const posixEnd = pattern.indexOf(":]", classEnd + 2);
          if (posixEnd !== -1) {
            classEnd = posixEnd + 2;
            continue;
          }
        }
        if (pattern[classEnd] === "]") {
          break;
        }
        classEnd++;
      }
      const classStartPos = j;
      while (j < pattern.length && pattern[j] !== "]") {
        if (pattern[j] === "[" && j + 1 < pattern.length && pattern[j + 1] === ":") {
          const posixEnd = pattern.indexOf(":]", j + 2);
          if (posixEnd !== -1) {
            const posixClass = pattern.slice(j + 2, posixEnd);
            const regexClass = posixClassToRegex(posixClass);
            classContent += regexClass;
            j = posixEnd + 2;
            continue;
          }
        }
        if (pattern[j] === "\\" && j + 1 < pattern.length) {
          classContent += `\\${pattern[j + 1]}`;
          j += 2;
          continue;
        }
        if (pattern[j] === "-") {
          const atStart = j === classStartPos;
          const atEnd = j + 1 === classEnd;
          if (atStart || atEnd) {
            classContent += "\\-";
          } else {
            classContent += "-";
          }
        } else {
          classContent += pattern[j];
        }
        j++;
      }
      classContent += "]";
      regex += classContent;
      i = j;
    } else if (c === "\\" && i + 1 < pattern.length) {
      const nextChar = pattern[i + 1];
      if (/[.+^${}()|\\*?[\]]/.test(nextChar)) {
        regex += `\\${nextChar}`;
      } else {
        regex += nextChar;
      }
      i++;
    } else if (/[.+^${}()|]/.test(c)) {
      regex += `\\${c}`;
    } else {
      regex += c;
    }
  }
  regex += "$";
  return new RegExp(regex);
}
__name(globignorePatternToRegex, "globignorePatternToRegex");
function findMatchingParen(pattern, openIdx) {
  let depth = 1;
  let i = openIdx + 1;
  while (i < pattern.length && depth > 0) {
    const c = pattern[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "(") {
      depth++;
    } else if (c === ")") {
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
function splitExtglobAlternatives(content) {
  const alternatives = [];
  let current = "";
  let depth = 0;
  let inSingleQuote = false;
  let i = 0;
  while (i < content.length) {
    const c = content[i];
    if (c === "'" && !inSingleQuote) {
      inSingleQuote = true;
      current += "\0QUOTE_START\0";
      i++;
      continue;
    }
    if (c === "'" && inSingleQuote) {
      inSingleQuote = false;
      current += "\0QUOTE_END\0";
      i++;
      continue;
    }
    if (inSingleQuote) {
      current += c;
      i++;
      continue;
    }
    if (c === "\\") {
      current += c;
      if (i + 1 < content.length) {
        current += content[i + 1];
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    if (c === "(") {
      depth++;
      current += c;
    } else if (c === ")") {
      depth--;
      current += c;
    } else if (c === "|" && depth === 0) {
      alternatives.push(current);
      current = "";
    } else {
      current += c;
    }
    i++;
  }
  alternatives.push(current);
  return alternatives;
}
__name(splitExtglobAlternatives, "splitExtglobAlternatives");

// dist/shell/glob.js
var GlobExpander = class {
  static {
    __name(this, "GlobExpander");
  }
  fs;
  cwd;
  globignorePatterns = [];
  hasGlobignore = false;
  globstar = false;
  nullglob = false;
  failglob = false;
  dotglob = false;
  extglob = false;
  globskipdots = true;
  // Default to true in bash >=5.2
  constructor(fs, cwd, env, options) {
    this.fs = fs;
    this.cwd = cwd;
    if (typeof options === "boolean") {
      this.globstar = options;
    } else if (options) {
      this.globstar = options.globstar ?? false;
      this.nullglob = options.nullglob ?? false;
      this.failglob = options.failglob ?? false;
      this.dotglob = options.dotglob ?? false;
      this.extglob = options.extglob ?? false;
      this.globskipdots = options.globskipdots ?? true;
    }
    const globignore = env?.GLOBIGNORE;
    if (globignore !== void 0 && globignore !== "") {
      this.hasGlobignore = true;
      this.globignorePatterns = splitGlobignorePatterns(globignore);
    }
  }
  /**
   * Check if nullglob is enabled (return empty for non-matching patterns)
   */
  hasNullglob() {
    return this.nullglob;
  }
  /**
   * Check if failglob is enabled (throw error for non-matching patterns)
   */
  hasFailglob() {
    return this.failglob;
  }
  /**
   * Filter results based on GLOBIGNORE patterns and globskipdots option
   * When GLOBIGNORE is set, . and .. are always filtered
   * When globskipdots is enabled (default in bash >=5.2), . and .. are also filtered
   */
  filterGlobignore(results) {
    if (!this.hasGlobignore && !this.globskipdots) {
      return results;
    }
    return results.filter((path) => {
      const basename = path.split("/").pop() || path;
      if ((this.hasGlobignore || this.globskipdots) && (basename === "." || basename === "..")) {
        return false;
      }
      if (this.hasGlobignore) {
        for (const ignorePattern of this.globignorePatterns) {
          if (this.matchGlobignorePattern(path, ignorePattern)) {
            return false;
          }
        }
      }
      return true;
    });
  }
  /**
   * Match a path against a GLOBIGNORE pattern
   * GLOBIGNORE patterns are matched against the complete result path.
   * Unlike regular glob matching, * does NOT match / in GLOBIGNORE patterns.
   * This means *.txt filters "foo.txt" but NOT "dir/foo.txt".
   */
  matchGlobignorePattern(path, pattern) {
    const regex = globignorePatternToRegex(pattern);
    return regex.test(path);
  }
  /**
   * Check if a string contains glob characters
   */
  isGlobPattern(str) {
    if (str.includes("*") || str.includes("?") || /\[.*\]/.test(str)) {
      return true;
    }
    if (this.extglob && /[@*+?!]\(/.test(str)) {
      return true;
    }
    return false;
  }
  /**
   * Expand an array of arguments, replacing glob patterns with matched files
   * @param args - Array of argument strings
   * @param quotedFlags - Optional array indicating which args were quoted (should not expand)
   */
  async expandArgs(args, quotedFlags) {
    const expansionPromises = args.map((arg, i) => {
      const isQuoted = quotedFlags?.[i] ?? false;
      if (isQuoted || !this.isGlobPattern(arg)) {
        return null;
      }
      return this.expand(arg);
    });
    const expandedResults = await Promise.all(expansionPromises.map((p) => p ? p : Promise.resolve(null)));
    const result = [];
    for (let i = 0; i < args.length; i++) {
      const expanded = expandedResults[i];
      if (expanded === null) {
        result.push(args[i]);
      } else if (expanded.length > 0) {
        result.push(...expanded);
      } else {
        result.push(args[i]);
      }
    }
    return result;
  }
  /**
   * Expand a single glob pattern
   */
  async expand(pattern) {
    let results;
    if (pattern.includes("**") && this.globstar && this.isGlobstarValid(pattern)) {
      results = await this.expandRecursive(pattern);
    } else {
      const normalizedPattern = pattern.replace(/\*\*+/g, "*");
      results = await this.expandSimple(normalizedPattern);
    }
    return this.filterGlobignore(results);
  }
  /**
   * Check if ** is used as a complete path segment (not adjacent to other chars).
   * ** only recurses when it appears as a standalone segment like:
   *   - ** at start
   *   - / ** / in middle (no spaces)
   *   - / ** at end (no spaces)
   * NOT when adjacent to other characters like d** or **y
   */
  isGlobstarValid(pattern) {
    const segments = pattern.split("/");
    for (const segment of segments) {
      if (segment.includes("**")) {
        if (segment !== "**") {
          return false;
        }
      }
    }
    return true;
  }
  /**
   * Check if a path segment contains glob characters
   */
  hasGlobChars(str) {
    if (str.includes("*") || str.includes("?") || /\[.*\]/.test(str)) {
      return true;
    }
    if (this.extglob && /[@*+?!]\(/.test(str)) {
      return true;
    }
    return false;
  }
  /**
   * Expand a simple glob pattern (no **).
   * Handles multi-segment patterns like /dm/star/star.json
   */
  async expandSimple(pattern) {
    const isAbsolute = pattern.startsWith("/");
    const segments = pattern.split("/").filter((s) => s !== "");
    let firstGlobIndex = -1;
    for (let i = 0; i < segments.length; i++) {
      if (this.hasGlobChars(segments[i])) {
        firstGlobIndex = i;
        break;
      }
    }
    if (firstGlobIndex === -1) {
      return [pattern];
    }
    let fsBasePath;
    let resultPrefix;
    if (firstGlobIndex === 0) {
      if (isAbsolute) {
        fsBasePath = "/";
        resultPrefix = "/";
      } else {
        fsBasePath = this.cwd;
        resultPrefix = "";
      }
    } else {
      const baseSegments = segments.slice(0, firstGlobIndex);
      if (isAbsolute) {
        fsBasePath = `/${baseSegments.join("/")}`;
        resultPrefix = `/${baseSegments.join("/")}`;
      } else {
        fsBasePath = this.fs.resolvePath(this.cwd, baseSegments.join("/"));
        resultPrefix = baseSegments.join("/");
      }
    }
    const remainingSegments = segments.slice(firstGlobIndex);
    const results = await this.expandSegments(fsBasePath, resultPrefix, remainingSegments);
    return results.sort();
  }
  /**
   * Recursively expand path segments with glob patterns
   * @param fsPath - The actual filesystem path to read from
   * @param resultPrefix - The prefix to use when building result paths
   * @param segments - Remaining glob segments to match
   */
  async expandSegments(fsPath, resultPrefix, segments) {
    if (segments.length === 0) {
      return [resultPrefix];
    }
    const [currentSegment, ...remainingSegments] = segments;
    const results = [];
    try {
      if (this.fs.readdirWithFileTypes) {
        const entriesWithTypes = await this.fs.readdirWithFileTypes(fsPath);
        const matchPromises = [];
        const allEntries = [...entriesWithTypes];
        const effectiveDotglob = this.dotglob || this.hasGlobignore;
        if (currentSegment.startsWith(".") || this.dotglob) {
          const hasCurrentDir = entriesWithTypes.some((e) => e.name === ".");
          const hasParentDir = entriesWithTypes.some((e) => e.name === "..");
          if (!hasCurrentDir) {
            allEntries.push({
              name: ".",
              isFile: false,
              isDirectory: true,
              isSymbolicLink: false
            });
          }
          if (!hasParentDir) {
            allEntries.push({
              name: "..",
              isFile: false,
              isDirectory: true,
              isSymbolicLink: false
            });
          }
        }
        for (const entry of allEntries) {
          if (entry.name.startsWith(".") && !currentSegment.startsWith(".") && !effectiveDotglob) {
            continue;
          }
          if (this.matchPattern(entry.name, currentSegment)) {
            const newFsPath = fsPath === "/" ? `/${entry.name}` : `${fsPath}/${entry.name}`;
            let newResultPrefix;
            if (resultPrefix === "") {
              newResultPrefix = entry.name;
            } else if (resultPrefix === "/") {
              newResultPrefix = `/${entry.name}`;
            } else {
              newResultPrefix = `${resultPrefix}/${entry.name}`;
            }
            if (remainingSegments.length === 0) {
              matchPromises.push(Promise.resolve([newResultPrefix]));
            } else if (entry.isDirectory) {
              matchPromises.push(this.expandSegments(newFsPath, newResultPrefix, remainingSegments));
            }
          }
        }
        const allResults = await Promise.all(matchPromises);
        for (const pathList of allResults) {
          results.push(...pathList);
        }
      } else {
        const entries = await this.fs.readdir(fsPath);
        const matchPromises = [];
        const allEntries = [...entries];
        const effectiveDotglobFallback = this.dotglob || this.hasGlobignore;
        if (currentSegment.startsWith(".") || this.dotglob) {
          if (!entries.includes(".")) {
            allEntries.push(".");
          }
          if (!entries.includes("..")) {
            allEntries.push("..");
          }
        }
        for (const entry of allEntries) {
          if (entry.startsWith(".") && !currentSegment.startsWith(".") && !effectiveDotglobFallback) {
            continue;
          }
          if (this.matchPattern(entry, currentSegment)) {
            const newFsPath = fsPath === "/" ? `/${entry}` : `${fsPath}/${entry}`;
            let newResultPrefix;
            if (resultPrefix === "") {
              newResultPrefix = entry;
            } else if (resultPrefix === "/") {
              newResultPrefix = `/${entry}`;
            } else {
              newResultPrefix = `${resultPrefix}/${entry}`;
            }
            if (remainingSegments.length === 0) {
              matchPromises.push(Promise.resolve([newResultPrefix]));
            } else {
              matchPromises.push((async () => {
                try {
                  const stat = await this.fs.stat(newFsPath);
                  if (stat.isDirectory) {
                    return this.expandSegments(newFsPath, newResultPrefix, remainingSegments);
                  }
                } catch {
                }
                return [];
              })());
            }
          }
        }
        const allResults = await Promise.all(matchPromises);
        for (const pathList of allResults) {
          results.push(...pathList);
        }
      }
    } catch {
    }
    return results;
  }
  /**
   * Expand a recursive glob pattern (contains **)
   */
  async expandRecursive(pattern) {
    const results = [];
    const doubleStarIndex = pattern.indexOf("**");
    const beforeDoubleStar = pattern.slice(0, doubleStarIndex).replace(/\/$/, "") || ".";
    const afterDoubleStar = pattern.slice(doubleStarIndex + 2);
    const filePattern = afterDoubleStar.replace(/^\//, "");
    if (filePattern.includes("**") && this.isGlobstarValid(filePattern)) {
      await this.walkDirectoryMultiGlobstar(beforeDoubleStar, filePattern, results);
      const unique = [...new Set(results)];
      return unique.sort();
    } else {
      await this.walkDirectory(beforeDoubleStar, filePattern, results);
    }
    return results.sort();
  }
  /**
   * Walk directory for patterns with multiple globstar (like dir/star-star/subdir/star-star/etc)
   * At each directory level, recursively expand the sub-pattern that contains globstar
   */
  async walkDirectoryMultiGlobstar(dir, subPattern, results) {
    const fullPath = this.fs.resolvePath(this.cwd, dir);
    try {
      const entriesWithTypes = this.fs.readdirWithFileTypes ? await this.fs.readdirWithFileTypes(fullPath) : null;
      if (entriesWithTypes) {
        const dirs = [];
        for (const entry of entriesWithTypes) {
          const entryPath = dir === "." ? entry.name : `${dir}/${entry.name}`;
          if (entry.isDirectory) {
            dirs.push(entryPath);
          }
        }
        const patternFromHere = dir === "." ? subPattern : `${dir}/${subPattern}`;
        const subResults = await this.expandRecursive(patternFromHere);
        results.push(...subResults);
        for (let i = 0; i < dirs.length; i += DEFAULT_BATCH_SIZE) {
          const batch = dirs.slice(i, i + DEFAULT_BATCH_SIZE);
          await Promise.all(batch.map((dirPath) => this.walkDirectoryMultiGlobstar(dirPath, subPattern, results)));
        }
      } else {
        const entries = await this.fs.readdir(fullPath);
        const dirs = [];
        for (const entry of entries) {
          const entryPath = dir === "." ? entry : `${dir}/${entry}`;
          const fullEntryPath = this.fs.resolvePath(this.cwd, entryPath);
          try {
            const stat = await this.fs.stat(fullEntryPath);
            if (stat.isDirectory) {
              dirs.push(entryPath);
            }
          } catch {
          }
        }
        const patternFromHere = dir === "." ? subPattern : `${dir}/${subPattern}`;
        const subResults = await this.expandRecursive(patternFromHere);
        results.push(...subResults);
        for (let i = 0; i < dirs.length; i += DEFAULT_BATCH_SIZE) {
          const batch = dirs.slice(i, i + DEFAULT_BATCH_SIZE);
          await Promise.all(batch.map((dirPath) => this.walkDirectoryMultiGlobstar(dirPath, subPattern, results)));
        }
      }
    } catch {
    }
  }
  /**
   * Recursively walk a directory and collect matching files
   */
  async walkDirectory(dir, filePattern, results) {
    const fullPath = this.fs.resolvePath(this.cwd, dir);
    try {
      if (this.fs.readdirWithFileTypes) {
        const entriesWithTypes = await this.fs.readdirWithFileTypes(fullPath);
        const files = [];
        const dirs = [];
        for (const entry of entriesWithTypes) {
          const entryPath = dir === "." ? entry.name : `${dir}/${entry.name}`;
          if (entry.isDirectory) {
            dirs.push(entryPath);
          } else if (filePattern && this.matchPattern(entry.name, filePattern)) {
            files.push(entryPath);
          }
        }
        results.push(...files);
        for (let i = 0; i < dirs.length; i += DEFAULT_BATCH_SIZE) {
          const batch = dirs.slice(i, i + DEFAULT_BATCH_SIZE);
          await Promise.all(batch.map((dirPath) => this.walkDirectory(dirPath, filePattern, results)));
        }
      } else {
        const entries = await this.fs.readdir(fullPath);
        const entryInfos = [];
        for (let i = 0; i < entries.length; i += DEFAULT_BATCH_SIZE) {
          const batch = entries.slice(i, i + DEFAULT_BATCH_SIZE);
          const batchResults = await Promise.all(batch.map(async (entry) => {
            const entryPath = dir === "." ? entry : `${dir}/${entry}`;
            const fullEntryPath = this.fs.resolvePath(this.cwd, entryPath);
            try {
              const stat = await this.fs.stat(fullEntryPath);
              return {
                name: entry,
                path: entryPath,
                isDirectory: stat.isDirectory
              };
            } catch {
              return null;
            }
          }));
          entryInfos.push(...batchResults.filter((r) => r !== null));
        }
        for (const entry of entryInfos) {
          if (!entry.isDirectory && filePattern) {
            if (this.matchPattern(entry.name, filePattern)) {
              results.push(entry.path);
            }
          }
        }
        const dirs = entryInfos.filter((e) => e.isDirectory);
        for (let i = 0; i < dirs.length; i += DEFAULT_BATCH_SIZE) {
          const batch = dirs.slice(i, i + DEFAULT_BATCH_SIZE);
          await Promise.all(batch.map((entry) => this.walkDirectory(entry.path, filePattern, results)));
        }
      }
    } catch {
    }
  }
  /**
   * Match a filename against a glob pattern
   */
  matchPattern(name, pattern) {
    const regex = this.patternToRegex(pattern);
    return regex.test(name);
  }
  /**
   * Convert a glob pattern to a RegExp
   */
  patternToRegex(pattern) {
    const regex = this.patternToRegexStr(pattern);
    return new RegExp(`^${regex}$`);
  }
  /**
   * Convert a glob pattern to a regex string (without anchors)
   */
  patternToRegexStr(pattern) {
    let regex = "";
    let inQuotedSection = false;
    for (let i = 0; i < pattern.length; i++) {
      if (pattern.slice(i, i + 13) === "\0QUOTE_START\0") {
        inQuotedSection = true;
        i += 12;
        continue;
      }
      if (pattern.slice(i, i + 11) === "\0QUOTE_END\0") {
        inQuotedSection = false;
        i += 10;
        continue;
      }
      const c = pattern[i];
      if (inQuotedSection) {
        if (/[.+^${}()|\\*?[\]]/.test(c)) {
          regex += `\\${c}`;
        } else {
          regex += c;
        }
        continue;
      }
      if (this.extglob && (c === "@" || c === "*" || c === "+" || c === "?" || c === "!") && i + 1 < pattern.length && pattern[i + 1] === "(") {
        const closeIdx = findMatchingParen(pattern, i + 1);
        if (closeIdx !== -1) {
          const content = pattern.slice(i + 2, closeIdx);
          const alternatives = splitExtglobAlternatives(content);
          const altRegexes = alternatives.map((alt) => this.patternToRegexStr(alt));
          const altGroup = altRegexes.length > 0 ? altRegexes.join("|") : "(?:)";
          if (c === "@") {
            regex += `(?:${altGroup})`;
          } else if (c === "*") {
            regex += `(?:${altGroup})*`;
          } else if (c === "+") {
            regex += `(?:${altGroup})+`;
          } else if (c === "?") {
            regex += `(?:${altGroup})?`;
          } else if (c === "!") {
            const hasMorePattern = closeIdx < pattern.length - 1;
            if (hasMorePattern) {
              const lengths = alternatives.map((alt) => this.computePatternLength(alt));
              const allSameLength = lengths.every((l) => l !== null) && lengths.every((l) => l === lengths[0]);
              if (allSameLength && lengths[0] !== null) {
                const n = lengths[0];
                if (n === 0) {
                  regex += "(?:.+)";
                } else {
                  const parts = [];
                  if (n > 0) {
                    parts.push(`.{0,${n - 1}}`);
                  }
                  parts.push(`.{${n + 1},}`);
                  parts.push(`(?!(?:${altGroup})).{${n}}`);
                  regex += `(?:${parts.join("|")})`;
                }
              } else {
                regex += `(?:(?!(?:${altGroup})).)*?`;
              }
            } else {
              regex += `(?!(?:${altGroup})$).*`;
            }
          }
          i = closeIdx;
          continue;
        }
      }
      if (c === "*") {
        regex += ".*";
      } else if (c === "?") {
        regex += ".";
      } else if (c === "[") {
        let j = i + 1;
        let classContent = "[";
        if (j < pattern.length && (pattern[j] === "^" || pattern[j] === "!")) {
          classContent += "^";
          j++;
        }
        if (j < pattern.length && pattern[j] === "]") {
          classContent += "\\]";
          j++;
        }
        let classEnd = j;
        while (classEnd < pattern.length) {
          if (pattern[classEnd] === "\\" && classEnd + 1 < pattern.length) {
            classEnd += 2;
            continue;
          }
          if (pattern[classEnd] === "[" && classEnd + 1 < pattern.length && pattern[classEnd + 1] === ":") {
            const posixEnd = pattern.indexOf(":]", classEnd + 2);
            if (posixEnd !== -1) {
              classEnd = posixEnd + 2;
              continue;
            }
          }
          if (pattern[classEnd] === "]") {
            break;
          }
          classEnd++;
        }
        const classStartPos = j;
        while (j < pattern.length && pattern[j] !== "]") {
          if (pattern[j] === "[" && j + 1 < pattern.length && pattern[j + 1] === ":") {
            const posixEnd = pattern.indexOf(":]", j + 2);
            if (posixEnd !== -1) {
              const posixClass = pattern.slice(j + 2, posixEnd);
              const regexClass = posixClassToRegex(posixClass);
              classContent += regexClass;
              j = posixEnd + 2;
              continue;
            }
          }
          if (pattern[j] === "\\" && j + 1 < pattern.length) {
            classContent += `\\${pattern[j + 1]}`;
            j += 2;
            continue;
          }
          if (pattern[j] === "-") {
            const atStart = j === classStartPos;
            const atEnd = j + 1 === classEnd;
            if (atStart || atEnd) {
              classContent += "\\-";
            } else {
              classContent += "-";
            }
          } else {
            classContent += pattern[j];
          }
          j++;
        }
        classContent += "]";
        regex += classContent;
        i = j;
      } else if (c === "\\" && i + 1 < pattern.length) {
        const nextChar = pattern[i + 1];
        if (/[.+^${}()|\\*?[\]]/.test(nextChar)) {
          regex += `\\${nextChar}`;
        } else {
          regex += nextChar;
        }
        i++;
      } else if (/[.+^${}()|]/.test(c)) {
        regex += `\\${c}`;
      } else {
        regex += c;
      }
    }
    return regex;
  }
  /**
   * Compute the fixed length of a pattern, if it has one.
   * Returns null if the pattern has variable length (contains *, +, etc.).
   * Used to optimize !() extglob patterns.
   */
  computePatternLength(pattern) {
    let length = 0;
    let i = 0;
    let inQuotedSection = false;
    while (i < pattern.length) {
      if (pattern.slice(i, i + 13) === "\0QUOTE_START\0") {
        inQuotedSection = true;
        i += 13;
        continue;
      }
      if (pattern.slice(i, i + 11) === "\0QUOTE_END\0") {
        inQuotedSection = false;
        i += 11;
        continue;
      }
      const c = pattern[i];
      if (inQuotedSection) {
        length += 1;
        i++;
        continue;
      }
      if ((c === "@" || c === "*" || c === "+" || c === "?" || c === "!") && i + 1 < pattern.length && pattern[i + 1] === "(") {
        const closeIdx = findMatchingParen(pattern, i + 1);
        if (closeIdx !== -1) {
          if (c === "@") {
            const content = pattern.slice(i + 2, closeIdx);
            const alts = splitExtglobAlternatives(content);
            const altLengths = alts.map((a) => this.computePatternLength(a));
            if (altLengths.every((l) => l !== null) && altLengths.every((l) => l === altLengths[0])) {
              length += altLengths[0];
              i = closeIdx + 1;
              continue;
            }
            return null;
          }
          return null;
        }
      }
      if (c === "*") {
        return null;
      }
      if (c === "?") {
        length += 1;
        i++;
        continue;
      }
      if (c === "[") {
        const closeIdx = pattern.indexOf("]", i + 1);
        if (closeIdx !== -1) {
          length += 1;
          i = closeIdx + 1;
          continue;
        }
        length += 1;
        i++;
        continue;
      }
      if (c === "\\") {
        length += 1;
        i += 2;
        continue;
      }
      length += 1;
      i++;
    }
    return length;
  }
};

// dist/interpreter/arithmetic.js
function applyBinaryOp(left, right, operator) {
  switch (operator) {
    case "+":
      return left + right;
    case "-":
      return left - right;
    case "*":
      return left * right;
    case "/":
      if (right === 0) {
        throw new ArithmeticError("division by 0");
      }
      return Math.trunc(left / right);
    case "%":
      if (right === 0) {
        throw new ArithmeticError("division by 0");
      }
      return left % right;
    case "**":
      if (right < 0) {
        throw new ArithmeticError("exponent less than 0");
      }
      return left ** right;
    case "<<":
      return left << right;
    case ">>":
      return left >> right;
    case "<":
      return left < right ? 1 : 0;
    case "<=":
      return left <= right ? 1 : 0;
    case ">":
      return left > right ? 1 : 0;
    case ">=":
      return left >= right ? 1 : 0;
    case "==":
      return left === right ? 1 : 0;
    case "!=":
      return left !== right ? 1 : 0;
    case "&":
      return left & right;
    case "|":
      return left | right;
    case "^":
      return left ^ right;
    case ",":
      return right;
    default:
      return 0;
  }
}
__name(applyBinaryOp, "applyBinaryOp");
function applyAssignmentOp(current, value, operator) {
  switch (operator) {
    case "=":
      return value;
    case "+=":
      return current + value;
    case "-=":
      return current - value;
    case "*=":
      return current * value;
    case "/=":
      return value !== 0 ? Math.trunc(current / value) : 0;
    case "%=":
      return value !== 0 ? current % value : 0;
    case "<<=":
      return current << value;
    case ">>=":
      return current >> value;
    case "&=":
      return current & value;
    case "|=":
      return current | value;
    case "^=":
      return current ^ value;
    default:
      return value;
  }
}
__name(applyAssignmentOp, "applyAssignmentOp");
function applyUnaryOp(operand, operator) {
  switch (operator) {
    case "-":
      return -operand;
    case "+":
      return +operand;
    case "!":
      return operand === 0 ? 1 : 0;
    case "~":
      return ~operand;
    default:
      return operand;
  }
}
__name(applyUnaryOp, "applyUnaryOp");
async function getArithVariable(ctx, name) {
  const directValue = ctx.state.env[name];
  if (directValue !== void 0) {
    return directValue;
  }
  const arrayZeroValue = ctx.state.env[`${name}_0`];
  if (arrayZeroValue !== void 0) {
    return arrayZeroValue;
  }
  return await getVariable(ctx, name);
}
__name(getArithVariable, "getArithVariable");
function parseArithValue(value) {
  if (!value) {
    return 0;
  }
  const num = Number.parseInt(value, 10);
  if (!Number.isNaN(num) && /^-?\d+$/.test(value.trim())) {
    return num;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return 0;
  }
  try {
    const parser = new Parser();
    const { expr, pos } = parseArithExpr(parser, trimmed, 0);
    if (pos < trimmed.length) {
      const errorToken = trimmed.slice(pos).trim().split(/\s+/)[0];
      throw new ArithmeticError(`${trimmed}: syntax error in expression (error token is "${errorToken}")`);
    }
    if (expr.type === "ArithNumber") {
      return expr.value;
    }
    return num || 0;
  } catch (error) {
    if (error instanceof ArithmeticError) {
      throw error;
    }
    const errorToken = trimmed.split(/\s+/).slice(1)[0] || trimmed;
    throw new ArithmeticError(`${trimmed}: syntax error in expression (error token is "${errorToken}")`);
  }
}
__name(parseArithValue, "parseArithValue");
async function evaluateArithValue(ctx, value) {
  if (!value) {
    return 0;
  }
  const num = Number.parseInt(value, 10);
  if (!Number.isNaN(num) && /^-?\d+$/.test(value.trim())) {
    return num;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return 0;
  }
  const parser = new Parser();
  const { expr, pos } = parseArithExpr(parser, trimmed, 0);
  if (pos < trimmed.length) {
    const unparsed = trimmed.slice(pos).trim();
    const errorToken = unparsed.split(/\s+/)[0] || unparsed;
    throw new ArithmeticError(`syntax error in expression (error token is "${errorToken}")`, "", "");
  }
  return await evaluateArithmetic(ctx, expr);
}
__name(evaluateArithValue, "evaluateArithValue");
async function resolveArithVariable(ctx, name, visited = /* @__PURE__ */ new Set()) {
  if (visited.has(name)) {
    return 0;
  }
  visited.add(name);
  const value = await getArithVariable(ctx, name);
  if (!value) {
    return 0;
  }
  const num = Number.parseInt(value, 10);
  if (!Number.isNaN(num) && /^-?\d+$/.test(value.trim())) {
    return num;
  }
  const trimmed = value.trim();
  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed)) {
    return await resolveArithVariable(ctx, trimmed, visited);
  }
  const parser = new Parser();
  const { expr, pos } = parseArithExpr(parser, trimmed, 0);
  if (pos < trimmed.length) {
    const unparsed = trimmed.slice(pos).trim();
    const errorToken = unparsed.split(/\s+/)[0] || unparsed;
    throw new ArithmeticError(`${trimmed}: syntax error in expression (error token is "${errorToken}")`);
  }
  return await evaluateArithmetic(ctx, expr);
}
__name(resolveArithVariable, "resolveArithVariable");
async function expandBracedContent(ctx, content) {
  if (content.startsWith("#")) {
    const varName2 = content.slice(1);
    const arrayMatch = varName2.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[[@*]\]$/);
    if (arrayMatch) {
      const arrayName = arrayMatch[1];
      const elements = getArrayElements(ctx, arrayName);
      return String(elements.length);
    }
    const value2 = ctx.state.env[varName2] || "";
    return String(value2.length);
  }
  if (content.startsWith("!")) {
    const varName2 = content.slice(1);
    const indirect = ctx.state.env[varName2] || "";
    return ctx.state.env[indirect] || "";
  }
  const operators = [":-", ":=", ":?", ":+", "-", "=", "?", "+"];
  let opIndex = -1;
  let op = "";
  for (const operator of operators) {
    const idx = content.indexOf(operator);
    if (idx > 0 && (opIndex === -1 || idx < opIndex)) {
      opIndex = idx;
      op = operator;
    }
  }
  if (opIndex === -1) {
    return await getVariable(ctx, content);
  }
  const varName = content.slice(0, opIndex);
  const defaultValue = content.slice(opIndex + op.length);
  const value = ctx.state.env[varName];
  const isUnset = value === void 0;
  const isEmpty = value === "";
  const checkEmpty = op.startsWith(":");
  switch (op) {
    case ":-":
    case "-": {
      const useDefault = isUnset || checkEmpty && isEmpty;
      return useDefault ? defaultValue : value || "";
    }
    case ":=":
    case "=": {
      const useDefault = isUnset || checkEmpty && isEmpty;
      if (useDefault) {
        ctx.state.env[varName] = defaultValue;
        return defaultValue;
      }
      return value || "";
    }
    case ":+":
    case "+": {
      const useAlternative = !(isUnset || checkEmpty && isEmpty);
      return useAlternative ? defaultValue : "";
    }
    case ":?":
    case "?": {
      const shouldError = isUnset || checkEmpty && isEmpty;
      if (shouldError) {
        throw new Error(defaultValue || `${varName}: parameter null or not set`);
      }
      return value || "";
    }
    default:
      return value || "";
  }
}
__name(expandBracedContent, "expandBracedContent");
async function evaluateArithmetic(ctx, expr, isExpansionContext = false) {
  switch (expr.type) {
    case "ArithNumber":
      if (Number.isNaN(expr.value)) {
        throw new ArithmeticError("value too great for base");
      }
      return expr.value;
    case "ArithVariable": {
      return await resolveArithVariable(ctx, expr.name);
    }
    case "ArithSpecialVar": {
      const value = await getVariable(ctx, expr.name);
      const trimmed = value.trim();
      if (!trimmed)
        return 0;
      const num = Number.parseInt(trimmed, 10);
      if (!Number.isNaN(num) && /^-?\d+$/.test(trimmed))
        return num;
      const parser = new Parser();
      const { expr: parsed } = parseArithExpr(parser, trimmed, 0);
      return await evaluateArithmetic(ctx, parsed);
    }
    case "ArithNested":
      return await evaluateArithmetic(ctx, expr.expression);
    case "ArithCommandSubst": {
      if (ctx.execFn) {
        const result = await ctx.execFn(expr.command);
        if (result.stderr) {
          ctx.state.expansionStderr = (ctx.state.expansionStderr || "") + result.stderr;
        }
        const output = result.stdout.trim();
        return Number.parseInt(output, 10) || 0;
      }
      return 0;
    }
    case "ArithBracedExpansion": {
      const expanded = await expandBracedContent(ctx, expr.content);
      return Number.parseInt(expanded, 10) || 0;
    }
    case "ArithDynamicBase": {
      const baseStr = await expandBracedContent(ctx, expr.baseExpr);
      const base = Number.parseInt(baseStr, 10);
      if (base < 2 || base > 64)
        return 0;
      const numStr = `${base}#${expr.value}`;
      return parseArithNumber(numStr);
    }
    case "ArithDynamicNumber": {
      const prefix = await expandBracedContent(ctx, expr.prefix);
      const numStr = prefix + expr.suffix;
      return parseArithNumber(numStr);
    }
    case "ArithArrayElement": {
      const isAssoc = ctx.state.associativeArrays?.has(expr.array);
      const lookupArrayValue = /* @__PURE__ */ __name(async (envKey) => {
        const arrayValue = ctx.state.env[envKey];
        if (arrayValue !== void 0) {
          return await evaluateArithValue(ctx, arrayValue);
        }
        return 0;
      }, "lookupArrayValue");
      if (expr.stringKey !== void 0) {
        return await lookupArrayValue(`${expr.array}_${expr.stringKey}`);
      }
      if (isAssoc && expr.index?.type === "ArithVariable" && !expr.index.hasDollarPrefix) {
        return await lookupArrayValue(`${expr.array}_${expr.index.name}`);
      }
      if (isAssoc && expr.index?.type === "ArithVariable" && expr.index.hasDollarPrefix) {
        const expandedKey = await getVariable(ctx, expr.index.name);
        return await lookupArrayValue(`${expr.array}_${expandedKey}`);
      }
      if (expr.index) {
        let index = await evaluateArithmetic(ctx, expr.index, isExpansionContext);
        if (index < 0) {
          const elements = getArrayElements(ctx, expr.array);
          const lineNum = ctx.state.currentLine;
          if (elements.length === 0) {
            ctx.state.expansionStderr = (ctx.state.expansionStderr || "") + `bash: line ${lineNum}: ${expr.array}: bad array subscript
`;
            return 0;
          }
          const maxIndex = Math.max(...elements.map(([idx]) => typeof idx === "number" ? idx : 0));
          const actualIdx = maxIndex + 1 + index;
          if (actualIdx < 0) {
            ctx.state.expansionStderr = (ctx.state.expansionStderr || "") + `bash: line ${lineNum}: ${expr.array}: bad array subscript
`;
            return 0;
          }
          index = actualIdx;
        }
        const envKey = `${expr.array}_${index}`;
        const arrayValue = ctx.state.env[envKey];
        if (arrayValue !== void 0) {
          return evaluateArithValue(ctx, arrayValue);
        }
        if (index === 0) {
          const scalarValue = ctx.state.env[expr.array];
          if (scalarValue !== void 0) {
            return evaluateArithValue(ctx, scalarValue);
          }
        }
        if (ctx.state.options.nounset) {
          const hasAnyElement = Object.keys(ctx.state.env).some((key) => key === expr.array || key.startsWith(`${expr.array}_`));
          if (!hasAnyElement) {
            throw new NounsetError(`${expr.array}[${index}]`);
          }
        }
        return 0;
      }
      return 0;
    }
    case "ArithDoubleSubscript": {
      throw new ArithmeticError("double subscript", "", "");
    }
    case "ArithNumberSubscript": {
      throw new ArithmeticError(`${expr.number}${expr.errorToken}: syntax error: invalid arithmetic operator (error token is "${expr.errorToken}")`);
    }
    case "ArithSyntaxError": {
      throw new ArithmeticError(expr.message, "", "", true);
    }
    case "ArithSingleQuote": {
      if (isExpansionContext) {
        throw new ArithmeticError(`syntax error: operand expected (error token is "'${expr.content}'")`);
      }
      return expr.value;
    }
    case "ArithBinary": {
      if (expr.operator === "||") {
        const left2 = await evaluateArithmetic(ctx, expr.left, isExpansionContext);
        if (left2)
          return 1;
        return await evaluateArithmetic(ctx, expr.right, isExpansionContext) ? 1 : 0;
      }
      if (expr.operator === "&&") {
        const left2 = await evaluateArithmetic(ctx, expr.left, isExpansionContext);
        if (!left2)
          return 0;
        return await evaluateArithmetic(ctx, expr.right, isExpansionContext) ? 1 : 0;
      }
      const left = await evaluateArithmetic(ctx, expr.left, isExpansionContext);
      const right = await evaluateArithmetic(ctx, expr.right, isExpansionContext);
      return applyBinaryOp(left, right, expr.operator);
    }
    case "ArithUnary": {
      const operand = await evaluateArithmetic(ctx, expr.operand, isExpansionContext);
      if (expr.operator === "++" || expr.operator === "--") {
        if (expr.operand.type === "ArithVariable") {
          const name = expr.operand.name;
          const current = Number.parseInt(await getVariable(ctx, name), 10) || 0;
          const newValue = expr.operator === "++" ? current + 1 : current - 1;
          ctx.state.env[name] = String(newValue);
          return expr.prefix ? newValue : current;
        }
        if (expr.operand.type === "ArithArrayElement") {
          const arrayName = expr.operand.array;
          const isAssoc = ctx.state.associativeArrays?.has(arrayName);
          let envKey;
          if (expr.operand.stringKey !== void 0) {
            envKey = `${arrayName}_${expr.operand.stringKey}`;
          } else if (isAssoc && expr.operand.index?.type === "ArithVariable" && !expr.operand.index.hasDollarPrefix) {
            envKey = `${arrayName}_${expr.operand.index.name}`;
          } else if (isAssoc && expr.operand.index?.type === "ArithVariable" && expr.operand.index.hasDollarPrefix) {
            const expandedKey = await getVariable(ctx, expr.operand.index.name);
            envKey = `${arrayName}_${expandedKey}`;
          } else if (expr.operand.index) {
            const index = await evaluateArithmetic(ctx, expr.operand.index, isExpansionContext);
            envKey = `${arrayName}_${index}`;
          } else {
            return operand;
          }
          const current = Number.parseInt(ctx.state.env[envKey] || "0", 10) || 0;
          const newValue = expr.operator === "++" ? current + 1 : current - 1;
          ctx.state.env[envKey] = String(newValue);
          return expr.prefix ? newValue : current;
        }
        if (expr.operand.type === "ArithConcat") {
          let varName = "";
          for (const part of expr.operand.parts) {
            varName += await evalConcatPartToStringAsync(ctx, part, isExpansionContext);
          }
          if (varName && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(varName)) {
            const current = Number.parseInt(ctx.state.env[varName] || "0", 10) || 0;
            const newValue = expr.operator === "++" ? current + 1 : current - 1;
            ctx.state.env[varName] = String(newValue);
            return expr.prefix ? newValue : current;
          }
        }
        if (expr.operand.type === "ArithDynamicElement") {
          let varName = "";
          if (expr.operand.nameExpr.type === "ArithConcat") {
            for (const part of expr.operand.nameExpr.parts) {
              varName += await evalConcatPartToStringAsync(ctx, part, isExpansionContext);
            }
          } else if (expr.operand.nameExpr.type === "ArithVariable") {
            varName = expr.operand.nameExpr.hasDollarPrefix ? await getVariable(ctx, expr.operand.nameExpr.name) : expr.operand.nameExpr.name;
          }
          if (varName && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(varName)) {
            const index = await evaluateArithmetic(ctx, expr.operand.subscript, isExpansionContext);
            const envKey = `${varName}_${index}`;
            const current = Number.parseInt(ctx.state.env[envKey] || "0", 10) || 0;
            const newValue = expr.operator === "++" ? current + 1 : current - 1;
            ctx.state.env[envKey] = String(newValue);
            return expr.prefix ? newValue : current;
          }
        }
        return operand;
      }
      return applyUnaryOp(operand, expr.operator);
    }
    case "ArithTernary": {
      const condition = await evaluateArithmetic(ctx, expr.condition, isExpansionContext);
      return condition ? await evaluateArithmetic(ctx, expr.consequent, isExpansionContext) : await evaluateArithmetic(ctx, expr.alternate, isExpansionContext);
    }
    case "ArithAssignment": {
      const name = expr.variable;
      let envKey = name;
      if (expr.stringKey !== void 0) {
        envKey = `${name}_${expr.stringKey}`;
      } else if (expr.subscript) {
        const isAssoc = ctx.state.associativeArrays?.has(name);
        if (isAssoc && expr.subscript.type === "ArithVariable" && !expr.subscript.hasDollarPrefix) {
          envKey = `${name}_${expr.subscript.name}`;
        } else if (isAssoc && expr.subscript.type === "ArithVariable" && expr.subscript.hasDollarPrefix) {
          const expandedKey = await getVariable(ctx, expr.subscript.name);
          envKey = `${name}_${expandedKey || "\\"}`;
        } else if (isAssoc) {
          const index = await evaluateArithmetic(ctx, expr.subscript, isExpansionContext);
          envKey = `${name}_${index}`;
        } else {
          let index = await evaluateArithmetic(ctx, expr.subscript, isExpansionContext);
          if (index < 0) {
            const elements = getArrayElements(ctx, name);
            if (elements.length > 0) {
              const maxIndex = Math.max(...elements.map(([idx]) => typeof idx === "number" ? idx : 0));
              index = maxIndex + 1 + index;
            }
          }
          envKey = `${name}_${index}`;
        }
      }
      const current = Number.parseInt(ctx.state.env[envKey] || "0", 10) || 0;
      const value = await evaluateArithmetic(ctx, expr.value, isExpansionContext);
      const newValue = applyAssignmentOp(current, value, expr.operator);
      ctx.state.env[envKey] = String(newValue);
      return newValue;
    }
    case "ArithGroup":
      return await evaluateArithmetic(ctx, expr.expression, isExpansionContext);
    case "ArithConcat": {
      let concatenated = "";
      for (const part of expr.parts) {
        concatenated += await evalConcatPartToStringAsync(ctx, part, isExpansionContext);
      }
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(concatenated)) {
        return await resolveArithVariable(ctx, concatenated);
      }
      return Number.parseInt(concatenated, 10) || 0;
    }
    case "ArithDynamicAssignment": {
      let varName = "";
      if (expr.target.type === "ArithConcat") {
        for (const part of expr.target.parts) {
          varName += await evalConcatPartToStringAsync(ctx, part, isExpansionContext);
        }
      } else if (expr.target.type === "ArithVariable") {
        varName = expr.target.hasDollarPrefix ? await getVariable(ctx, expr.target.name) : expr.target.name;
      }
      if (!varName || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(varName)) {
        return 0;
      }
      let envKey = varName;
      if (expr.subscript) {
        const index = await evaluateArithmetic(ctx, expr.subscript, isExpansionContext);
        envKey = `${varName}_${index}`;
      }
      const current = Number.parseInt(ctx.state.env[envKey] || "0", 10) || 0;
      const value = await evaluateArithmetic(ctx, expr.value, isExpansionContext);
      const newValue = applyAssignmentOp(current, value, expr.operator);
      ctx.state.env[envKey] = String(newValue);
      return newValue;
    }
    case "ArithDynamicElement": {
      let varName = "";
      if (expr.nameExpr.type === "ArithConcat") {
        for (const part of expr.nameExpr.parts) {
          varName += await evalConcatPartToStringAsync(ctx, part, isExpansionContext);
        }
      } else if (expr.nameExpr.type === "ArithVariable") {
        varName = expr.nameExpr.hasDollarPrefix ? await getVariable(ctx, expr.nameExpr.name) : expr.nameExpr.name;
      }
      if (!varName || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(varName)) {
        return 0;
      }
      const index = await evaluateArithmetic(ctx, expr.subscript, isExpansionContext);
      const envKey = `${varName}_${index}`;
      const value = ctx.state.env[envKey];
      if (value !== void 0) {
        return parseArithValue(value);
      }
      return 0;
    }
    default:
      return 0;
  }
}
__name(evaluateArithmetic, "evaluateArithmetic");
async function evalConcatPartToStringAsync(ctx, expr, isExpansionContext = false) {
  switch (expr.type) {
    case "ArithNumber":
      return String(expr.value);
    case "ArithSingleQuote":
      return String(await evaluateArithmetic(ctx, expr, isExpansionContext));
    case "ArithVariable":
      if (expr.hasDollarPrefix) {
        return await getVariable(ctx, expr.name);
      }
      return expr.name;
    case "ArithSpecialVar":
      return await getVariable(ctx, expr.name);
    case "ArithBracedExpansion":
      return await expandBracedContent(ctx, expr.content);
    case "ArithCommandSubst": {
      if (ctx.execFn) {
        const result = await ctx.execFn(expr.command);
        return result.stdout.trim();
      }
      return "0";
    }
    case "ArithConcat": {
      let result = "";
      for (const part of expr.parts) {
        result += await evalConcatPartToStringAsync(ctx, part, isExpansionContext);
      }
      return result;
    }
    default:
      return String(await evaluateArithmetic(ctx, expr, isExpansionContext));
  }
}
__name(evalConcatPartToStringAsync, "evalConcatPartToStringAsync");

// dist/interpreter/expansion/analysis.js
function globPatternHasVarRef(pattern) {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "\\") {
      i++;
      continue;
    }
    if (pattern[i] === "$") {
      const next = pattern[i + 1];
      if (next === "{" || next && /[a-zA-Z_]/.test(next)) {
        return true;
      }
    }
  }
  return false;
}
__name(globPatternHasVarRef, "globPatternHasVarRef");
function hasQuotedOperationWord(part) {
  if (!part.operation)
    return false;
  const op = part.operation;
  let wordParts;
  if (op.type === "DefaultValue" || op.type === "AssignDefault" || op.type === "UseAlternative" || op.type === "ErrorIfUnset") {
    wordParts = op.word?.parts;
  }
  if (!wordParts)
    return false;
  for (const p of wordParts) {
    if (p.type === "DoubleQuoted" || p.type === "SingleQuoted") {
      return true;
    }
  }
  return false;
}
__name(hasQuotedOperationWord, "hasQuotedOperationWord");
function isOperationWordEntirelyQuoted(part) {
  if (!part.operation)
    return false;
  const op = part.operation;
  let wordParts;
  if (op.type === "DefaultValue" || op.type === "AssignDefault" || op.type === "UseAlternative" || op.type === "ErrorIfUnset") {
    wordParts = op.word?.parts;
  }
  if (!wordParts || wordParts.length === 0)
    return false;
  for (const p of wordParts) {
    if (p.type !== "DoubleQuoted" && p.type !== "SingleQuoted") {
      return false;
    }
  }
  return true;
}
__name(isOperationWordEntirelyQuoted, "isOperationWordEntirelyQuoted");
function analyzeWordParts(parts) {
  let hasQuoted = false;
  let hasCommandSub = false;
  let hasArrayVar = false;
  let hasArrayAtExpansion = false;
  let hasParamExpansion = false;
  let hasVarNamePrefixExpansion = false;
  let hasIndirection = false;
  for (const part of parts) {
    if (part.type === "SingleQuoted" || part.type === "DoubleQuoted") {
      hasQuoted = true;
      if (part.type === "DoubleQuoted") {
        for (const inner of part.parts) {
          if (inner.type === "ParameterExpansion") {
            const match = inner.parameter.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[[@*]\]$/);
            if (match && (!inner.operation || inner.operation.type === "PatternRemoval" || inner.operation.type === "PatternReplacement")) {
              hasArrayAtExpansion = true;
            }
            if (inner.operation?.type === "VarNamePrefix" || inner.operation?.type === "ArrayKeys") {
              hasVarNamePrefixExpansion = true;
            }
            if (inner.operation?.type === "Indirection") {
              hasIndirection = true;
            }
          }
        }
      }
    }
    if (part.type === "CommandSubstitution") {
      hasCommandSub = true;
    }
    if (part.type === "ParameterExpansion") {
      hasParamExpansion = true;
      if (part.parameter === "@" || part.parameter === "*") {
        hasArrayVar = true;
      }
      if (hasQuotedOperationWord(part)) {
        hasQuoted = true;
      }
      if (part.operation?.type === "VarNamePrefix" || part.operation?.type === "ArrayKeys") {
        hasVarNamePrefixExpansion = true;
      }
      if (part.operation?.type === "Indirection") {
        hasIndirection = true;
      }
    }
    if (part.type === "Glob" && globPatternHasVarRef(part.pattern)) {
      hasParamExpansion = true;
    }
  }
  return {
    hasQuoted,
    hasCommandSub,
    hasArrayVar,
    hasArrayAtExpansion,
    hasParamExpansion,
    hasVarNamePrefixExpansion,
    hasIndirection
  };
}
__name(analyzeWordParts, "analyzeWordParts");

// dist/shell-metadata.js
var BASH_VERSION = "5.1.0(1)-release";
var KERNEL_VERSION = "Linux version 5.15.0-generic (just-bash) #1 SMP PREEMPT";
function getProcessInfo() {
  return {
    pid: process.pid,
    ppid: process.ppid,
    uid: process.getuid?.() ?? 1e3,
    gid: process.getgid?.() ?? 1e3
  };
}
__name(getProcessInfo, "getProcessInfo");
function formatProcStatus() {
  const { pid, ppid, uid, gid } = getProcessInfo();
  return `Name:	bash
State:	R (running)
Pid:	${pid}
PPid:	${ppid}
Uid:	${uid}	${uid}	${uid}	${uid}
Gid:	${gid}	${gid}	${gid}	${gid}
`;
}
__name(formatProcStatus, "formatProcStatus");

// dist/interpreter/helpers/array.js
function getArrayIndices(ctx, arrayName) {
  const prefix = `${arrayName}_`;
  const indices = [];
  for (const key of Object.keys(ctx.state.env)) {
    if (key.startsWith(prefix)) {
      const indexStr = key.slice(prefix.length);
      const index = Number.parseInt(indexStr, 10);
      if (!Number.isNaN(index) && String(index) === indexStr) {
        indices.push(index);
      }
    }
  }
  return indices.sort((a, b) => a - b);
}
__name(getArrayIndices, "getArrayIndices");
function clearArray(ctx, arrayName) {
  const prefix = `${arrayName}_`;
  for (const key of Object.keys(ctx.state.env)) {
    if (key.startsWith(prefix)) {
      delete ctx.state.env[key];
    }
  }
}
__name(clearArray, "clearArray");
function getAssocArrayKeys(ctx, arrayName) {
  const prefix = `${arrayName}_`;
  const metadataSuffix = `${arrayName}__length`;
  const keys = [];
  for (const envKey of Object.keys(ctx.state.env)) {
    if (envKey === metadataSuffix) {
      continue;
    }
    if (envKey.startsWith(prefix)) {
      const key = envKey.slice(prefix.length);
      if (key.startsWith("_length")) {
        continue;
      }
      keys.push(key);
    }
  }
  return keys.sort();
}
__name(getAssocArrayKeys, "getAssocArrayKeys");
function unquoteKey(key) {
  if (key.startsWith("'") && key.endsWith("'") || key.startsWith('"') && key.endsWith('"')) {
    return key.slice(1, -1);
  }
  return key;
}
__name(unquoteKey, "unquoteKey");
function parseKeyedElementFromWord(word) {
  if (word.parts.length < 2)
    return null;
  const first = word.parts[0];
  const second = word.parts[1];
  if (first.type !== "Glob" || !first.pattern.startsWith("[")) {
    return null;
  }
  let key;
  let secondPart = second;
  let secondPartIndex = 1;
  if (second.type === "Literal" && second.value.startsWith("]")) {
    const afterBracket = second.value.slice(1);
    if (afterBracket.startsWith("+=") || afterBracket.startsWith("=")) {
      key = first.pattern.slice(1);
    } else if (afterBracket === "") {
      if (word.parts.length < 3)
        return null;
      const third = word.parts[2];
      if (third.type !== "Literal")
        return null;
      if (!third.value.startsWith("=") && !third.value.startsWith("+="))
        return null;
      key = first.pattern.slice(1);
      secondPart = third;
      secondPartIndex = 2;
    } else {
      return null;
    }
  } else if (first.pattern === "[" && (second.type === "DoubleQuoted" || second.type === "SingleQuoted")) {
    if (word.parts.length < 3)
      return null;
    const third = word.parts[2];
    if (third.type !== "Literal")
      return null;
    if (!third.value.startsWith("]=") && !third.value.startsWith("]+="))
      return null;
    if (second.type === "SingleQuoted") {
      key = second.value;
    } else {
      key = "";
      for (const inner of second.parts) {
        if (inner.type === "Literal") {
          key += inner.value;
        } else if (inner.type === "Escaped") {
          key += inner.value;
        }
      }
    }
    secondPart = third;
    secondPartIndex = 2;
  } else if (first.pattern.endsWith("]")) {
    if (second.type !== "Literal")
      return null;
    if (!second.value.startsWith("=") && !second.value.startsWith("+="))
      return null;
    key = first.pattern.slice(1, -1);
  } else {
    return null;
  }
  key = unquoteKey(key);
  let assignmentContent;
  if (secondPart.type !== "Literal")
    return null;
  if (secondPart.value.startsWith("]=")) {
    assignmentContent = secondPart.value.slice(1);
  } else if (secondPart.value.startsWith("]+=")) {
    assignmentContent = secondPart.value.slice(1);
  } else {
    assignmentContent = secondPart.value;
  }
  const append = assignmentContent.startsWith("+=");
  if (!append && !assignmentContent.startsWith("="))
    return null;
  const valueParts = [];
  const eqLen = append ? 2 : 1;
  const afterEq = assignmentContent.slice(eqLen);
  if (afterEq) {
    valueParts.push({ type: "Literal", value: afterEq });
  }
  for (let i = secondPartIndex + 1; i < word.parts.length; i++) {
    const part = word.parts[i];
    if (part.type === "BraceExpansion") {
      valueParts.push({ type: "Literal", value: braceToLiteral(part) });
    } else {
      valueParts.push(part);
    }
  }
  return { key, valueParts, append };
}
__name(parseKeyedElementFromWord, "parseKeyedElementFromWord");
function braceToLiteral(part) {
  const items = part.items.map((item) => {
    if (item.type === "Range") {
      const startS = item.startStr ?? String(item.start);
      const endS = item.endStr ?? String(item.end);
      let range = `${startS}..${endS}`;
      if (item.step)
        range += `..${item.step}`;
      return range;
    }
    return wordToLiteralString(item.word);
  });
  return `{${items.join(",")}}`;
}
__name(braceToLiteral, "braceToLiteral");
function wordToLiteralString(word) {
  let result = "";
  for (const part of word.parts) {
    switch (part.type) {
      case "Literal":
        result += part.value;
        break;
      case "Glob":
        result += part.pattern;
        break;
      case "SingleQuoted":
        result += part.value;
        break;
      case "DoubleQuoted":
        for (const inner of part.parts) {
          if (inner.type === "Literal") {
            result += inner.value;
          } else if (inner.type === "Escaped") {
            result += inner.value;
          }
        }
        break;
      case "Escaped":
        result += part.value;
        break;
      case "BraceExpansion":
        result += "{";
        result += part.items.map((item) => item.type === "Range" ? `${item.startStr}..${item.endStr}${item.step ? `..${item.step}` : ""}` : wordToLiteralString(item.word)).join(",");
        result += "}";
        break;
      case "TildeExpansion":
        result += "~";
        if (part.user) {
          result += part.user;
        }
        break;
    }
  }
  return result;
}
__name(wordToLiteralString, "wordToLiteralString");

// dist/interpreter/helpers/ifs.js
var DEFAULT_IFS = " 	\n";
function getIfs(env) {
  return env.IFS ?? DEFAULT_IFS;
}
__name(getIfs, "getIfs");
function isIfsEmpty(env) {
  return env.IFS === "";
}
__name(isIfsEmpty, "isIfsEmpty");
function isIfsWhitespaceOnly(env) {
  const ifs = getIfs(env);
  if (ifs === "")
    return true;
  for (const ch of ifs) {
    if (ch !== " " && ch !== "	" && ch !== "\n") {
      return false;
    }
  }
  return true;
}
__name(isIfsWhitespaceOnly, "isIfsWhitespaceOnly");
function buildIfsCharClassPattern(ifs) {
  return ifs.split("").map((c) => {
    if (/[\\^$.*+?()[\]{}|-]/.test(c))
      return `\\${c}`;
    if (c === "	")
      return "\\t";
    if (c === "\n")
      return "\\n";
    return c;
  }).join("");
}
__name(buildIfsCharClassPattern, "buildIfsCharClassPattern");
function getIfsSeparator(env) {
  const ifs = env.IFS;
  if (ifs === void 0)
    return " ";
  return ifs[0] || "";
}
__name(getIfsSeparator, "getIfsSeparator");
var IFS_WHITESPACE = " 	\n";
function isIfsWhitespace(ch) {
  return IFS_WHITESPACE.includes(ch);
}
__name(isIfsWhitespace, "isIfsWhitespace");
function categorizeIfs(ifs) {
  const whitespace = /* @__PURE__ */ new Set();
  const nonWhitespace = /* @__PURE__ */ new Set();
  for (const ch of ifs) {
    if (isIfsWhitespace(ch)) {
      whitespace.add(ch);
    } else {
      nonWhitespace.add(ch);
    }
  }
  return { whitespace, nonWhitespace };
}
__name(categorizeIfs, "categorizeIfs");
function splitByIfsForRead(value, ifs, maxSplit, raw) {
  if (ifs === "") {
    if (value === "") {
      return { words: [], wordStarts: [] };
    }
    return { words: [value], wordStarts: [0] };
  }
  const { whitespace, nonWhitespace } = categorizeIfs(ifs);
  const words = [];
  const wordStarts = [];
  let pos = 0;
  while (pos < value.length && whitespace.has(value[pos])) {
    pos++;
  }
  if (pos >= value.length) {
    return { words: [], wordStarts: [] };
  }
  if (nonWhitespace.has(value[pos])) {
    words.push("");
    wordStarts.push(pos);
    pos++;
    while (pos < value.length && whitespace.has(value[pos])) {
      pos++;
    }
  }
  while (pos < value.length) {
    if (maxSplit !== void 0 && words.length >= maxSplit) {
      break;
    }
    const wordStart = pos;
    wordStarts.push(wordStart);
    while (pos < value.length) {
      const ch = value[pos];
      if (!raw && ch === "\\") {
        pos++;
        if (pos < value.length) {
          pos++;
        }
        continue;
      }
      if (whitespace.has(ch) || nonWhitespace.has(ch)) {
        break;
      }
      pos++;
    }
    words.push(value.substring(wordStart, pos));
    if (pos >= value.length) {
      break;
    }
    while (pos < value.length && whitespace.has(value[pos])) {
      pos++;
    }
    if (pos < value.length && nonWhitespace.has(value[pos])) {
      pos++;
      while (pos < value.length && whitespace.has(value[pos])) {
        pos++;
      }
      while (pos < value.length && nonWhitespace.has(value[pos])) {
        if (maxSplit !== void 0 && words.length >= maxSplit) {
          break;
        }
        words.push("");
        wordStarts.push(pos);
        pos++;
        while (pos < value.length && whitespace.has(value[pos])) {
          pos++;
        }
      }
    }
  }
  return { words, wordStarts };
}
__name(splitByIfsForRead, "splitByIfsForRead");
function splitByIfsForExpansionEx(value, ifs) {
  if (ifs === "") {
    return {
      words: value ? [value] : [],
      hadLeadingDelimiter: false,
      hadTrailingDelimiter: false
    };
  }
  if (value === "") {
    return {
      words: [],
      hadLeadingDelimiter: false,
      hadTrailingDelimiter: false
    };
  }
  const { whitespace, nonWhitespace } = categorizeIfs(ifs);
  const words = [];
  let pos = 0;
  let hadLeadingDelimiter = false;
  let hadTrailingDelimiter = false;
  const leadingStart = pos;
  while (pos < value.length && whitespace.has(value[pos])) {
    pos++;
  }
  if (pos > leadingStart) {
    hadLeadingDelimiter = true;
  }
  if (pos >= value.length) {
    return { words: [], hadLeadingDelimiter: true, hadTrailingDelimiter: true };
  }
  if (nonWhitespace.has(value[pos])) {
    words.push("");
    pos++;
    while (pos < value.length && whitespace.has(value[pos])) {
      pos++;
    }
  }
  while (pos < value.length) {
    const wordStart = pos;
    while (pos < value.length) {
      const ch = value[pos];
      if (whitespace.has(ch) || nonWhitespace.has(ch)) {
        break;
      }
      pos++;
    }
    words.push(value.substring(wordStart, pos));
    if (pos >= value.length) {
      hadTrailingDelimiter = false;
      break;
    }
    const beforeDelimiterPos = pos;
    while (pos < value.length && whitespace.has(value[pos])) {
      pos++;
    }
    if (pos < value.length && nonWhitespace.has(value[pos])) {
      pos++;
      while (pos < value.length && whitespace.has(value[pos])) {
        pos++;
      }
      while (pos < value.length && nonWhitespace.has(value[pos])) {
        words.push("");
        pos++;
        while (pos < value.length && whitespace.has(value[pos])) {
          pos++;
        }
      }
    }
    if (pos >= value.length && pos > beforeDelimiterPos) {
      hadTrailingDelimiter = true;
    }
  }
  return { words, hadLeadingDelimiter, hadTrailingDelimiter };
}
__name(splitByIfsForExpansionEx, "splitByIfsForExpansionEx");
function splitByIfsForExpansion(value, ifs) {
  return splitByIfsForExpansionEx(value, ifs).words;
}
__name(splitByIfsForExpansion, "splitByIfsForExpansion");
function containsNonWsIfs(value, nonWhitespace) {
  for (const ch of value) {
    if (nonWhitespace.has(ch)) {
      return true;
    }
  }
  return false;
}
__name(containsNonWsIfs, "containsNonWsIfs");
function stripTrailingIfsWhitespace(value, ifs, raw) {
  if (ifs === "")
    return value;
  const { whitespace, nonWhitespace } = categorizeIfs(ifs);
  let end = value.length;
  while (end > 0) {
    if (!whitespace.has(value[end - 1])) {
      break;
    }
    if (!raw && end >= 2) {
      let backslashCount = 0;
      let pos = end - 2;
      while (pos >= 0 && value[pos] === "\\") {
        backslashCount++;
        pos--;
      }
      if (backslashCount % 2 === 1) {
        break;
      }
    }
    end--;
  }
  const result = value.substring(0, end);
  if (result.length >= 1 && nonWhitespace.has(result[result.length - 1])) {
    if (!raw && result.length >= 2) {
      let backslashCount = 0;
      let pos = result.length - 2;
      while (pos >= 0 && result[pos] === "\\") {
        backslashCount++;
        pos--;
      }
      if (backslashCount % 2 === 1) {
        return result;
      }
    }
    const contentWithoutTrailing = result.substring(0, result.length - 1);
    if (!containsNonWsIfs(contentWithoutTrailing, nonWhitespace)) {
      return contentWithoutTrailing;
    }
  }
  return result;
}
__name(stripTrailingIfsWhitespace, "stripTrailingIfsWhitespace");

// dist/interpreter/helpers/nameref.js
function isNameref(ctx, name) {
  return ctx.state.namerefs?.has(name) ?? false;
}
__name(isNameref, "isNameref");
function markNameref(ctx, name) {
  ctx.state.namerefs ??= /* @__PURE__ */ new Set();
  ctx.state.namerefs.add(name);
}
__name(markNameref, "markNameref");
function unmarkNameref(ctx, name) {
  ctx.state.namerefs?.delete(name);
  ctx.state.boundNamerefs?.delete(name);
  ctx.state.invalidNamerefs?.delete(name);
}
__name(unmarkNameref, "unmarkNameref");
function markNamerefInvalid(ctx, name) {
  ctx.state.invalidNamerefs ??= /* @__PURE__ */ new Set();
  ctx.state.invalidNamerefs.add(name);
}
__name(markNamerefInvalid, "markNamerefInvalid");
function isNamerefInvalid(ctx, name) {
  return ctx.state.invalidNamerefs?.has(name) ?? false;
}
__name(isNamerefInvalid, "isNamerefInvalid");
function markNamerefBound(ctx, name) {
  ctx.state.boundNamerefs ??= /* @__PURE__ */ new Set();
  ctx.state.boundNamerefs.add(name);
}
__name(markNamerefBound, "markNamerefBound");
function targetExists(ctx, target) {
  const arrayMatch = target.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[(.+)\]$/);
  if (arrayMatch) {
    const arrayName = arrayMatch[1];
    const hasElements = Object.keys(ctx.state.env).some((k) => k.startsWith(`${arrayName}_`) && !k.includes("__"));
    const isAssoc = ctx.state.associativeArrays?.has(arrayName) ?? false;
    return hasElements || isAssoc;
  }
  const hasArrayElements = Object.keys(ctx.state.env).some((k) => k.startsWith(`${target}_`) && !k.includes("__"));
  if (hasArrayElements) {
    return true;
  }
  return ctx.state.env[target] !== void 0;
}
__name(targetExists, "targetExists");
function resolveNameref(ctx, name, maxDepth = 100) {
  if (!isNameref(ctx, name)) {
    return name;
  }
  if (isNamerefInvalid(ctx, name)) {
    return name;
  }
  const seen = /* @__PURE__ */ new Set();
  let current = name;
  while (maxDepth-- > 0) {
    if (seen.has(current)) {
      return void 0;
    }
    seen.add(current);
    if (!isNameref(ctx, current)) {
      return current;
    }
    const target = ctx.state.env[current];
    if (target === void 0 || target === "") {
      return current;
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*(\[.+\])?$/.test(target)) {
      return current;
    }
    current = target;
  }
  return void 0;
}
__name(resolveNameref, "resolveNameref");
function getNamerefTarget(ctx, name) {
  if (!isNameref(ctx, name)) {
    return void 0;
  }
  return ctx.state.env[name];
}
__name(getNamerefTarget, "getNamerefTarget");
function resolveNamerefForAssignment(ctx, name, valueBeingAssigned, maxDepth = 100) {
  if (!isNameref(ctx, name)) {
    return name;
  }
  if (isNamerefInvalid(ctx, name)) {
    return name;
  }
  const seen = /* @__PURE__ */ new Set();
  let current = name;
  while (maxDepth-- > 0) {
    if (seen.has(current)) {
      return void 0;
    }
    seen.add(current);
    if (!isNameref(ctx, current)) {
      return current;
    }
    const target = ctx.state.env[current];
    if (target === void 0 || target === "") {
      if (valueBeingAssigned !== void 0) {
        const isValidName2 = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(valueBeingAssigned);
        if (isValidName2 && targetExists(ctx, valueBeingAssigned)) {
          return current;
        }
        return null;
      }
      return current;
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*(\[.+\])?$/.test(target)) {
      return current;
    }
    current = target;
  }
  return void 0;
}
__name(resolveNamerefForAssignment, "resolveNamerefForAssignment");

// dist/interpreter/expansion/variable.js
function expandSimpleVarsInSubscript(ctx, subscript) {
  let result = subscript.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_, name) => ctx.state.env[name] ?? "");
  result = result.replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name) => ctx.state.env[name] ?? "");
  return result;
}
__name(expandSimpleVarsInSubscript, "expandSimpleVarsInSubscript");
function getArrayElements(ctx, arrayName) {
  if (arrayName === "FUNCNAME") {
    const stack = ctx.state.funcNameStack ?? [];
    return stack.map((name, i) => [i, name]);
  }
  if (arrayName === "BASH_LINENO") {
    const stack = ctx.state.callLineStack ?? [];
    return stack.map((line, i) => [i, String(line)]);
  }
  if (arrayName === "BASH_SOURCE") {
    const stack = ctx.state.sourceStack ?? [];
    return stack.map((source, i) => [i, source]);
  }
  const isAssoc = ctx.state.associativeArrays?.has(arrayName);
  if (isAssoc) {
    const keys = getAssocArrayKeys(ctx, arrayName);
    return keys.map((key) => [key, ctx.state.env[`${arrayName}_${key}`]]);
  }
  const indices = getArrayIndices(ctx, arrayName);
  return indices.map((index) => [
    index,
    ctx.state.env[`${arrayName}_${index}`]
  ]);
}
__name(getArrayElements, "getArrayElements");
function isArray(ctx, name) {
  if (name === "FUNCNAME") {
    return (ctx.state.funcNameStack?.length ?? 0) > 0;
  }
  if (name === "BASH_LINENO") {
    return (ctx.state.callLineStack?.length ?? 0) > 0;
  }
  if (name === "BASH_SOURCE") {
    return (ctx.state.sourceStack?.length ?? 0) > 0;
  }
  if (ctx.state.associativeArrays?.has(name)) {
    return getAssocArrayKeys(ctx, name).length > 0;
  }
  return getArrayIndices(ctx, name).length > 0;
}
__name(isArray, "isArray");
async function getVariable(ctx, name, checkNounset = true, _insideDoubleQuotes = false) {
  switch (name) {
    case "?":
      return String(ctx.state.lastExitCode);
    case "$":
      return String(process.pid);
    case "#":
      return ctx.state.env["#"] || "0";
    case "@":
      return ctx.state.env["@"] || "";
    case "_":
      return ctx.state.lastArg;
    case "-": {
      let flags = "";
      flags += "h";
      if (ctx.state.options.errexit)
        flags += "e";
      if (ctx.state.options.noglob)
        flags += "f";
      if (ctx.state.options.nounset)
        flags += "u";
      if (ctx.state.options.verbose)
        flags += "v";
      if (ctx.state.options.xtrace)
        flags += "x";
      flags += "B";
      if (ctx.state.options.noclobber)
        flags += "C";
      flags += "s";
      return flags;
    }
    case "*": {
      const numParams = Number.parseInt(ctx.state.env["#"] || "0", 10);
      if (numParams === 0)
        return "";
      const params = [];
      for (let i = 1; i <= numParams; i++) {
        params.push(ctx.state.env[String(i)] || "");
      }
      return params.join(getIfsSeparator(ctx.state.env));
    }
    case "0":
      return ctx.state.env["0"] || "bash";
    case "PWD":
      if (ctx.state.env.PWD !== void 0) {
        return ctx.state.env.PWD;
      }
      return "";
    case "OLDPWD":
      if (ctx.state.env.OLDPWD !== void 0) {
        return ctx.state.env.OLDPWD;
      }
      return "";
    case "PPID": {
      const { ppid } = getProcessInfo();
      return String(ppid);
    }
    case "UID": {
      const { uid } = getProcessInfo();
      return String(uid);
    }
    case "EUID":
      return String(process.geteuid?.() ?? getProcessInfo().uid);
    case "RANDOM":
      return String(Math.floor(Math.random() * 32768));
    case "SECONDS":
      return String(Math.floor((Date.now() - ctx.state.startTime) / 1e3));
    case "BASH_VERSION":
      return BASH_VERSION;
    case "!":
      return String(ctx.state.lastBackgroundPid);
    case "BASHPID":
      return String(ctx.state.bashPid);
    case "LINENO":
      return String(ctx.state.currentLine);
    case "FUNCNAME": {
      const funcName = ctx.state.funcNameStack?.[0];
      if (funcName !== void 0) {
        return funcName;
      }
      if (checkNounset && ctx.state.options.nounset) {
        throw new NounsetError("FUNCNAME");
      }
      return "";
    }
    case "BASH_LINENO": {
      const line = ctx.state.callLineStack?.[0];
      if (line !== void 0) {
        return String(line);
      }
      if (checkNounset && ctx.state.options.nounset) {
        throw new NounsetError("BASH_LINENO");
      }
      return "";
    }
    case "BASH_SOURCE": {
      const source = ctx.state.sourceStack?.[0];
      if (source !== void 0) {
        return source;
      }
      if (checkNounset && ctx.state.options.nounset) {
        throw new NounsetError("BASH_SOURCE");
      }
      return "";
    }
  }
  if (/^[a-zA-Z_][a-zA-Z0-9_]*\[\]$/.test(name)) {
    throw new BadSubstitutionError(`\${${name}}`);
  }
  const bracketMatch = name.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[(.+)\]$/);
  if (bracketMatch) {
    let arrayName = bracketMatch[1];
    const subscript = bracketMatch[2];
    if (isNameref(ctx, arrayName)) {
      const resolved = resolveNameref(ctx, arrayName);
      if (resolved && resolved !== arrayName) {
        const resolvedBracket = resolved.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[(.+)\]$/);
        if (resolvedBracket) {
          return "";
        }
        arrayName = resolved;
      }
    }
    if (subscript === "@" || subscript === "*") {
      const elements = getArrayElements(ctx, arrayName);
      if (elements.length > 0) {
        return elements.map(([, v]) => v).join(" ");
      }
      const scalarValue = ctx.state.env[arrayName];
      if (scalarValue !== void 0) {
        return scalarValue;
      }
      return "";
    }
    if (arrayName === "FUNCNAME") {
      const index2 = Number.parseInt(subscript, 10);
      if (!Number.isNaN(index2) && index2 >= 0) {
        return ctx.state.funcNameStack?.[index2] ?? "";
      }
      return "";
    }
    if (arrayName === "BASH_LINENO") {
      const index2 = Number.parseInt(subscript, 10);
      if (!Number.isNaN(index2) && index2 >= 0) {
        const line = ctx.state.callLineStack?.[index2];
        return line !== void 0 ? String(line) : "";
      }
      return "";
    }
    if (arrayName === "BASH_SOURCE") {
      const index2 = Number.parseInt(subscript, 10);
      if (!Number.isNaN(index2) && index2 >= 0) {
        return ctx.state.sourceStack?.[index2] ?? "";
      }
      return "";
    }
    const isAssoc = ctx.state.associativeArrays?.has(arrayName);
    if (isAssoc) {
      let key = unquoteKey(subscript);
      key = expandSimpleVarsInSubscript(ctx, key);
      const value3 = ctx.state.env[`${arrayName}_${key}`];
      if (value3 === void 0 && checkNounset && ctx.state.options.nounset) {
        throw new NounsetError(`${arrayName}[${subscript}]`);
      }
      return value3 || "";
    }
    let index;
    if (/^-?\d+$/.test(subscript)) {
      index = Number.parseInt(subscript, 10);
    } else {
      try {
        const parser = new Parser();
        const arithAst = parseArithmeticExpression(parser, subscript);
        index = await evaluateArithmetic(ctx, arithAst.expression);
      } catch {
        const evalValue = ctx.state.env[subscript];
        index = evalValue ? Number.parseInt(evalValue, 10) : 0;
        if (Number.isNaN(index))
          index = 0;
      }
    }
    if (index < 0) {
      const elements = getArrayElements(ctx, arrayName);
      const lineNum = ctx.state.currentLine;
      if (elements.length === 0) {
        ctx.state.expansionStderr = (ctx.state.expansionStderr || "") + `bash: line ${lineNum}: ${arrayName}: bad array subscript
`;
        return "";
      }
      const maxIndex = Math.max(...elements.map(([idx]) => typeof idx === "number" ? idx : 0));
      const actualIdx = maxIndex + 1 + index;
      if (actualIdx < 0) {
        ctx.state.expansionStderr = (ctx.state.expansionStderr || "") + `bash: line ${lineNum}: ${arrayName}: bad array subscript
`;
        return "";
      }
      const value3 = ctx.state.env[`${arrayName}_${actualIdx}`];
      return value3 || "";
    }
    const value2 = ctx.state.env[`${arrayName}_${index}`];
    if (value2 !== void 0) {
      return value2;
    }
    if (index === 0) {
      const scalarValue = ctx.state.env[arrayName];
      if (scalarValue !== void 0) {
        return scalarValue;
      }
    }
    if (checkNounset && ctx.state.options.nounset) {
      throw new NounsetError(`${arrayName}[${index}]`);
    }
    return "";
  }
  if (/^[1-9][0-9]*$/.test(name)) {
    const value2 = ctx.state.env[name];
    if (value2 === void 0 && checkNounset && ctx.state.options.nounset) {
      throw new NounsetError(name);
    }
    return value2 || "";
  }
  if (isNameref(ctx, name)) {
    const resolved = resolveNameref(ctx, name);
    if (resolved === void 0) {
      return "";
    }
    if (resolved !== name) {
      return await getVariable(ctx, resolved, checkNounset, _insideDoubleQuotes);
    }
    const value2 = ctx.state.env[name];
    if ((value2 === void 0 || value2 === "") && checkNounset && ctx.state.options.nounset) {
      throw new NounsetError(name);
    }
    return value2 || "";
  }
  const value = ctx.state.env[name];
  if (value !== void 0) {
    if (ctx.state.tempEnvBindings?.some((b) => b.has(name))) {
      ctx.state.accessedTempEnvVars = ctx.state.accessedTempEnvVars || /* @__PURE__ */ new Set();
      ctx.state.accessedTempEnvVars.add(name);
    }
    return value;
  }
  if (isArray(ctx, name)) {
    const firstValue = ctx.state.env[`${name}_0`];
    if (firstValue !== void 0) {
      return firstValue;
    }
    return "";
  }
  if (checkNounset && ctx.state.options.nounset) {
    throw new NounsetError(name);
  }
  return "";
}
__name(getVariable, "getVariable");
async function isVariableSet(ctx, name) {
  const alwaysSetSpecialVars = /* @__PURE__ */ new Set([
    "?",
    "$",
    "#",
    "_",
    "-",
    "0",
    "PPID",
    "UID",
    "EUID",
    "RANDOM",
    "SECONDS",
    "BASH_VERSION",
    "!",
    "BASHPID",
    "LINENO"
  ]);
  if (alwaysSetSpecialVars.has(name)) {
    return true;
  }
  if (name === "@" || name === "*") {
    const numParams = Number.parseInt(ctx.state.env["#"] || "0", 10);
    return numParams > 0;
  }
  if (name === "PWD" || name === "OLDPWD") {
    return name in ctx.state.env;
  }
  const bracketMatch = name.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[(.+)\]$/);
  if (bracketMatch) {
    let arrayName = bracketMatch[1];
    const subscript = bracketMatch[2];
    if (isNameref(ctx, arrayName)) {
      const resolved = resolveNameref(ctx, arrayName);
      if (resolved && resolved !== arrayName) {
        const resolvedBracket = resolved.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[(.+)\]$/);
        if (resolvedBracket) {
          return false;
        }
        arrayName = resolved;
      }
    }
    if (subscript === "@" || subscript === "*") {
      const elements = getArrayElements(ctx, arrayName);
      if (elements.length > 0)
        return true;
      return arrayName in ctx.state.env;
    }
    const isAssoc = ctx.state.associativeArrays?.has(arrayName);
    if (isAssoc) {
      const key = unquoteKey(subscript);
      return `${arrayName}_${key}` in ctx.state.env;
    }
    let index;
    if (/^-?\d+$/.test(subscript)) {
      index = Number.parseInt(subscript, 10);
    } else {
      try {
        const parser = new Parser();
        const arithAst = parseArithmeticExpression(parser, subscript);
        index = await evaluateArithmetic(ctx, arithAst.expression);
      } catch {
        const evalValue = ctx.state.env[subscript];
        index = evalValue ? Number.parseInt(evalValue, 10) : 0;
        if (Number.isNaN(index))
          index = 0;
      }
    }
    if (index < 0) {
      const elements = getArrayElements(ctx, arrayName);
      if (elements.length === 0)
        return false;
      const maxIndex = Math.max(...elements.map(([idx]) => typeof idx === "number" ? idx : 0));
      const actualIdx = maxIndex + 1 + index;
      if (actualIdx < 0)
        return false;
      return `${arrayName}_${actualIdx}` in ctx.state.env;
    }
    return `${arrayName}_${index}` in ctx.state.env;
  }
  if (isNameref(ctx, name)) {
    const resolved = resolveNameref(ctx, name);
    if (resolved === void 0 || resolved === name) {
      return name in ctx.state.env;
    }
    return isVariableSet(ctx, resolved);
  }
  if (name in ctx.state.env) {
    return true;
  }
  if (isArray(ctx, name)) {
    return true;
  }
  return false;
}
__name(isVariableSet, "isVariableSet");

// dist/interpreter/expansion/arith-text-expansion.js
async function expandDollarVarsInArithText(ctx, text) {
  let result = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "$") {
      if (text[i + 1] === "{") {
        let depth = 1;
        let j = i + 2;
        while (j < text.length && depth > 0) {
          if (text[j] === "{")
            depth++;
          else if (text[j] === "}")
            depth--;
          j++;
        }
        result += text.slice(i, j);
        i = j;
        continue;
      }
      if (text[i + 1] === "(") {
        let depth = 1;
        let j = i + 2;
        while (j < text.length && depth > 0) {
          if (text[j] === "(")
            depth++;
          else if (text[j] === ")")
            depth--;
          j++;
        }
        result += text.slice(i, j);
        i = j;
        continue;
      }
      if (/[a-zA-Z_]/.test(text[i + 1] || "")) {
        let j = i + 1;
        while (j < text.length && /[a-zA-Z0-9_]/.test(text[j])) {
          j++;
        }
        const varName = text.slice(i + 1, j);
        const value = await getVariable(ctx, varName);
        result += value;
        i = j;
        continue;
      }
      if (/[0-9]/.test(text[i + 1] || "")) {
        let j = i + 1;
        while (j < text.length && /[0-9]/.test(text[j])) {
          j++;
        }
        const varName = text.slice(i + 1, j);
        const value = await getVariable(ctx, varName);
        result += value;
        i = j;
        continue;
      }
      if (/[*@#?\-!$]/.test(text[i + 1] || "")) {
        const varName = text[i + 1];
        const value = await getVariable(ctx, varName);
        result += value;
        i += 2;
        continue;
      }
    }
    if (text[i] === '"') {
      result += '"';
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "$" && /[a-zA-Z_]/.test(text[i + 1] || "")) {
          let j = i + 1;
          while (j < text.length && /[a-zA-Z0-9_]/.test(text[j])) {
            j++;
          }
          const varName = text.slice(i + 1, j);
          const value = await getVariable(ctx, varName);
          result += value;
          i = j;
        } else if (text[i] === "\\") {
          result += text[i];
          i++;
          if (i < text.length) {
            result += text[i];
            i++;
          }
        } else {
          result += text[i];
          i++;
        }
      }
      if (i < text.length) {
        result += '"';
        i++;
      }
      continue;
    }
    result += text[i];
    i++;
  }
  return result;
}
__name(expandDollarVarsInArithText, "expandDollarVarsInArithText");
async function expandSubscriptForAssocArray(ctx, subscript) {
  let inner = subscript;
  const hasDoubleQuotes = subscript.startsWith('"') && subscript.endsWith('"');
  const hasSingleQuotes = subscript.startsWith("'") && subscript.endsWith("'");
  if (hasDoubleQuotes || hasSingleQuotes) {
    inner = subscript.slice(1, -1);
  }
  if (hasSingleQuotes) {
    return inner;
  }
  let result = "";
  let i = 0;
  while (i < inner.length) {
    if (inner[i] === "$") {
      if (inner[i + 1] === "(") {
        let depth = 1;
        let j = i + 2;
        while (j < inner.length && depth > 0) {
          if (inner[j] === "(" && inner[j - 1] === "$") {
            depth++;
          } else if (inner[j] === "(") {
            depth++;
          } else if (inner[j] === ")") {
            depth--;
          }
          j++;
        }
        const cmdStr = inner.slice(i + 2, j - 1);
        if (ctx.execFn) {
          const cmdResult = await ctx.execFn(cmdStr);
          result += cmdResult.stdout.replace(/\n+$/, "");
          if (cmdResult.stderr) {
            ctx.state.expansionStderr = (ctx.state.expansionStderr || "") + cmdResult.stderr;
          }
        }
        i = j;
      } else if (inner[i + 1] === "{") {
        let depth = 1;
        let j = i + 2;
        while (j < inner.length && depth > 0) {
          if (inner[j] === "{")
            depth++;
          else if (inner[j] === "}")
            depth--;
          j++;
        }
        const varExpr = inner.slice(i + 2, j - 1);
        const value = await getVariable(ctx, varExpr);
        result += value;
        i = j;
      } else if (/[a-zA-Z_]/.test(inner[i + 1] || "")) {
        let j = i + 1;
        while (j < inner.length && /[a-zA-Z0-9_]/.test(inner[j])) {
          j++;
        }
        const varName = inner.slice(i + 1, j);
        const value = await getVariable(ctx, varName);
        result += value;
        i = j;
      } else {
        result += inner[i];
        i++;
      }
    } else if (inner[i] === "`") {
      let j = i + 1;
      while (j < inner.length && inner[j] !== "`") {
        j++;
      }
      const cmdStr = inner.slice(i + 1, j);
      if (ctx.execFn) {
        const cmdResult = await ctx.execFn(cmdStr);
        result += cmdResult.stdout.replace(/\n+$/, "");
        if (cmdResult.stderr) {
          ctx.state.expansionStderr = (ctx.state.expansionStderr || "") + cmdResult.stderr;
        }
      }
      i = j + 1;
    } else {
      result += inner[i];
      i++;
    }
  }
  return result;
}
__name(expandSubscriptForAssocArray, "expandSubscriptForAssocArray");

// dist/interpreter/expansion/brace-range.js
var MAX_SAFE_RANGE_ITERATIONS = 1e4;
function safeExpandNumericRange(start, end, rawStep, startStr, endStr) {
  let step = rawStep ?? 1;
  if (step === 0)
    step = 1;
  const absStep = Math.abs(step);
  const results = [];
  let padWidth = 0;
  if (startStr?.match(/^-?0\d/)) {
    padWidth = Math.max(padWidth, startStr.replace(/^-/, "").length);
  }
  if (endStr?.match(/^-?0\d/)) {
    padWidth = Math.max(padWidth, endStr.replace(/^-/, "").length);
  }
  const formatNum = /* @__PURE__ */ __name((n) => {
    if (padWidth > 0) {
      const neg = n < 0;
      const absStr = String(Math.abs(n)).padStart(padWidth, "0");
      return neg ? `-${absStr}` : absStr;
    }
    return String(n);
  }, "formatNum");
  if (start <= end) {
    for (let i = start, count = 0; i <= end && count < MAX_SAFE_RANGE_ITERATIONS; i += absStep, count++) {
      results.push(formatNum(i));
    }
  } else {
    for (let i = start, count = 0; i >= end && count < MAX_SAFE_RANGE_ITERATIONS; i -= absStep, count++) {
      results.push(formatNum(i));
    }
  }
  return results;
}
__name(safeExpandNumericRange, "safeExpandNumericRange");
function safeExpandCharRange(start, end, rawStep) {
  let step = rawStep ?? 1;
  if (step === 0)
    step = 1;
  const startCode = start.charCodeAt(0);
  const endCode = end.charCodeAt(0);
  const absStep = Math.abs(step);
  const startIsUpper = start >= "A" && start <= "Z";
  const startIsLower = start >= "a" && start <= "z";
  const endIsUpper = end >= "A" && end <= "Z";
  const endIsLower = end >= "a" && end <= "z";
  if (startIsUpper && endIsLower || startIsLower && endIsUpper) {
    const stepPart = rawStep !== void 0 ? `..${rawStep}` : "";
    throw new BraceExpansionError(`{${start}..${end}${stepPart}}: invalid sequence`);
  }
  const results = [];
  if (startCode <= endCode) {
    for (let i = startCode, count = 0; i <= endCode && count < MAX_SAFE_RANGE_ITERATIONS; i += absStep, count++) {
      results.push(String.fromCharCode(i));
    }
  } else {
    for (let i = startCode, count = 0; i >= endCode && count < MAX_SAFE_RANGE_ITERATIONS; i -= absStep, count++) {
      results.push(String.fromCharCode(i));
    }
  }
  return results;
}
__name(safeExpandCharRange, "safeExpandCharRange");
function expandBraceRange(start, end, step, startStr, endStr) {
  const stepPart = step !== void 0 ? `..${step}` : "";
  if (typeof start === "number" && typeof end === "number") {
    const expanded = safeExpandNumericRange(start, end, step, startStr, endStr);
    return {
      expanded,
      literal: `{${start}..${end}${stepPart}}`
    };
  }
  if (typeof start === "string" && typeof end === "string") {
    const expanded = safeExpandCharRange(start, end, step);
    return {
      expanded,
      literal: `{${start}..${end}${stepPart}}`
    };
  }
  return {
    expanded: null,
    literal: `{${start}..${end}${stepPart}}`
  };
}
__name(expandBraceRange, "expandBraceRange");

// dist/interpreter/expansion/command-substitution.js
function getFileReadShorthand(body) {
  if (body.statements.length !== 1)
    return null;
  const statement = body.statements[0];
  if (statement.operators.length !== 0)
    return null;
  if (statement.pipelines.length !== 1)
    return null;
  const pipeline = statement.pipelines[0];
  if (pipeline.negated)
    return null;
  if (pipeline.commands.length !== 1)
    return null;
  const cmd = pipeline.commands[0];
  if (cmd.type !== "SimpleCommand")
    return null;
  const simpleCmd = cmd;
  if (simpleCmd.name !== null)
    return null;
  if (simpleCmd.args.length !== 0)
    return null;
  if (simpleCmd.assignments.length !== 0)
    return null;
  if (simpleCmd.redirections.length !== 1)
    return null;
  const redirect = simpleCmd.redirections[0];
  if (redirect.operator !== "<")
    return null;
  if (redirect.target.type !== "Word")
    return null;
  return { target: redirect.target };
}
__name(getFileReadShorthand, "getFileReadShorthand");

// dist/interpreter/expansion/glob-escape.js
function hasGlobPattern(value, extglob) {
  if (/[*?[]/.test(value)) {
    return true;
  }
  if (extglob && /[@*+?!]\(/.test(value)) {
    return true;
  }
  return false;
}
__name(hasGlobPattern, "hasGlobPattern");
function unescapeGlobPattern(pattern) {
  let result = "";
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === "\\" && i + 1 < pattern.length) {
      result += pattern[i + 1];
      i += 2;
    } else {
      result += pattern[i];
      i++;
    }
  }
  return result;
}
__name(unescapeGlobPattern, "unescapeGlobPattern");
function escapeGlobChars(str) {
  return str.replace(/([*?[\]\\()|])/g, "\\$1");
}
__name(escapeGlobChars, "escapeGlobChars");
function escapeRegexChars(str) {
  return str.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}
__name(escapeRegexChars, "escapeRegexChars");

// dist/interpreter/helpers/regex.js
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
__name(escapeRegex, "escapeRegex");

// dist/interpreter/expansion/pattern.js
function patternToRegex(pattern, greedy, extglob = false) {
  let regex = "";
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i];
    if (extglob && (char === "@" || char === "*" || char === "+" || char === "?" || char === "!") && i + 1 < pattern.length && pattern[i + 1] === "(") {
      const closeIdx = findMatchingParen2(pattern, i + 1);
      if (closeIdx !== -1) {
        const content = pattern.slice(i + 2, closeIdx);
        const alternatives = splitExtglobAlternatives2(content);
        const altRegexes = alternatives.map((alt) => patternToRegex(alt, greedy, extglob));
        const altGroup = altRegexes.length > 0 ? altRegexes.join("|") : "(?:)";
        if (char === "@") {
          regex += `(?:${altGroup})`;
        } else if (char === "*") {
          regex += `(?:${altGroup})*`;
        } else if (char === "+") {
          regex += `(?:${altGroup})+`;
        } else if (char === "?") {
          regex += `(?:${altGroup})?`;
        } else if (char === "!") {
          regex += `(?!(?:${altGroup})$).*`;
        }
        i = closeIdx + 1;
        continue;
      }
    }
    if (char === "\\") {
      if (i + 1 < pattern.length) {
        const next = pattern[i + 1];
        if (/[\\^$.|+(){}[\]*?]/.test(next)) {
          regex += `\\${next}`;
        } else {
          regex += next;
        }
        i += 2;
      } else {
        regex += "\\\\";
        i++;
      }
    } else if (char === "*") {
      regex += greedy ? ".*" : ".*?";
      i++;
    } else if (char === "?") {
      regex += ".";
      i++;
    } else if (char === "[") {
      const classEnd = findCharClassEnd(pattern, i);
      if (classEnd === -1) {
        regex += "\\[";
        i++;
      } else {
        const classContent = pattern.slice(i + 1, classEnd);
        regex += convertCharClass(classContent);
        i = classEnd + 1;
      }
    } else if (/[\^$.|+(){}]/.test(char)) {
      regex += `\\${char}`;
      i++;
    } else {
      regex += char;
      i++;
    }
  }
  return regex;
}
__name(patternToRegex, "patternToRegex");
function findMatchingParen2(pattern, openIdx) {
  let depth = 1;
  let i = openIdx + 1;
  while (i < pattern.length && depth > 0) {
    const c = pattern[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "(") {
      depth++;
    } else if (c === ")") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
    i++;
  }
  return -1;
}
__name(findMatchingParen2, "findMatchingParen");
function splitExtglobAlternatives2(content) {
  const alternatives = [];
  let current = "";
  let depth = 0;
  let i = 0;
  while (i < content.length) {
    const c = content[i];
    if (c === "\\") {
      current += c;
      if (i + 1 < content.length) {
        current += content[i + 1];
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    if (c === "(") {
      depth++;
      current += c;
    } else if (c === ")") {
      depth--;
      current += c;
    } else if (c === "|" && depth === 0) {
      alternatives.push(current);
      current = "";
    } else {
      current += c;
    }
    i++;
  }
  alternatives.push(current);
  return alternatives;
}
__name(splitExtglobAlternatives2, "splitExtglobAlternatives");
function findCharClassEnd(pattern, start) {
  let i = start + 1;
  if (i < pattern.length && pattern[i] === "^") {
    i++;
  }
  if (i < pattern.length && pattern[i] === "]") {
    i++;
  }
  while (i < pattern.length) {
    if (pattern[i] === "\\" && i + 1 < pattern.length) {
      i += 2;
      continue;
    }
    if (pattern[i] === "]") {
      return i;
    }
    if (pattern[i] === "'") {
      const closeQuote = pattern.indexOf("'", i + 1);
      if (closeQuote !== -1) {
        i = closeQuote + 1;
        continue;
      }
    }
    if (pattern[i] === "[" && i + 1 < pattern.length && pattern[i + 1] === ":") {
      const closePos = pattern.indexOf(":]", i + 2);
      if (closePos !== -1) {
        i = closePos + 2;
        continue;
      }
    }
    i++;
  }
  return -1;
}
__name(findCharClassEnd, "findCharClassEnd");
function convertCharClass(content) {
  let result = "[";
  let i = 0;
  if (content[0] === "^" || content[0] === "!") {
    result += "^";
    i++;
  }
  while (i < content.length) {
    if (content[i] === "'") {
      const closeQuote = content.indexOf("'", i + 1);
      if (closeQuote !== -1) {
        const quoted = content.slice(i + 1, closeQuote);
        for (const ch of quoted) {
          if (ch === "\\") {
            result += "\\\\";
          } else if (ch === "]") {
            result += "\\]";
          } else if (ch === "^" && result === "[") {
            result += "\\^";
          } else {
            result += ch;
          }
        }
        i = closeQuote + 1;
        continue;
      }
    }
    if (content[i] === "[" && i + 1 < content.length && content[i + 1] === ":") {
      const closePos = content.indexOf(":]", i + 2);
      if (closePos !== -1) {
        const posixClass = content.slice(i + 2, closePos);
        result += posixClassToRegex2(posixClass);
        i = closePos + 2;
        continue;
      }
    }
    const char = content[i];
    if (char === "\\") {
      if (i + 1 < content.length) {
        result += `\\${content[i + 1]}`;
        i += 2;
      } else {
        result += "\\\\";
        i++;
      }
    } else if (char === "-" && i > 0 && i < content.length - 1) {
      result += "-";
      i++;
    } else if (char === "^" && i === 0) {
      result += "^";
      i++;
    } else {
      if (char === "]" && i === 0) {
        result += "\\]";
      } else {
        result += char;
      }
      i++;
    }
  }
  result += "]";
  return result;
}
__name(convertCharClass, "convertCharClass");
var POSIX_CLASSES2 = {
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
function posixClassToRegex2(name) {
  return POSIX_CLASSES2[name] ?? "";
}
__name(posixClassToRegex2, "posixClassToRegex");

// dist/interpreter/expansion/pattern-removal.js
function applyPatternRemoval(value, regexStr, side, greedy) {
  if (side === "prefix") {
    return value.replace(new RegExp(`^${regexStr}`, "s"), "");
  }
  const regex = new RegExp(`${regexStr}$`, "s");
  if (greedy) {
    return value.replace(regex, "");
  }
  for (let i = value.length; i >= 0; i--) {
    const suffix = value.slice(i);
    if (regex.test(suffix)) {
      return value.slice(0, i);
    }
  }
  return value;
}
__name(applyPatternRemoval, "applyPatternRemoval");
function getVarNamesWithPrefix(ctx, prefix) {
  const envKeys = Object.keys(ctx.state.env);
  const matchingVars = /* @__PURE__ */ new Set();
  const assocArrays = ctx.state.associativeArrays ?? /* @__PURE__ */ new Set();
  const indexedArrays = /* @__PURE__ */ new Set();
  for (const k of envKeys) {
    const match = k.match(/^([a-zA-Z_][a-zA-Z0-9_]*)_\d+$/);
    if (match) {
      indexedArrays.add(match[1]);
    }
    const lengthMatch = k.match(/^([a-zA-Z_][a-zA-Z0-9_]*)__length$/);
    if (lengthMatch) {
      indexedArrays.add(lengthMatch[1]);
    }
  }
  const isAssocArrayElement = /* @__PURE__ */ __name((key) => {
    for (const arrayName of assocArrays) {
      const elemPrefix = `${arrayName}_`;
      if (key.startsWith(elemPrefix) && key !== arrayName) {
        return true;
      }
    }
    return false;
  }, "isAssocArrayElement");
  for (const k of envKeys) {
    if (k.startsWith(prefix)) {
      if (k.includes("__")) {
        const lengthMatch = k.match(/^([a-zA-Z_][a-zA-Z0-9_]*)__length$/);
        if (lengthMatch?.[1].startsWith(prefix)) {
          matchingVars.add(lengthMatch[1]);
        }
      } else if (/_\d+$/.test(k)) {
        const match = k.match(/^([a-zA-Z_][a-zA-Z0-9_]*)_\d+$/);
        if (match?.[1].startsWith(prefix)) {
          matchingVars.add(match[1]);
        }
      } else if (isAssocArrayElement(k)) {
      } else {
        matchingVars.add(k);
      }
    }
  }
  return [...matchingVars].sort();
}
__name(getVarNamesWithPrefix, "getVarNamesWithPrefix");

// dist/interpreter/expansion/prompt.js
function simpleStrftime(format, date) {
  const pad = /* @__PURE__ */ __name((n, width = 2) => String(n).padStart(width, "0"), "pad");
  if (format === "") {
    const h = pad(date.getHours());
    const m = pad(date.getMinutes());
    const s = pad(date.getSeconds());
    return `${h}:${m}:${s}`;
  }
  let result = "";
  let i = 0;
  while (i < format.length) {
    if (format[i] === "%") {
      if (i + 1 >= format.length) {
        result += "%";
        i++;
        continue;
      }
      const spec = format[i + 1];
      switch (spec) {
        case "H":
          result += pad(date.getHours());
          break;
        case "M":
          result += pad(date.getMinutes());
          break;
        case "S":
          result += pad(date.getSeconds());
          break;
        case "d":
          result += pad(date.getDate());
          break;
        case "m":
          result += pad(date.getMonth() + 1);
          break;
        case "Y":
          result += date.getFullYear();
          break;
        case "y":
          result += pad(date.getFullYear() % 100);
          break;
        case "I": {
          let h = date.getHours() % 12;
          if (h === 0)
            h = 12;
          result += pad(h);
          break;
        }
        case "p":
          result += date.getHours() < 12 ? "AM" : "PM";
          break;
        case "P":
          result += date.getHours() < 12 ? "am" : "pm";
          break;
        case "%":
          result += "%";
          break;
        case "a": {
          const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
          result += days[date.getDay()];
          break;
        }
        case "b": {
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
          result += months[date.getMonth()];
          break;
        }
        default:
          result += `%${spec}`;
      }
      i += 2;
    } else {
      result += format[i];
      i++;
    }
  }
  return result;
}
__name(simpleStrftime, "simpleStrftime");
function expandPrompt(ctx, value) {
  let result = "";
  let i = 0;
  const user = ctx.state.env.USER || ctx.state.env.LOGNAME || "user";
  const hostname = ctx.state.env.HOSTNAME || "localhost";
  const shortHost = hostname.split(".")[0];
  const pwd = ctx.state.env.PWD || "/";
  const home = ctx.state.env.HOME || "/";
  const tildeExpanded = pwd.startsWith(home) ? `~${pwd.slice(home.length)}` : pwd;
  const pwdBasename = pwd.split("/").pop() || pwd;
  const now = /* @__PURE__ */ new Date();
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
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
  const cmdNum = ctx.state.env.__COMMAND_NUMBER || "1";
  while (i < value.length) {
    const char = value[i];
    if (char === "\\") {
      if (i + 1 >= value.length) {
        result += "\\";
        i++;
        continue;
      }
      const next = value[i + 1];
      if (next >= "0" && next <= "7") {
        let octalStr = "";
        let j = i + 1;
        while (j < value.length && j < i + 4 && value[j] >= "0" && value[j] <= "7") {
          octalStr += value[j];
          j++;
        }
        const code = Number.parseInt(octalStr, 8) % 256;
        result += String.fromCharCode(code);
        i = j;
        continue;
      }
      switch (next) {
        case "\\":
          result += "\\";
          i += 2;
          break;
        case "a":
          result += "\x07";
          i += 2;
          break;
        case "e":
          result += "\x1B";
          i += 2;
          break;
        case "n":
          result += "\n";
          i += 2;
          break;
        case "r":
          result += "\r";
          i += 2;
          break;
        case "$":
          result += "$";
          i += 2;
          break;
        case "[":
        case "]":
          i += 2;
          break;
        case "u":
          result += user;
          i += 2;
          break;
        case "h":
          result += shortHost;
          i += 2;
          break;
        case "H":
          result += hostname;
          i += 2;
          break;
        case "w":
          result += tildeExpanded;
          i += 2;
          break;
        case "W":
          result += pwdBasename;
          i += 2;
          break;
        case "d": {
          const dayStr = String(now.getDate()).padStart(2, " ");
          result += `${weekdays[now.getDay()]} ${months[now.getMonth()]} ${dayStr}`;
          i += 2;
          break;
        }
        case "t": {
          const h = String(now.getHours()).padStart(2, "0");
          const m = String(now.getMinutes()).padStart(2, "0");
          const s = String(now.getSeconds()).padStart(2, "0");
          result += `${h}:${m}:${s}`;
          i += 2;
          break;
        }
        case "T": {
          let h = now.getHours() % 12;
          if (h === 0)
            h = 12;
          const hStr = String(h).padStart(2, "0");
          const m = String(now.getMinutes()).padStart(2, "0");
          const s = String(now.getSeconds()).padStart(2, "0");
          result += `${hStr}:${m}:${s}`;
          i += 2;
          break;
        }
        case "@": {
          let h = now.getHours() % 12;
          if (h === 0)
            h = 12;
          const hStr = String(h).padStart(2, "0");
          const m = String(now.getMinutes()).padStart(2, "0");
          const ampm = now.getHours() < 12 ? "AM" : "PM";
          result += `${hStr}:${m} ${ampm}`;
          i += 2;
          break;
        }
        case "A": {
          const h = String(now.getHours()).padStart(2, "0");
          const m = String(now.getMinutes()).padStart(2, "0");
          result += `${h}:${m}`;
          i += 2;
          break;
        }
        case "D":
          if (i + 2 < value.length && value[i + 2] === "{") {
            const closeIdx = value.indexOf("}", i + 3);
            if (closeIdx !== -1) {
              const format = value.slice(i + 3, closeIdx);
              result += simpleStrftime(format, now);
              i = closeIdx + 1;
            } else {
              result += "\\D";
              i += 2;
            }
          } else {
            result += "\\D";
            i += 2;
          }
          break;
        case "s":
          result += "bash";
          i += 2;
          break;
        case "v":
          result += "5.0";
          i += 2;
          break;
        case "V":
          result += "5.0.0";
          i += 2;
          break;
        case "j":
          result += "0";
          i += 2;
          break;
        case "l":
          result += "tty";
          i += 2;
          break;
        case "#":
          result += cmdNum;
          i += 2;
          break;
        case "!":
          result += cmdNum;
          i += 2;
          break;
        case "x":
          result += "\\x";
          i += 2;
          break;
        default:
          result += `\\${next}`;
          i += 2;
      }
    } else {
      result += char;
      i++;
    }
  }
  return result;
}
__name(expandPrompt, "expandPrompt");

// dist/interpreter/expansion/quoting.js
function quoteValue(value) {
  if (value === "")
    return "''";
  const needsDollarQuote = /[\n\r\t\x00-\x1f\x7f']/.test(value);
  if (needsDollarQuote) {
    let result = "$'";
    for (const char of value) {
      switch (char) {
        case "'":
          result += "\\'";
          break;
        case "\\":
          result += "\\\\";
          break;
        case "\n":
          result += "\\n";
          break;
        case "\r":
          result += "\\r";
          break;
        case "	":
          result += "\\t";
          break;
        default: {
          const code = char.charCodeAt(0);
          if (code < 32 || code === 127) {
            result += `\\${code.toString(8).padStart(3, "0")}`;
          } else {
            result += char;
          }
        }
      }
    }
    return `${result}'`;
  }
  return `'${value}'`;
}
__name(quoteValue, "quoteValue");

// dist/interpreter/helpers/readonly.js
function markReadonly(ctx, name) {
  ctx.state.readonlyVars = ctx.state.readonlyVars || /* @__PURE__ */ new Set();
  ctx.state.readonlyVars.add(name);
}
__name(markReadonly, "markReadonly");
function isReadonly(ctx, name) {
  return ctx.state.readonlyVars?.has(name) ?? false;
}
__name(isReadonly, "isReadonly");
function checkReadonlyError(ctx, name, command = "bash") {
  if (isReadonly(ctx, name)) {
    const stderr = `${command}: ${name}: readonly variable
`;
    throw new ExitError(1, "", stderr);
  }
  return null;
}
__name(checkReadonlyError, "checkReadonlyError");
function markExported(ctx, name) {
  const wasExported = ctx.state.exportedVars?.has(name) ?? false;
  ctx.state.exportedVars = ctx.state.exportedVars || /* @__PURE__ */ new Set();
  ctx.state.exportedVars.add(name);
  if (ctx.state.localScopes.length > 0) {
    const currentScope = ctx.state.localScopes[ctx.state.localScopes.length - 1];
    if (currentScope.has(name) && !wasExported) {
      if (!ctx.state.localExportedVars) {
        ctx.state.localExportedVars = [];
      }
      while (ctx.state.localExportedVars.length < ctx.state.localScopes.length) {
        ctx.state.localExportedVars.push(/* @__PURE__ */ new Set());
      }
      ctx.state.localExportedVars[ctx.state.localExportedVars.length - 1].add(name);
    }
  }
}
__name(markExported, "markExported");
function unmarkExported(ctx, name) {
  ctx.state.exportedVars?.delete(name);
}
__name(unmarkExported, "unmarkExported");

// dist/interpreter/expansion/variable-attrs.js
function getVariableAttributes(ctx, name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    return "";
  }
  let attrs = "";
  const isIndexedArray = ctx.state.env[`${name}__length`] !== void 0 || Object.keys(ctx.state.env).some((k) => k.startsWith(`${name}_`) && /^[0-9]+$/.test(k.slice(name.length + 1)));
  const isAssocArray = ctx.state.associativeArrays?.has(name) ?? false;
  if (isIndexedArray && !isAssocArray) {
    attrs += "a";
  }
  if (isAssocArray) {
    attrs += "A";
  }
  if (ctx.state.integerVars?.has(name)) {
    attrs += "i";
  }
  if (isNameref(ctx, name)) {
    attrs += "n";
  }
  if (isReadonly(ctx, name)) {
    attrs += "r";
  }
  if (ctx.state.exportedVars?.has(name)) {
    attrs += "x";
  }
  return attrs;
}
__name(getVariableAttributes, "getVariableAttributes");

// dist/interpreter/expansion/parameter-ops.js
async function handleDefaultValue(ctx, operation, opCtx, expandWordPartsAsync2) {
  const useDefault = opCtx.isUnset || operation.checkEmpty && opCtx.isEmpty;
  if (useDefault && operation.word) {
    return expandWordPartsAsync2(ctx, operation.word.parts, opCtx.inDoubleQuotes);
  }
  return opCtx.effectiveValue;
}
__name(handleDefaultValue, "handleDefaultValue");
async function handleAssignDefault(ctx, parameter, operation, opCtx, expandWordPartsAsync2) {
  const useDefault = opCtx.isUnset || operation.checkEmpty && opCtx.isEmpty;
  if (useDefault && operation.word) {
    const defaultValue = await expandWordPartsAsync2(ctx, operation.word.parts, opCtx.inDoubleQuotes);
    const arrayMatch = parameter.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[(.+)\]$/);
    if (arrayMatch) {
      const [, arrayName, subscriptExpr] = arrayMatch;
      let index;
      if (/^\d+$/.test(subscriptExpr)) {
        index = Number.parseInt(subscriptExpr, 10);
      } else {
        try {
          const parser = new Parser();
          const arithAst = parseArithmeticExpression(parser, subscriptExpr);
          index = await evaluateArithmetic(ctx, arithAst.expression);
        } catch {
          const varValue = ctx.state.env[subscriptExpr];
          index = varValue ? Number.parseInt(varValue, 10) : 0;
        }
        if (Number.isNaN(index))
          index = 0;
      }
      ctx.state.env[`${arrayName}_${index}`] = defaultValue;
      const currentLength = Number.parseInt(ctx.state.env[`${arrayName}__length`] || "0", 10);
      if (index >= currentLength) {
        ctx.state.env[`${arrayName}__length`] = String(index + 1);
      }
    } else {
      ctx.state.env[parameter] = defaultValue;
    }
    return defaultValue;
  }
  return opCtx.effectiveValue;
}
__name(handleAssignDefault, "handleAssignDefault");
async function handleErrorIfUnset(ctx, parameter, operation, opCtx, expandWordPartsAsync2) {
  const shouldError = opCtx.isUnset || operation.checkEmpty && opCtx.isEmpty;
  if (shouldError) {
    const message = operation.word ? await expandWordPartsAsync2(ctx, operation.word.parts, opCtx.inDoubleQuotes) : `${parameter}: parameter null or not set`;
    throw new ExitError(1, "", `bash: ${message}
`);
  }
  return opCtx.effectiveValue;
}
__name(handleErrorIfUnset, "handleErrorIfUnset");
async function handleUseAlternative(ctx, operation, opCtx, expandWordPartsAsync2) {
  const useAlternative = !(opCtx.isUnset || operation.checkEmpty && opCtx.isEmpty);
  if (useAlternative && operation.word) {
    return expandWordPartsAsync2(ctx, operation.word.parts, opCtx.inDoubleQuotes);
  }
  return "";
}
__name(handleUseAlternative, "handleUseAlternative");
async function handlePatternRemoval(ctx, value, operation, expandWordPartsAsync2, expandPart2) {
  let regexStr = "";
  const extglob = ctx.state.shoptOptions.extglob;
  if (operation.pattern) {
    for (const part of operation.pattern.parts) {
      if (part.type === "Glob") {
        regexStr += patternToRegex(part.pattern, operation.greedy, extglob);
      } else if (part.type === "Literal") {
        regexStr += patternToRegex(part.value, operation.greedy, extglob);
      } else if (part.type === "SingleQuoted" || part.type === "Escaped") {
        regexStr += escapeRegex(part.value);
      } else if (part.type === "DoubleQuoted") {
        const expanded = await expandWordPartsAsync2(ctx, part.parts);
        regexStr += escapeRegex(expanded);
      } else if (part.type === "ParameterExpansion") {
        const expanded = await expandPart2(ctx, part);
        regexStr += patternToRegex(expanded, operation.greedy, extglob);
      } else {
        const expanded = await expandPart2(ctx, part);
        regexStr += escapeRegex(expanded);
      }
    }
  }
  if (operation.side === "prefix") {
    return value.replace(new RegExp(`^${regexStr}`, "s"), "");
  }
  const regex = new RegExp(`${regexStr}$`, "s");
  if (operation.greedy) {
    return value.replace(regex, "");
  }
  for (let i = value.length; i >= 0; i--) {
    const suffix = value.slice(i);
    if (regex.test(suffix)) {
      return value.slice(0, i);
    }
  }
  return value;
}
__name(handlePatternRemoval, "handlePatternRemoval");
async function handlePatternReplacement(ctx, value, operation, expandWordPartsAsync2, expandPart2) {
  let regex = "";
  const extglob = ctx.state.shoptOptions.extglob;
  if (operation.pattern) {
    for (const part of operation.pattern.parts) {
      if (part.type === "Glob") {
        regex += patternToRegex(part.pattern, true, extglob);
      } else if (part.type === "Literal") {
        regex += patternToRegex(part.value, true, extglob);
      } else if (part.type === "SingleQuoted" || part.type === "Escaped") {
        regex += escapeRegex(part.value);
      } else if (part.type === "DoubleQuoted") {
        const expanded = await expandWordPartsAsync2(ctx, part.parts);
        regex += escapeRegex(expanded);
      } else if (part.type === "ParameterExpansion") {
        const expanded = await expandPart2(ctx, part);
        regex += patternToRegex(expanded, true, extglob);
      } else {
        const expanded = await expandPart2(ctx, part);
        regex += escapeRegex(expanded);
      }
    }
  }
  const replacement = operation.replacement ? await expandWordPartsAsync2(ctx, operation.replacement.parts) : "";
  if (operation.anchor === "start") {
    regex = `^${regex}`;
  } else if (operation.anchor === "end") {
    regex = `${regex}$`;
  }
  if (regex === "") {
    return value;
  }
  const flags = operation.all ? "gs" : "s";
  try {
    const re = new RegExp(regex, flags);
    if (operation.all) {
      let result = "";
      let lastIndex = 0;
      let match = re.exec(value);
      while (match !== null) {
        if (match[0].length === 0 && match.index === value.length) {
          break;
        }
        result += value.slice(lastIndex, match.index) + replacement;
        lastIndex = match.index + match[0].length;
        if (match[0].length === 0) {
          lastIndex++;
        }
        match = re.exec(value);
      }
      result += value.slice(lastIndex);
      return result;
    }
    return value.replace(re, replacement);
  } catch {
    return value;
  }
}
__name(handlePatternReplacement, "handlePatternReplacement");
function handleLength(ctx, parameter, value) {
  const arrayMatch = parameter.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[[@*]\]$/);
  if (arrayMatch) {
    const arrayName = arrayMatch[1];
    const elements = getArrayElements(ctx, arrayName);
    if (elements.length > 0) {
      return String(elements.length);
    }
    const scalarValue = ctx.state.env[arrayName];
    if (scalarValue !== void 0) {
      return "1";
    }
    return "0";
  }
  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(parameter) && isArray(ctx, parameter)) {
    if (parameter === "FUNCNAME") {
      const firstElement2 = ctx.state.funcNameStack?.[0] || "";
      return String([...firstElement2].length);
    }
    if (parameter === "BASH_LINENO") {
      const firstElement2 = ctx.state.callLineStack?.[0];
      return String(firstElement2 !== void 0 ? [...String(firstElement2)].length : 0);
    }
    const firstElement = ctx.state.env[`${parameter}_0`] || "";
    return String([...firstElement].length);
  }
  return String([...value].length);
}
__name(handleLength, "handleLength");
async function handleSubstring(ctx, parameter, value, operation) {
  const offset = await evaluateArithmetic(ctx, operation.offset.expression);
  const length = operation.length ? await evaluateArithmetic(ctx, operation.length.expression) : void 0;
  if (parameter === "@" || parameter === "*") {
    const numParams = Number.parseInt(ctx.state.env["#"] || "0", 10);
    const params = [];
    for (let i = 1; i <= numParams; i++) {
      params.push(ctx.state.env[String(i)] || "");
    }
    const shellName = ctx.state.env["0"] || "bash";
    let allArgs;
    let startIdx;
    if (offset <= 0) {
      allArgs = [shellName, ...params];
      if (offset < 0) {
        startIdx = allArgs.length + offset;
        if (startIdx < 0)
          return "";
      } else {
        startIdx = 0;
      }
    } else {
      allArgs = params;
      startIdx = offset - 1;
    }
    if (startIdx < 0 || startIdx >= allArgs.length) {
      return "";
    }
    if (length !== void 0) {
      const endIdx = length < 0 ? allArgs.length + length : startIdx + length;
      return allArgs.slice(startIdx, Math.max(startIdx, endIdx)).join(" ");
    }
    return allArgs.slice(startIdx).join(" ");
  }
  const arrayMatchSubstr = parameter.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[[@*]\]$/);
  if (arrayMatchSubstr) {
    const arrayName = arrayMatchSubstr[1];
    if (ctx.state.associativeArrays?.has(arrayName)) {
      throw new ExitError(1, "", `bash: \${${arrayName}[@]: 0: 3}: bad substitution
`);
    }
    const elements = getArrayElements(ctx, arrayName);
    let startIdx = 0;
    if (offset < 0) {
      if (elements.length > 0) {
        const lastIdx = elements[elements.length - 1][0];
        const maxIndex = typeof lastIdx === "number" ? lastIdx : 0;
        const targetIndex = maxIndex + 1 + offset;
        if (targetIndex < 0)
          return "";
        startIdx = elements.findIndex(([idx]) => typeof idx === "number" && idx >= targetIndex);
        if (startIdx < 0)
          return "";
      }
    } else {
      startIdx = elements.findIndex(([idx]) => typeof idx === "number" && idx >= offset);
      if (startIdx < 0)
        return "";
    }
    if (length !== void 0) {
      if (length < 0) {
        throw new ArithmeticError(`${arrayMatchSubstr[1]}[@]: substring expression < 0`);
      }
      return elements.slice(startIdx, startIdx + length).map(([, v]) => v).join(" ");
    }
    return elements.slice(startIdx).map(([, v]) => v).join(" ");
  }
  const chars = [...value];
  let start = offset;
  if (start < 0)
    start = Math.max(0, chars.length + start);
  if (length !== void 0) {
    if (length < 0) {
      const endPos = chars.length + length;
      return chars.slice(start, Math.max(start, endPos)).join("");
    }
    return chars.slice(start, start + length).join("");
  }
  return chars.slice(start).join("");
}
__name(handleSubstring, "handleSubstring");
async function handleCaseModification(ctx, value, operation, expandWordPartsAsync2, expandParameterAsync2) {
  if (operation.pattern) {
    const extglob = ctx.state.shoptOptions.extglob;
    let patternRegexStr = "";
    for (const part of operation.pattern.parts) {
      if (part.type === "Glob") {
        patternRegexStr += patternToRegex(part.pattern, true, extglob);
      } else if (part.type === "Literal") {
        patternRegexStr += patternToRegex(part.value, true, extglob);
      } else if (part.type === "SingleQuoted" || part.type === "Escaped") {
        patternRegexStr += escapeRegex(part.value);
      } else if (part.type === "DoubleQuoted") {
        const expanded = await expandWordPartsAsync2(ctx, part.parts);
        patternRegexStr += escapeRegex(expanded);
      } else if (part.type === "ParameterExpansion") {
        const expanded = await expandParameterAsync2(ctx, part);
        patternRegexStr += patternToRegex(expanded, true, extglob);
      }
    }
    const charPattern = new RegExp(`^(?:${patternRegexStr})$`);
    const transform = operation.direction === "upper" ? (c) => c.toUpperCase() : (c) => c.toLowerCase();
    let result = "";
    let converted = false;
    for (const char of value) {
      if (!operation.all && converted) {
        result += char;
      } else if (charPattern.test(char)) {
        result += transform(char);
        converted = true;
      } else {
        result += char;
      }
    }
    return result;
  }
  if (operation.direction === "upper") {
    return operation.all ? value.toUpperCase() : value.charAt(0).toUpperCase() + value.slice(1);
  }
  return operation.all ? value.toLowerCase() : value.charAt(0).toLowerCase() + value.slice(1);
}
__name(handleCaseModification, "handleCaseModification");
function handleTransform(ctx, parameter, value, isUnset, operation) {
  const arrayMatchTransform = parameter.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[[@*]\]$/);
  if (arrayMatchTransform && operation.operator === "Q") {
    const elements = getArrayElements(ctx, arrayMatchTransform[1]);
    const quotedElements = elements.map(([, v]) => quoteValue(v));
    return quotedElements.join(" ");
  }
  if (arrayMatchTransform && operation.operator === "a") {
    return getVariableAttributes(ctx, arrayMatchTransform[1]);
  }
  const arrayElemMatch = parameter.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[.+\]$/);
  if (arrayElemMatch && operation.operator === "a") {
    return getVariableAttributes(ctx, arrayElemMatch[1]);
  }
  switch (operation.operator) {
    case "Q":
      if (isUnset)
        return "";
      return quoteValue(value);
    case "P":
      return expandPrompt(ctx, value);
    case "a":
      return getVariableAttributes(ctx, parameter);
    case "A":
      if (isUnset)
        return "";
      return `${parameter}=${quoteValue(value)}`;
    case "E":
      return value.replace(/\\([\\abefnrtv'"?])/g, (_, c) => {
        switch (c) {
          case "\\":
            return "\\";
          case "a":
            return "\x07";
          case "b":
            return "\b";
          case "e":
            return "\x1B";
          case "f":
            return "\f";
          case "n":
            return "\n";
          case "r":
            return "\r";
          case "t":
            return "	";
          case "v":
            return "\v";
          case "'":
            return "'";
          case '"':
            return '"';
          case "?":
            return "?";
          default:
            return c;
        }
      });
    case "K":
    case "k":
      if (isUnset)
        return "";
      return quoteValue(value);
    case "u":
      return value.charAt(0).toUpperCase() + value.slice(1);
    case "U":
      return value.toUpperCase();
    case "L":
      return value.toLowerCase();
    default:
      return value;
  }
}
__name(handleTransform, "handleTransform");
async function handleIndirection(ctx, parameter, value, isUnset, operation, expandParameterAsync2, inDoubleQuotes = false) {
  if (isNameref(ctx, parameter)) {
    return getNamerefTarget(ctx, parameter) || "";
  }
  const isArrayExpansionPattern = /^[a-zA-Z_][a-zA-Z0-9_]*\[([@*])\]$/.test(parameter);
  if (isUnset) {
    if (operation.innerOp?.type === "UseAlternative") {
      return "";
    }
    throw new BadSubstitutionError(`\${!${parameter}}`);
  }
  const targetName = value;
  if (isArrayExpansionPattern && (targetName === "" || targetName.includes(" "))) {
    throw new BadSubstitutionError(`\${!${parameter}}`);
  }
  const arraySubscriptMatch = targetName.match(/^[a-zA-Z_][a-zA-Z0-9_]*\[(.+)\]$/);
  if (arraySubscriptMatch) {
    const subscript = arraySubscriptMatch[1];
    if (subscript.includes("~")) {
      throw new BadSubstitutionError(`\${!${parameter}}`);
    }
  }
  if (operation.innerOp) {
    const syntheticPart = {
      type: "ParameterExpansion",
      parameter: targetName,
      operation: operation.innerOp
    };
    return expandParameterAsync2(ctx, syntheticPart, inDoubleQuotes);
  }
  return await getVariable(ctx, targetName);
}
__name(handleIndirection, "handleIndirection");
function handleArrayKeys(ctx, operation) {
  const elements = getArrayElements(ctx, operation.array);
  const keys = elements.map(([k]) => String(k));
  if (operation.star) {
    return keys.join(getIfsSeparator(ctx.state.env));
  }
  return keys.join(" ");
}
__name(handleArrayKeys, "handleArrayKeys");
function handleVarNamePrefix(ctx, operation) {
  const matchingVars = getVarNamesWithPrefix(ctx, operation.prefix);
  if (operation.star) {
    return matchingVars.join(getIfsSeparator(ctx.state.env));
  }
  return matchingVars.join(" ");
}
__name(handleVarNamePrefix, "handleVarNamePrefix");
function computeIsEmpty(ctx, parameter, value, inDoubleQuotes) {
  const numParams = Number.parseInt(ctx.state.env["#"] || "0", 10);
  const arrayExpMatch = parameter.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[([@*])\]$/);
  if (parameter === "*") {
    return { isEmpty: numParams === 0, effectiveValue: value };
  }
  if (parameter === "@") {
    return {
      isEmpty: numParams === 0 || numParams === 1 && ctx.state.env["1"] === "",
      effectiveValue: value
    };
  }
  if (arrayExpMatch) {
    const [, arrayName, subscript] = arrayExpMatch;
    const elements = getArrayElements(ctx, arrayName);
    if (elements.length === 0) {
      return { isEmpty: true, effectiveValue: "" };
    }
    if (subscript === "*") {
      const ifsSep = getIfsSeparator(ctx.state.env);
      const joined = elements.map(([, v]) => v).join(ifsSep);
      return {
        isEmpty: inDoubleQuotes ? joined === "" : false,
        effectiveValue: joined
        // Use IFS-joined value instead of space-joined
      };
    }
    return {
      isEmpty: elements.length === 1 && elements.every(([, v]) => v === ""),
      effectiveValue: elements.map(([, v]) => v).join(" ")
    };
  }
  return { isEmpty: value === "", effectiveValue: value };
}
__name(computeIsEmpty, "computeIsEmpty");

// dist/interpreter/expansion/pattern-expansion.js
function patternHasCommandSubstitution(pattern) {
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) {
      i += 2;
      continue;
    }
    if (c === "'") {
      const closeIdx = pattern.indexOf("'", i + 1);
      if (closeIdx !== -1) {
        i = closeIdx + 1;
        continue;
      }
    }
    if (c === "$" && i + 1 < pattern.length && pattern[i + 1] === "(") {
      return true;
    }
    if (c === "`") {
      return true;
    }
    i++;
  }
  return false;
}
__name(patternHasCommandSubstitution, "patternHasCommandSubstitution");
function findCommandSubstitutionEnd(pattern, startIdx) {
  let depth = 1;
  let i = startIdx;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  while (i < pattern.length && depth > 0) {
    const c = pattern[i];
    if (c === "\\" && !inSingleQuote && i + 1 < pattern.length) {
      i += 2;
      continue;
    }
    if (c === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      i++;
      continue;
    }
    if (c === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      i++;
      continue;
    }
    if (!inSingleQuote && !inDoubleQuote) {
      if (c === "(") {
        depth++;
      } else if (c === ")") {
        depth--;
        if (depth === 0) {
          return i;
        }
      }
    }
    i++;
  }
  return -1;
}
__name(findCommandSubstitutionEnd, "findCommandSubstitutionEnd");
async function executeCommandSubstitutionFromString(ctx, commandStr) {
  const parser = new Parser();
  let ast;
  try {
    ast = parser.parse(commandStr);
  } catch {
    return "";
  }
  const savedBashPid = ctx.state.bashPid;
  ctx.state.bashPid = ctx.state.nextVirtualPid++;
  const savedEnv = { ...ctx.state.env };
  const savedCwd = ctx.state.cwd;
  const savedSuppressVerbose = ctx.state.suppressVerbose;
  ctx.state.suppressVerbose = true;
  try {
    const result = await ctx.executeScript(ast);
    const exitCode = result.exitCode;
    ctx.state.env = savedEnv;
    ctx.state.cwd = savedCwd;
    ctx.state.suppressVerbose = savedSuppressVerbose;
    ctx.state.lastExitCode = exitCode;
    ctx.state.env["?"] = String(exitCode);
    if (result.stderr) {
      ctx.state.expansionStderr = (ctx.state.expansionStderr || "") + result.stderr;
    }
    ctx.state.bashPid = savedBashPid;
    return result.stdout.replace(/\n+$/, "");
  } catch (error) {
    ctx.state.env = savedEnv;
    ctx.state.cwd = savedCwd;
    ctx.state.bashPid = savedBashPid;
    ctx.state.suppressVerbose = savedSuppressVerbose;
    if (error instanceof ExecutionLimitError) {
      throw error;
    }
    if (error instanceof ExitError) {
      ctx.state.lastExitCode = error.exitCode;
      ctx.state.env["?"] = String(error.exitCode);
      return error.stdout?.replace(/\n+$/, "") ?? "";
    }
    return "";
  }
}
__name(executeCommandSubstitutionFromString, "executeCommandSubstitutionFromString");
function expandVariablesInPattern(ctx, pattern) {
  let result = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "'") {
      const closeIdx = pattern.indexOf("'", i + 1);
      if (closeIdx !== -1) {
        const content = pattern.slice(i + 1, closeIdx);
        result += escapeGlobChars(content);
        i = closeIdx + 1;
        continue;
      }
    }
    if (c === '"') {
      let closeIdx = -1;
      let j = i + 1;
      while (j < pattern.length) {
        if (pattern[j] === "\\") {
          j += 2;
          continue;
        }
        if (pattern[j] === '"') {
          closeIdx = j;
          break;
        }
        j++;
      }
      if (closeIdx !== -1) {
        const content = pattern.slice(i + 1, closeIdx);
        const expanded = expandVariablesInDoubleQuotedPattern(ctx, content);
        result += escapeGlobChars(expanded);
        i = closeIdx + 1;
        continue;
      }
    }
    if (c === "$") {
      if (i + 1 < pattern.length) {
        const next = pattern[i + 1];
        if (next === "{") {
          const closeIdx = pattern.indexOf("}", i + 2);
          if (closeIdx !== -1) {
            const varName = pattern.slice(i + 2, closeIdx);
            result += ctx.state.env[varName] ?? "";
            i = closeIdx + 1;
            continue;
          }
        } else if (/[a-zA-Z_]/.test(next)) {
          let end = i + 1;
          while (end < pattern.length && /[a-zA-Z0-9_]/.test(pattern[end])) {
            end++;
          }
          const varName = pattern.slice(i + 1, end);
          result += ctx.state.env[varName] ?? "";
          i = end;
          continue;
        }
      }
    }
    if (c === "\\" && i + 1 < pattern.length) {
      result += c + pattern[i + 1];
      i += 2;
      continue;
    }
    result += c;
    i++;
  }
  return result;
}
__name(expandVariablesInPattern, "expandVariablesInPattern");
function expandVariablesInDoubleQuotedPattern(ctx, content) {
  let result = "";
  let i = 0;
  while (i < content.length) {
    const c = content[i];
    if (c === "\\" && i + 1 < content.length) {
      const next = content[i + 1];
      if (next === "$" || next === "`" || next === "\\" || next === '"') {
        result += next;
        i += 2;
        continue;
      }
      result += c;
      i++;
      continue;
    }
    if (c === "$") {
      if (i + 1 < content.length) {
        const next = content[i + 1];
        if (next === "{") {
          const closeIdx = content.indexOf("}", i + 2);
          if (closeIdx !== -1) {
            const varName = content.slice(i + 2, closeIdx);
            result += ctx.state.env[varName] ?? "";
            i = closeIdx + 1;
            continue;
          }
        } else if (/[a-zA-Z_]/.test(next)) {
          let end = i + 1;
          while (end < content.length && /[a-zA-Z0-9_]/.test(content[end])) {
            end++;
          }
          const varName = content.slice(i + 1, end);
          result += ctx.state.env[varName] ?? "";
          i = end;
          continue;
        }
      }
    }
    result += c;
    i++;
  }
  return result;
}
__name(expandVariablesInDoubleQuotedPattern, "expandVariablesInDoubleQuotedPattern");
async function expandVariablesInPatternAsync(ctx, pattern) {
  let result = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "'") {
      const closeIdx = pattern.indexOf("'", i + 1);
      if (closeIdx !== -1) {
        const content = pattern.slice(i + 1, closeIdx);
        result += escapeGlobChars(content);
        i = closeIdx + 1;
        continue;
      }
    }
    if (c === '"') {
      let closeIdx = -1;
      let j = i + 1;
      while (j < pattern.length) {
        if (pattern[j] === "\\") {
          j += 2;
          continue;
        }
        if (pattern[j] === '"') {
          closeIdx = j;
          break;
        }
        j++;
      }
      if (closeIdx !== -1) {
        const content = pattern.slice(i + 1, closeIdx);
        const expanded = await expandVariablesInDoubleQuotedPatternAsync(ctx, content);
        result += escapeGlobChars(expanded);
        i = closeIdx + 1;
        continue;
      }
    }
    if (c === "$" && i + 1 < pattern.length && pattern[i + 1] === "(") {
      const closeIdx = findCommandSubstitutionEnd(pattern, i + 2);
      if (closeIdx !== -1) {
        const commandStr = pattern.slice(i + 2, closeIdx);
        const output = await executeCommandSubstitutionFromString(ctx, commandStr);
        result += output;
        i = closeIdx + 1;
        continue;
      }
    }
    if (c === "`") {
      const closeIdx = pattern.indexOf("`", i + 1);
      if (closeIdx !== -1) {
        const commandStr = pattern.slice(i + 1, closeIdx);
        const output = await executeCommandSubstitutionFromString(ctx, commandStr);
        result += output;
        i = closeIdx + 1;
        continue;
      }
    }
    if (c === "$") {
      if (i + 1 < pattern.length) {
        const next = pattern[i + 1];
        if (next === "{") {
          const closeIdx = pattern.indexOf("}", i + 2);
          if (closeIdx !== -1) {
            const varName = pattern.slice(i + 2, closeIdx);
            result += ctx.state.env[varName] ?? "";
            i = closeIdx + 1;
            continue;
          }
        } else if (/[a-zA-Z_]/.test(next)) {
          let end = i + 1;
          while (end < pattern.length && /[a-zA-Z0-9_]/.test(pattern[end])) {
            end++;
          }
          const varName = pattern.slice(i + 1, end);
          result += ctx.state.env[varName] ?? "";
          i = end;
          continue;
        }
      }
    }
    if (c === "\\" && i + 1 < pattern.length) {
      result += c + pattern[i + 1];
      i += 2;
      continue;
    }
    result += c;
    i++;
  }
  return result;
}
__name(expandVariablesInPatternAsync, "expandVariablesInPatternAsync");
async function expandVariablesInDoubleQuotedPatternAsync(ctx, content) {
  let result = "";
  let i = 0;
  while (i < content.length) {
    const c = content[i];
    if (c === "\\" && i + 1 < content.length) {
      const next = content[i + 1];
      if (next === "$" || next === "`" || next === "\\" || next === '"') {
        result += next;
        i += 2;
        continue;
      }
      result += c;
      i++;
      continue;
    }
    if (c === "$" && i + 1 < content.length && content[i + 1] === "(") {
      const closeIdx = findCommandSubstitutionEnd(content, i + 2);
      if (closeIdx !== -1) {
        const commandStr = content.slice(i + 2, closeIdx);
        const output = await executeCommandSubstitutionFromString(ctx, commandStr);
        result += output;
        i = closeIdx + 1;
        continue;
      }
    }
    if (c === "`") {
      const closeIdx = content.indexOf("`", i + 1);
      if (closeIdx !== -1) {
        const commandStr = content.slice(i + 1, closeIdx);
        const output = await executeCommandSubstitutionFromString(ctx, commandStr);
        result += output;
        i = closeIdx + 1;
        continue;
      }
    }
    if (c === "$") {
      if (i + 1 < content.length) {
        const next = content[i + 1];
        if (next === "{") {
          const closeIdx = content.indexOf("}", i + 2);
          if (closeIdx !== -1) {
            const varName = content.slice(i + 2, closeIdx);
            result += ctx.state.env[varName] ?? "";
            i = closeIdx + 1;
            continue;
          }
        } else if (/[a-zA-Z_]/.test(next)) {
          let end = i + 1;
          while (end < content.length && /[a-zA-Z0-9_]/.test(content[end])) {
            end++;
          }
          const varName = content.slice(i + 1, end);
          result += ctx.state.env[varName] ?? "";
          i = end;
          continue;
        }
      }
    }
    result += c;
    i++;
  }
  return result;
}
__name(expandVariablesInDoubleQuotedPatternAsync, "expandVariablesInDoubleQuotedPatternAsync");

// dist/interpreter/expansion/tilde.js
function applyTildeExpansion(ctx, value) {
  if (!value.startsWith("~")) {
    return value;
  }
  const home = ctx.state.env.HOME !== void 0 ? ctx.state.env.HOME : "/home/user";
  if (value === "~" || value.startsWith("~/")) {
    return home + value.slice(1);
  }
  let i = 1;
  while (i < value.length && /[a-zA-Z0-9_-]/.test(value[i])) {
    i++;
  }
  const username = value.slice(1, i);
  const rest = value.slice(i);
  if (rest !== "" && !rest.startsWith("/")) {
    return value;
  }
  if (username === "root") {
    return `/root${rest}`;
  }
  return value;
}
__name(applyTildeExpansion, "applyTildeExpansion");

// dist/interpreter/expansion/array-pattern-ops.js
async function buildPatternRegex(ctx, pattern, expandWordPartsAsync2, expandPart2) {
  let regex = "";
  for (const part of pattern.parts) {
    if (part.type === "Glob") {
      regex += patternToRegex(part.pattern, true, ctx.state.shoptOptions.extglob);
    } else if (part.type === "Literal") {
      regex += patternToRegex(part.value, true, ctx.state.shoptOptions.extglob);
    } else if (part.type === "SingleQuoted" || part.type === "Escaped") {
      regex += escapeRegex(part.value);
    } else if (part.type === "DoubleQuoted") {
      const expanded = await expandWordPartsAsync2(ctx, part.parts);
      regex += escapeRegex(expanded);
    } else if (part.type === "ParameterExpansion") {
      const expanded = await expandPart2(ctx, part);
      regex += patternToRegex(expanded, true, ctx.state.shoptOptions.extglob);
    } else {
      const expanded = await expandPart2(ctx, part);
      regex += escapeRegex(expanded);
    }
  }
  return regex;
}
__name(buildPatternRegex, "buildPatternRegex");
async function handleArrayPatternReplacement(ctx, wordParts, expandWordPartsAsync2, expandPart2) {
  if (wordParts.length !== 1 || wordParts[0].type !== "DoubleQuoted") {
    return null;
  }
  const dqPart = wordParts[0];
  if (dqPart.parts.length !== 1 || dqPart.parts[0].type !== "ParameterExpansion" || dqPart.parts[0].operation?.type !== "PatternReplacement") {
    return null;
  }
  const paramPart = dqPart.parts[0];
  const arrayMatch = paramPart.parameter.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[([@*])\]$/);
  if (!arrayMatch) {
    return null;
  }
  const arrayName = arrayMatch[1];
  const isStar = arrayMatch[2] === "*";
  const operation = paramPart.operation;
  const elements = getArrayElements(ctx, arrayName);
  const values = elements.map(([, v]) => v);
  if (elements.length === 0) {
    const scalarValue = ctx.state.env[arrayName];
    if (scalarValue !== void 0) {
      values.push(scalarValue);
    }
  }
  if (values.length === 0) {
    return { values: [], quoted: true };
  }
  let regex = "";
  if (operation.pattern) {
    regex = await buildPatternRegex(ctx, operation.pattern, expandWordPartsAsync2, expandPart2);
  }
  const replacement = operation.replacement ? await expandWordPartsAsync2(ctx, operation.replacement.parts) : "";
  let regexPattern = regex;
  if (operation.anchor === "start") {
    regexPattern = `^${regex}`;
  } else if (operation.anchor === "end") {
    regexPattern = `${regex}$`;
  }
  const replacedValues = [];
  try {
    const re = new RegExp(regexPattern, operation.all ? "g" : "");
    for (const value of values) {
      replacedValues.push(value.replace(re, replacement));
    }
  } catch {
    replacedValues.push(...values);
  }
  if (isStar) {
    const ifsSep = getIfsSeparator(ctx.state.env);
    return { values: [replacedValues.join(ifsSep)], quoted: true };
  }
  return { values: replacedValues, quoted: true };
}
__name(handleArrayPatternReplacement, "handleArrayPatternReplacement");
async function handleArrayPatternRemoval(ctx, wordParts, expandWordPartsAsync2, expandPart2) {
  if (wordParts.length !== 1 || wordParts[0].type !== "DoubleQuoted") {
    return null;
  }
  const dqPart = wordParts[0];
  if (dqPart.parts.length !== 1 || dqPart.parts[0].type !== "ParameterExpansion" || dqPart.parts[0].operation?.type !== "PatternRemoval") {
    return null;
  }
  const paramPart = dqPart.parts[0];
  const arrayMatch = paramPart.parameter.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[([@*])\]$/);
  if (!arrayMatch) {
    return null;
  }
  const arrayName = arrayMatch[1];
  const isStar = arrayMatch[2] === "*";
  const operation = paramPart.operation;
  const elements = getArrayElements(ctx, arrayName);
  const values = elements.map(([, v]) => v);
  if (elements.length === 0) {
    const scalarValue = ctx.state.env[arrayName];
    if (scalarValue !== void 0) {
      values.push(scalarValue);
    }
  }
  if (values.length === 0) {
    return { values: [], quoted: true };
  }
  let regexStr = "";
  const extglob = ctx.state.shoptOptions.extglob;
  if (operation.pattern) {
    for (const part of operation.pattern.parts) {
      if (part.type === "Glob") {
        regexStr += patternToRegex(part.pattern, operation.greedy, extglob);
      } else if (part.type === "Literal") {
        regexStr += patternToRegex(part.value, operation.greedy, extglob);
      } else if (part.type === "SingleQuoted" || part.type === "Escaped") {
        regexStr += escapeRegex(part.value);
      } else if (part.type === "DoubleQuoted") {
        const expanded = await expandWordPartsAsync2(ctx, part.parts);
        regexStr += escapeRegex(expanded);
      } else if (part.type === "ParameterExpansion") {
        const expanded = await expandPart2(ctx, part);
        regexStr += patternToRegex(expanded, operation.greedy, extglob);
      } else {
        const expanded = await expandPart2(ctx, part);
        regexStr += escapeRegex(expanded);
      }
    }
  }
  const resultValues = [];
  for (const value of values) {
    resultValues.push(applyPatternRemoval(value, regexStr, operation.side, operation.greedy));
  }
  if (isStar) {
    const ifsSep = getIfsSeparator(ctx.state.env);
    return { values: [resultValues.join(ifsSep)], quoted: true };
  }
  return { values: resultValues, quoted: true };
}
__name(handleArrayPatternRemoval, "handleArrayPatternRemoval");

// dist/interpreter/expansion/array-prefix-suffix.js
async function handleArrayDefaultValue(ctx, wordParts) {
  if (wordParts.length !== 1 || wordParts[0].type !== "DoubleQuoted") {
    return null;
  }
  const dqPart = wordParts[0];
  if (dqPart.parts.length !== 1 || dqPart.parts[0].type !== "ParameterExpansion" || dqPart.parts[0].operation?.type !== "DefaultValue" && dqPart.parts[0].operation?.type !== "UseAlternative" && dqPart.parts[0].operation?.type !== "AssignDefault") {
    return null;
  }
  const paramPart = dqPart.parts[0];
  const op = paramPart.operation;
  const arrayMatch = paramPart.parameter.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[([@*])\]$/);
  let shouldUseAlternate;
  let outerIsStar = false;
  if (arrayMatch) {
    const arrayName = arrayMatch[1];
    outerIsStar = arrayMatch[2] === "*";
    const elements = getArrayElements(ctx, arrayName);
    const isSet = elements.length > 0 || ctx.state.env[arrayName] !== void 0;
    const isEmpty = elements.length === 0 || elements.length === 1 && elements.every(([, v]) => v === "");
    const checkEmpty = op.checkEmpty ?? false;
    if (op.type === "UseAlternative") {
      shouldUseAlternate = isSet && !(checkEmpty && isEmpty);
    } else {
      shouldUseAlternate = !isSet || checkEmpty && isEmpty;
    }
    if (!shouldUseAlternate) {
      if (elements.length > 0) {
        const values = elements.map(([, v]) => v);
        if (outerIsStar) {
          const ifsSep = getIfsSeparator(ctx.state.env);
          return { values: [values.join(ifsSep)], quoted: true };
        }
        return { values, quoted: true };
      }
      const scalarValue = ctx.state.env[arrayName];
      if (scalarValue !== void 0) {
        return { values: [scalarValue], quoted: true };
      }
      return { values: [], quoted: true };
    }
  } else {
    const varName = paramPart.parameter;
    const isSet = await isVariableSet(ctx, varName);
    const varValue = await getVariable(ctx, varName);
    const isEmpty = varValue === "";
    const checkEmpty = op.checkEmpty ?? false;
    if (op.type === "UseAlternative") {
      shouldUseAlternate = isSet && !(checkEmpty && isEmpty);
    } else {
      shouldUseAlternate = !isSet || checkEmpty && isEmpty;
    }
    if (!shouldUseAlternate) {
      return { values: [varValue], quoted: true };
    }
  }
  if (shouldUseAlternate && op.word) {
    const opWordParts = op.word.parts;
    let defaultArrayName = null;
    let defaultIsStar = false;
    for (const part of opWordParts) {
      if (part.type === "ParameterExpansion" && !part.operation) {
        const defaultMatch = part.parameter.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[([@*])\]$/);
        if (defaultMatch) {
          defaultArrayName = defaultMatch[1];
          defaultIsStar = defaultMatch[2] === "*";
          break;
        }
      }
    }
    if (defaultArrayName) {
      const defaultElements = getArrayElements(ctx, defaultArrayName);
      if (defaultElements.length > 0) {
        const values = defaultElements.map(([, v]) => v);
        if (defaultIsStar || outerIsStar) {
          const ifsSep = getIfsSeparator(ctx.state.env);
          return { values: [values.join(ifsSep)], quoted: true };
        }
        return { values, quoted: true };
      }
      const scalarValue = ctx.state.env[defaultArrayName];
      if (scalarValue !== void 0) {
        return { values: [scalarValue], quoted: true };
      }
      return { values: [], quoted: true };
    }
  }
  return null;
}
__name(handleArrayDefaultValue, "handleArrayDefaultValue");
async function handleArrayPatternWithPrefixSuffix(ctx, wordParts, hasArrayAtExpansion, expandPart2, expandWordPartsAsync2) {
  if (!hasArrayAtExpansion || wordParts.length !== 1 || wordParts[0].type !== "DoubleQuoted") {
    return null;
  }
  const dqPart = wordParts[0];
  let arrayAtIndex = -1;
  let arrayName = "";
  let isStar = false;
  let arrayOperation = null;
  for (let i = 0; i < dqPart.parts.length; i++) {
    const p = dqPart.parts[i];
    if (p.type === "ParameterExpansion" && (p.operation?.type === "PatternRemoval" || p.operation?.type === "PatternReplacement")) {
      const match = p.parameter.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[([@*])\]$/);
      if (match) {
        arrayAtIndex = i;
        arrayName = match[1];
        isStar = match[2] === "*";
        arrayOperation = p.operation;
        break;
      }
    }
  }
  if (arrayAtIndex === -1 || arrayAtIndex === 0 && arrayAtIndex === dqPart.parts.length - 1) {
    return null;
  }
  let prefix = "";
  for (let i = 0; i < arrayAtIndex; i++) {
    prefix += await expandPart2(ctx, dqPart.parts[i]);
  }
  let suffix = "";
  for (let i = arrayAtIndex + 1; i < dqPart.parts.length; i++) {
    suffix += await expandPart2(ctx, dqPart.parts[i]);
  }
  const elements = getArrayElements(ctx, arrayName);
  let values = elements.map(([, v]) => v);
  if (elements.length === 0) {
    const scalarValue = ctx.state.env[arrayName];
    if (scalarValue !== void 0) {
      values = [scalarValue];
    } else {
      if (isStar) {
        return { values: [prefix + suffix], quoted: true };
      }
      const combined = prefix + suffix;
      return { values: combined ? [combined] : [], quoted: true };
    }
  }
  if (arrayOperation?.type === "PatternRemoval") {
    const op = arrayOperation;
    let regexStr = "";
    const extglob = ctx.state.shoptOptions.extglob;
    if (op.pattern) {
      for (const part of op.pattern.parts) {
        if (part.type === "Glob") {
          regexStr += patternToRegex(part.pattern, op.greedy, extglob);
        } else if (part.type === "Literal") {
          regexStr += patternToRegex(part.value, op.greedy, extglob);
        } else if (part.type === "SingleQuoted" || part.type === "Escaped") {
          regexStr += escapeRegex(part.value);
        } else if (part.type === "DoubleQuoted") {
          const expanded = await expandWordPartsAsync2(ctx, part.parts);
          regexStr += escapeRegex(expanded);
        } else if (part.type === "ParameterExpansion") {
          const expanded = await expandPart2(ctx, part);
          regexStr += patternToRegex(expanded, op.greedy, extglob);
        } else {
          const expanded = await expandPart2(ctx, part);
          regexStr += escapeRegex(expanded);
        }
      }
    }
    values = values.map((value) => applyPatternRemoval(value, regexStr, op.side, op.greedy));
  } else if (arrayOperation?.type === "PatternReplacement") {
    const op = arrayOperation;
    let regex = "";
    if (op.pattern) {
      for (const part of op.pattern.parts) {
        if (part.type === "Glob") {
          regex += patternToRegex(part.pattern, true, ctx.state.shoptOptions.extglob);
        } else if (part.type === "Literal") {
          regex += patternToRegex(part.value, true, ctx.state.shoptOptions.extglob);
        } else if (part.type === "SingleQuoted" || part.type === "Escaped") {
          regex += escapeRegex(part.value);
        } else if (part.type === "DoubleQuoted") {
          const expanded = await expandWordPartsAsync2(ctx, part.parts);
          regex += escapeRegex(expanded);
        } else if (part.type === "ParameterExpansion") {
          const expanded = await expandPart2(ctx, part);
          regex += patternToRegex(expanded, true, ctx.state.shoptOptions.extglob);
        } else {
          const expanded = await expandPart2(ctx, part);
          regex += escapeRegex(expanded);
        }
      }
    }
    const replacement = op.replacement ? await expandWordPartsAsync2(ctx, op.replacement.parts) : "";
    let regexPattern = regex;
    if (op.anchor === "start") {
      regexPattern = `^${regex}`;
    } else if (op.anchor === "end") {
      regexPattern = `${regex}$`;
    }
    try {
      const re = new RegExp(regexPattern, op.all ? "g" : "");
      values = values.map((value) => value.replace(re, replacement));
    } catch {
    }
  }
  if (isStar) {
    const ifsSep = getIfsSeparator(ctx.state.env);
    return {
      values: [prefix + values.join(ifsSep) + suffix],
      quoted: true
    };
  }
  if (values.length === 1) {
    return { values: [prefix + values[0] + suffix], quoted: true };
  }
  const result = [
    prefix + values[0],
    ...values.slice(1, -1),
    values[values.length - 1] + suffix
  ];
  return { values: result, quoted: true };
}
__name(handleArrayPatternWithPrefixSuffix, "handleArrayPatternWithPrefixSuffix");
async function handleArrayWithPrefixSuffix(ctx, wordParts, hasArrayAtExpansion, expandPart2) {
  if (!hasArrayAtExpansion || wordParts.length !== 1 || wordParts[0].type !== "DoubleQuoted") {
    return null;
  }
  const dqPart = wordParts[0];
  let arrayAtIndex = -1;
  let arrayName = "";
  let isStar = false;
  for (let i = 0; i < dqPart.parts.length; i++) {
    const p = dqPart.parts[i];
    if (p.type === "ParameterExpansion" && !p.operation) {
      const match = p.parameter.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[([@*])\]$/);
      if (match) {
        arrayAtIndex = i;
        arrayName = match[1];
        isStar = match[2] === "*";
        break;
      }
    }
  }
  if (arrayAtIndex === -1) {
    return null;
  }
  let prefix = "";
  for (let i = 0; i < arrayAtIndex; i++) {
    prefix += await expandPart2(ctx, dqPart.parts[i]);
  }
  let suffix = "";
  for (let i = arrayAtIndex + 1; i < dqPart.parts.length; i++) {
    suffix += await expandPart2(ctx, dqPart.parts[i]);
  }
  const elements = getArrayElements(ctx, arrayName);
  const values = elements.map(([, v]) => v);
  if (elements.length === 0) {
    const scalarValue = ctx.state.env[arrayName];
    if (scalarValue !== void 0) {
      return { values: [prefix + scalarValue + suffix], quoted: true };
    }
    if (isStar) {
      return { values: [prefix + suffix], quoted: true };
    }
    const combined = prefix + suffix;
    return { values: combined ? [combined] : [], quoted: true };
  }
  if (isStar) {
    const ifsSep = getIfsSeparator(ctx.state.env);
    return {
      values: [prefix + values.join(ifsSep) + suffix],
      quoted: true
    };
  }
  if (values.length === 1) {
    return { values: [prefix + values[0] + suffix], quoted: true };
  }
  const result = [
    prefix + values[0],
    ...values.slice(1, -1),
    values[values.length - 1] + suffix
  ];
  return { values: result, quoted: true };
}
__name(handleArrayWithPrefixSuffix, "handleArrayWithPrefixSuffix");

// dist/interpreter/expansion/array-slice-transform.js
async function handleArraySlicing(ctx, wordParts, evaluateArithmetic2) {
  if (wordParts.length !== 1 || wordParts[0].type !== "DoubleQuoted") {
    return null;
  }
  const dqPart = wordParts[0];
  if (dqPart.parts.length !== 1 || dqPart.parts[0].type !== "ParameterExpansion" || dqPart.parts[0].operation?.type !== "Substring") {
    return null;
  }
  const paramPart = dqPart.parts[0];
  const arrayMatch = paramPart.parameter.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[([@*])\]$/);
  if (!arrayMatch) {
    return null;
  }
  const arrayName = arrayMatch[1];
  const isStar = arrayMatch[2] === "*";
  const operation = paramPart.operation;
  if (ctx.state.associativeArrays?.has(arrayName)) {
    throw new ExitError(1, "", `bash: \${${arrayName}[@]: 0: 3}: bad substitution
`);
  }
  const offset = operation.offset ? await evaluateArithmetic2(ctx, operation.offset.expression) : 0;
  const length = operation.length ? await evaluateArithmetic2(ctx, operation.length.expression) : void 0;
  const elements = getArrayElements(ctx, arrayName);
  let startIdx = 0;
  if (offset < 0) {
    if (elements.length > 0) {
      const lastIdx = elements[elements.length - 1][0];
      const maxIndex = typeof lastIdx === "number" ? lastIdx : 0;
      const targetIndex = maxIndex + 1 + offset;
      if (targetIndex < 0) {
        return { values: [], quoted: true };
      }
      startIdx = elements.findIndex(([idx]) => typeof idx === "number" && idx >= targetIndex);
      if (startIdx < 0)
        startIdx = elements.length;
    }
  } else {
    startIdx = elements.findIndex(([idx]) => typeof idx === "number" && idx >= offset);
    if (startIdx < 0)
      startIdx = elements.length;
  }
  let slicedValues;
  if (length !== void 0) {
    if (length < 0) {
      throw new ArithmeticError(`${arrayName}[@]: substring expression < 0`);
    }
    slicedValues = elements.slice(startIdx, startIdx + length).map(([, v]) => v);
  } else {
    slicedValues = elements.slice(startIdx).map(([, v]) => v);
  }
  if (slicedValues.length === 0) {
    return { values: [], quoted: true };
  }
  if (isStar) {
    const ifsSep = getIfsSeparator(ctx.state.env);
    return { values: [slicedValues.join(ifsSep)], quoted: true };
  }
  return { values: slicedValues, quoted: true };
}
__name(handleArraySlicing, "handleArraySlicing");
function handleArrayTransform(ctx, wordParts) {
  if (wordParts.length !== 1 || wordParts[0].type !== "DoubleQuoted") {
    return null;
  }
  const dqPart = wordParts[0];
  if (dqPart.parts.length !== 1 || dqPart.parts[0].type !== "ParameterExpansion" || dqPart.parts[0].operation?.type !== "Transform") {
    return null;
  }
  const paramPart = dqPart.parts[0];
  const arrayMatch = paramPart.parameter.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[([@*])\]$/);
  if (!arrayMatch) {
    return null;
  }
  const arrayName = arrayMatch[1];
  const isStar = arrayMatch[2] === "*";
  const operation = paramPart.operation;
  const elements = getArrayElements(ctx, arrayName);
  if (elements.length === 0) {
    const scalarValue = ctx.state.env[arrayName];
    if (scalarValue !== void 0) {
      let resultValue;
      switch (operation.operator) {
        case "a":
          resultValue = "";
          break;
        case "P":
          resultValue = expandPrompt(ctx, scalarValue);
          break;
        case "Q":
          resultValue = quoteValue(scalarValue);
          break;
        default:
          resultValue = scalarValue;
      }
      return { values: [resultValue], quoted: true };
    }
    if (isStar) {
      return { values: [""], quoted: true };
    }
    return { values: [], quoted: true };
  }
  const arrayAttr = getVariableAttributes(ctx, arrayName);
  let transformedValues;
  switch (operation.operator) {
    case "a":
      transformedValues = elements.map(() => arrayAttr);
      break;
    case "P":
      transformedValues = elements.map(([, v]) => expandPrompt(ctx, v));
      break;
    case "Q":
      transformedValues = elements.map(([, v]) => quoteValue(v));
      break;
    case "u":
      transformedValues = elements.map(([, v]) => v.charAt(0).toUpperCase() + v.slice(1));
      break;
    case "U":
      transformedValues = elements.map(([, v]) => v.toUpperCase());
      break;
    case "L":
      transformedValues = elements.map(([, v]) => v.toLowerCase());
      break;
    default:
      transformedValues = elements.map(([, v]) => v);
  }
  if (isStar) {
    const ifsSep = getIfsSeparator(ctx.state.env);
    return { values: [transformedValues.join(ifsSep)], quoted: true };
  }
  return { values: transformedValues, quoted: true };
}
__name(handleArrayTransform, "handleArrayTransform");

// dist/interpreter/expansion/array-word-expansion.js
function handleSimpleArrayExpansion(ctx, wordParts) {
  if (wordParts.length !== 1 || wordParts[0].type !== "DoubleQuoted") {
    return null;
  }
  const dqPart = wordParts[0];
  if (dqPart.parts.length !== 1 || dqPart.parts[0].type !== "ParameterExpansion") {
    return null;
  }
  const paramPart = dqPart.parts[0];
  if (paramPart.operation) {
    return null;
  }
  const arrayMatch = paramPart.parameter.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[(@)\]$/);
  if (!arrayMatch) {
    return null;
  }
  const arrayName = arrayMatch[1];
  if (isNameref(ctx, arrayName)) {
    const target = getNamerefTarget(ctx, arrayName);
    if (target?.endsWith("[@]") || target?.endsWith("[*]")) {
      return { values: [], quoted: true };
    }
  }
  const elements = getArrayElements(ctx, arrayName);
  if (elements.length > 0) {
    return { values: elements.map(([, v]) => v), quoted: true };
  }
  const scalarValue = ctx.state.env[arrayName];
  if (scalarValue !== void 0) {
    return { values: [scalarValue], quoted: true };
  }
  return { values: [], quoted: true };
}
__name(handleSimpleArrayExpansion, "handleSimpleArrayExpansion");
function handleNamerefArrayExpansion(ctx, wordParts) {
  if (wordParts.length !== 1 || wordParts[0].type !== "DoubleQuoted") {
    return null;
  }
  const dqPart = wordParts[0];
  if (dqPart.parts.length !== 1 || dqPart.parts[0].type !== "ParameterExpansion" || dqPart.parts[0].operation) {
    return null;
  }
  const paramPart = dqPart.parts[0];
  const varName = paramPart.parameter;
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(varName) || !isNameref(ctx, varName)) {
    return null;
  }
  const target = getNamerefTarget(ctx, varName);
  if (!target) {
    return null;
  }
  const targetArrayMatch = target.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[(@)\]$/);
  if (!targetArrayMatch) {
    return null;
  }
  const arrayName = targetArrayMatch[1];
  const elements = getArrayElements(ctx, arrayName);
  if (elements.length > 0) {
    return { values: elements.map(([, v]) => v), quoted: true };
  }
  const scalarValue = ctx.state.env[arrayName];
  if (scalarValue !== void 0) {
    return { values: [scalarValue], quoted: true };
  }
  return { values: [], quoted: true };
}
__name(handleNamerefArrayExpansion, "handleNamerefArrayExpansion");

// dist/interpreter/expansion/indirect-expansion.js
async function handleIndirectArrayExpansion(ctx, wordParts, hasIndirection, expandParameterAsync2, expandWordPartsAsync2) {
  if (!hasIndirection || wordParts.length !== 1 || wordParts[0].type !== "DoubleQuoted") {
    return null;
  }
  const dqPart = wordParts[0];
  if (dqPart.parts.length !== 1 || dqPart.parts[0].type !== "ParameterExpansion" || dqPart.parts[0].operation?.type !== "Indirection") {
    return null;
  }
  const paramPart = dqPart.parts[0];
  const indirOp = paramPart.operation;
  const refValue = await getVariable(ctx, paramPart.parameter);
  const arrayMatch = refValue.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[([@*])\]$/);
  if (!arrayMatch) {
    if (!indirOp.innerOp) {
      if (refValue === "@" || refValue === "*") {
        const numParams = Number.parseInt(ctx.state.env["#"] || "0", 10);
        const params = [];
        for (let i = 1; i <= numParams; i++) {
          params.push(ctx.state.env[String(i)] || "");
        }
        if (refValue === "*") {
          return {
            values: [params.join(getIfsSeparator(ctx.state.env))],
            quoted: true
          };
        }
        return { values: params, quoted: true };
      }
    }
    return null;
  }
  const arrayName = arrayMatch[1];
  const isStar = arrayMatch[2] === "*";
  const elements = getArrayElements(ctx, arrayName);
  if (indirOp.innerOp) {
    if (indirOp.innerOp.type === "Substring") {
      return handleIndirectArraySlicing(ctx, elements, arrayName, isStar, indirOp.innerOp);
    }
    if (indirOp.innerOp.type === "DefaultValue" || indirOp.innerOp.type === "UseAlternative" || indirOp.innerOp.type === "AssignDefault" || indirOp.innerOp.type === "ErrorIfUnset") {
      return handleIndirectArrayDefaultAlternative(ctx, elements, arrayName, isStar, indirOp.innerOp, expandWordPartsAsync2);
    }
    if (indirOp.innerOp.type === "Transform" && indirOp.innerOp.operator === "a") {
      const attrs = getVariableAttributes(ctx, arrayName);
      const values2 = elements.map(() => attrs);
      if (isStar) {
        return {
          values: [values2.join(getIfsSeparator(ctx.state.env))],
          quoted: true
        };
      }
      return { values: values2, quoted: true };
    }
    const values = [];
    for (const [, elemValue] of elements) {
      const syntheticPart = {
        type: "ParameterExpansion",
        parameter: "_indirect_elem_",
        operation: indirOp.innerOp
      };
      const oldVal = ctx.state.env._indirect_elem_;
      ctx.state.env._indirect_elem_ = elemValue;
      try {
        const result = await expandParameterAsync2(ctx, syntheticPart, true);
        values.push(result);
      } finally {
        if (oldVal !== void 0) {
          ctx.state.env._indirect_elem_ = oldVal;
        } else {
          delete ctx.state.env._indirect_elem_;
        }
      }
    }
    if (isStar) {
      return {
        values: [values.join(getIfsSeparator(ctx.state.env))],
        quoted: true
      };
    }
    return { values, quoted: true };
  }
  if (elements.length > 0) {
    const values = elements.map(([, v]) => v);
    if (isStar) {
      return {
        values: [values.join(getIfsSeparator(ctx.state.env))],
        quoted: true
      };
    }
    return { values, quoted: true };
  }
  const scalarValue = ctx.state.env[arrayName];
  if (scalarValue !== void 0) {
    return { values: [scalarValue], quoted: true };
  }
  return { values: [], quoted: true };
}
__name(handleIndirectArrayExpansion, "handleIndirectArrayExpansion");
async function handleIndirectArraySlicing(ctx, elements, arrayName, isStar, innerOp) {
  const offset = innerOp.offset ? await evaluateArithmetic(ctx, innerOp.offset.expression) : 0;
  const length = innerOp.length ? await evaluateArithmetic(ctx, innerOp.length.expression) : void 0;
  let startIdx = 0;
  if (offset < 0) {
    if (elements.length > 0) {
      const lastIdx = elements[elements.length - 1][0];
      const maxIndex = typeof lastIdx === "number" ? lastIdx : 0;
      const targetIndex = maxIndex + 1 + offset;
      if (targetIndex < 0)
        return { values: [], quoted: true };
      startIdx = elements.findIndex(([idx]) => typeof idx === "number" && idx >= targetIndex);
      if (startIdx < 0)
        return { values: [], quoted: true };
    }
  } else {
    startIdx = elements.findIndex(([idx]) => typeof idx === "number" && idx >= offset);
    if (startIdx < 0)
      return { values: [], quoted: true };
  }
  let slicedElements;
  if (length !== void 0) {
    if (length < 0) {
      throw new ArithmeticError(`${arrayName}[@]: substring expression < 0`);
    }
    slicedElements = elements.slice(startIdx, startIdx + length);
  } else {
    slicedElements = elements.slice(startIdx);
  }
  const values = slicedElements.map(([, v]) => v);
  if (isStar) {
    return {
      values: [values.join(getIfsSeparator(ctx.state.env))],
      quoted: true
    };
  }
  return { values, quoted: true };
}
__name(handleIndirectArraySlicing, "handleIndirectArraySlicing");
async function handleIndirectArrayDefaultAlternative(ctx, elements, arrayName, isStar, innerOp, expandWordPartsAsync2) {
  const checkEmpty = innerOp.checkEmpty ?? false;
  const values = elements.map(([, v]) => v);
  const isEmpty = elements.length === 0;
  const isUnset = elements.length === 0;
  if (innerOp.type === "UseAlternative") {
    const shouldUseAlt = !isUnset && !(checkEmpty && isEmpty);
    if (shouldUseAlt && innerOp.word) {
      const altValue = await expandWordPartsAsync2(ctx, innerOp.word.parts, true);
      return { values: [altValue], quoted: true };
    }
    return { values: [], quoted: true };
  }
  if (innerOp.type === "DefaultValue") {
    const shouldUseDefault = isUnset || checkEmpty && isEmpty;
    if (shouldUseDefault && innerOp.word) {
      const defValue = await expandWordPartsAsync2(ctx, innerOp.word.parts, true);
      return { values: [defValue], quoted: true };
    }
    if (isStar) {
      return {
        values: [values.join(getIfsSeparator(ctx.state.env))],
        quoted: true
      };
    }
    return { values, quoted: true };
  }
  if (innerOp.type === "AssignDefault") {
    const shouldAssign = isUnset || checkEmpty && isEmpty;
    if (shouldAssign && innerOp.word) {
      const assignValue = await expandWordPartsAsync2(ctx, innerOp.word.parts, true);
      ctx.state.env[`${arrayName}_0`] = assignValue;
      ctx.state.env[`${arrayName}__length`] = "1";
      return { values: [assignValue], quoted: true };
    }
    if (isStar) {
      return {
        values: [values.join(getIfsSeparator(ctx.state.env))],
        quoted: true
      };
    }
    return { values, quoted: true };
  }
  if (isStar) {
    return {
      values: [values.join(getIfsSeparator(ctx.state.env))],
      quoted: true
    };
  }
  return { values, quoted: true };
}
__name(handleIndirectArrayDefaultAlternative, "handleIndirectArrayDefaultAlternative");
async function handleIndirectInAlternative(ctx, wordParts) {
  if (wordParts.length !== 1 || wordParts[0].type !== "ParameterExpansion" || wordParts[0].operation?.type !== "UseAlternative" && wordParts[0].operation?.type !== "DefaultValue") {
    return null;
  }
  const paramPart = wordParts[0];
  const op = paramPart.operation;
  const opWord = op?.word;
  if (!opWord || opWord.parts.length !== 1 || opWord.parts[0].type !== "DoubleQuoted") {
    return null;
  }
  const innerDq = opWord.parts[0];
  if (innerDq.parts.length !== 1 || innerDq.parts[0].type !== "ParameterExpansion" || innerDq.parts[0].operation?.type !== "Indirection") {
    return null;
  }
  const innerParam = innerDq.parts[0];
  const refValue = await getVariable(ctx, innerParam.parameter);
  const arrayMatch = refValue.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[([@*])\]$/);
  if (!arrayMatch) {
    return null;
  }
  const isSet = await isVariableSet(ctx, paramPart.parameter);
  const isEmpty = await getVariable(ctx, paramPart.parameter) === "";
  const checkEmpty = op.checkEmpty ?? false;
  let shouldExpand;
  if (op.type === "UseAlternative") {
    shouldExpand = isSet && !(checkEmpty && isEmpty);
  } else {
    shouldExpand = !isSet || checkEmpty && isEmpty;
  }
  if (shouldExpand) {
    const arrayName = arrayMatch[1];
    const isStar = arrayMatch[2] === "*";
    const elements = getArrayElements(ctx, arrayName);
    if (elements.length > 0) {
      const values = elements.map(([, v]) => v);
      if (isStar) {
        return {
          values: [values.join(getIfsSeparator(ctx.state.env))],
          quoted: true
        };
      }
      return { values, quoted: true };
    }
    const scalarValue = ctx.state.env[arrayName];
    if (scalarValue !== void 0) {
      return { values: [scalarValue], quoted: true };
    }
    return { values: [], quoted: true };
  }
  return { values: [], quoted: false };
}
__name(handleIndirectInAlternative, "handleIndirectInAlternative");
async function handleIndirectionWithInnerAlternative(ctx, wordParts) {
  if (wordParts.length !== 1 || wordParts[0].type !== "ParameterExpansion" || wordParts[0].operation?.type !== "Indirection") {
    return null;
  }
  const paramPart = wordParts[0];
  const indirOp = paramPart.operation;
  const innerOp = indirOp.innerOp;
  if (!innerOp || innerOp.type !== "UseAlternative" && innerOp.type !== "DefaultValue") {
    return null;
  }
  const opWord = innerOp.word;
  if (!opWord || opWord.parts.length !== 1 || opWord.parts[0].type !== "DoubleQuoted") {
    return null;
  }
  const innerDq = opWord.parts[0];
  if (innerDq.parts.length !== 1 || innerDq.parts[0].type !== "ParameterExpansion" || innerDq.parts[0].operation?.type !== "Indirection") {
    return null;
  }
  const innerParam = innerDq.parts[0];
  const refValue = await getVariable(ctx, innerParam.parameter);
  const arrayMatch = refValue.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[([@*])\]$/);
  if (!arrayMatch) {
    return null;
  }
  const outerRefValue = await getVariable(ctx, paramPart.parameter);
  const isSet = await isVariableSet(ctx, paramPart.parameter);
  const isEmpty = outerRefValue === "";
  const checkEmpty = innerOp.checkEmpty ?? false;
  let shouldExpand;
  if (innerOp.type === "UseAlternative") {
    shouldExpand = isSet && !(checkEmpty && isEmpty);
  } else {
    shouldExpand = !isSet || checkEmpty && isEmpty;
  }
  if (shouldExpand) {
    const arrayName = arrayMatch[1];
    const isStar = arrayMatch[2] === "*";
    const elements = getArrayElements(ctx, arrayName);
    if (elements.length > 0) {
      const values = elements.map(([, v]) => v);
      if (isStar) {
        return {
          values: [values.join(getIfsSeparator(ctx.state.env))],
          quoted: true
        };
      }
      return { values, quoted: true };
    }
    const scalarValue = ctx.state.env[arrayName];
    if (scalarValue !== void 0) {
      return { values: [scalarValue], quoted: true };
    }
    return { values: [], quoted: true };
  }
  return { values: [], quoted: false };
}
__name(handleIndirectionWithInnerAlternative, "handleIndirectionWithInnerAlternative");

// dist/interpreter/expansion/positional-params.js
function getPositionalParams(ctx) {
  const numParams = Number.parseInt(ctx.state.env["#"] || "0", 10);
  const params = [];
  for (let i = 1; i <= numParams; i++) {
    params.push(ctx.state.env[String(i)] || "");
  }
  return params;
}
__name(getPositionalParams, "getPositionalParams");
async function handlePositionalSlicing(ctx, wordParts, evaluateArithmetic2, expandPart2) {
  if (wordParts.length !== 1 || wordParts[0].type !== "DoubleQuoted") {
    return null;
  }
  const dqPart = wordParts[0];
  let sliceAtIndex = -1;
  let sliceIsStar = false;
  for (let i = 0; i < dqPart.parts.length; i++) {
    const p = dqPart.parts[i];
    if (p.type === "ParameterExpansion" && (p.parameter === "@" || p.parameter === "*") && p.operation?.type === "Substring") {
      sliceAtIndex = i;
      sliceIsStar = p.parameter === "*";
      break;
    }
  }
  if (sliceAtIndex === -1) {
    return null;
  }
  const paramPart = dqPart.parts[sliceAtIndex];
  const operation = paramPart.operation;
  const offset = operation.offset ? await evaluateArithmetic2(ctx, operation.offset.expression) : 0;
  const length = operation.length ? await evaluateArithmetic2(ctx, operation.length.expression) : void 0;
  const numParams = Number.parseInt(ctx.state.env["#"] || "0", 10);
  const allParams = [];
  for (let i = 1; i <= numParams; i++) {
    allParams.push(ctx.state.env[String(i)] || "");
  }
  const shellName = ctx.state.env["0"] || "bash";
  let slicedParams;
  if (offset <= 0) {
    const withZero = [shellName, ...allParams];
    const computedIdx = withZero.length + offset;
    if (computedIdx < 0) {
      slicedParams = [];
    } else {
      const startIdx = offset < 0 ? computedIdx : 0;
      if (length !== void 0) {
        const endIdx = length < 0 ? withZero.length + length : startIdx + length;
        slicedParams = withZero.slice(startIdx, Math.max(startIdx, endIdx));
      } else {
        slicedParams = withZero.slice(startIdx);
      }
    }
  } else {
    const startIdx = offset - 1;
    if (startIdx >= allParams.length) {
      slicedParams = [];
    } else if (length !== void 0) {
      const endIdx = length < 0 ? allParams.length + length : startIdx + length;
      slicedParams = allParams.slice(startIdx, Math.max(startIdx, endIdx));
    } else {
      slicedParams = allParams.slice(startIdx);
    }
  }
  let prefix = "";
  for (let i = 0; i < sliceAtIndex; i++) {
    prefix += await expandPart2(ctx, dqPart.parts[i]);
  }
  let suffix = "";
  for (let i = sliceAtIndex + 1; i < dqPart.parts.length; i++) {
    suffix += await expandPart2(ctx, dqPart.parts[i]);
  }
  if (slicedParams.length === 0) {
    const combined = prefix + suffix;
    return { values: combined ? [combined] : [], quoted: true };
  }
  if (sliceIsStar) {
    const ifsSep = getIfsSeparator(ctx.state.env);
    return {
      values: [prefix + slicedParams.join(ifsSep) + suffix],
      quoted: true
    };
  }
  if (slicedParams.length === 1) {
    return {
      values: [prefix + slicedParams[0] + suffix],
      quoted: true
    };
  }
  const result = [
    prefix + slicedParams[0],
    ...slicedParams.slice(1, -1),
    slicedParams[slicedParams.length - 1] + suffix
  ];
  return { values: result, quoted: true };
}
__name(handlePositionalSlicing, "handlePositionalSlicing");
async function handlePositionalPatternReplacement(ctx, wordParts, expandPart2, expandWordPartsAsync2) {
  if (wordParts.length !== 1 || wordParts[0].type !== "DoubleQuoted") {
    return null;
  }
  const dqPart = wordParts[0];
  let patReplAtIndex = -1;
  let patReplIsStar = false;
  for (let i = 0; i < dqPart.parts.length; i++) {
    const p = dqPart.parts[i];
    if (p.type === "ParameterExpansion" && (p.parameter === "@" || p.parameter === "*") && p.operation?.type === "PatternReplacement") {
      patReplAtIndex = i;
      patReplIsStar = p.parameter === "*";
      break;
    }
  }
  if (patReplAtIndex === -1) {
    return null;
  }
  const paramPart = dqPart.parts[patReplAtIndex];
  const operation = paramPart.operation;
  const params = getPositionalParams(ctx);
  let prefix = "";
  for (let i = 0; i < patReplAtIndex; i++) {
    prefix += await expandPart2(ctx, dqPart.parts[i]);
  }
  let suffix = "";
  for (let i = patReplAtIndex + 1; i < dqPart.parts.length; i++) {
    suffix += await expandPart2(ctx, dqPart.parts[i]);
  }
  if (params.length === 0) {
    const combined = prefix + suffix;
    return { values: combined ? [combined] : [], quoted: true };
  }
  let regex = "";
  if (operation.pattern) {
    for (const part of operation.pattern.parts) {
      if (part.type === "Glob") {
        regex += patternToRegex(part.pattern, true, ctx.state.shoptOptions.extglob);
      } else if (part.type === "Literal") {
        regex += patternToRegex(part.value, true, ctx.state.shoptOptions.extglob);
      } else if (part.type === "SingleQuoted" || part.type === "Escaped") {
        regex += escapeRegex(part.value);
      } else if (part.type === "DoubleQuoted") {
        const expanded = await expandWordPartsAsync2(ctx, part.parts);
        regex += escapeRegex(expanded);
      } else if (part.type === "ParameterExpansion") {
        const expanded = await expandPart2(ctx, part);
        regex += patternToRegex(expanded, true, ctx.state.shoptOptions.extglob);
      } else {
        const expanded = await expandPart2(ctx, part);
        regex += escapeRegex(expanded);
      }
    }
  }
  const replacement = operation.replacement ? await expandWordPartsAsync2(ctx, operation.replacement.parts) : "";
  let regexPattern = regex;
  if (operation.anchor === "start") {
    regexPattern = `^${regex}`;
  } else if (operation.anchor === "end") {
    regexPattern = `${regex}$`;
  }
  const replacedParams = [];
  try {
    const re = new RegExp(regexPattern, operation.all ? "g" : "");
    for (const param of params) {
      replacedParams.push(param.replace(re, replacement));
    }
  } catch {
    replacedParams.push(...params);
  }
  if (patReplIsStar) {
    const ifsSep = getIfsSeparator(ctx.state.env);
    return {
      values: [prefix + replacedParams.join(ifsSep) + suffix],
      quoted: true
    };
  }
  if (replacedParams.length === 1) {
    return {
      values: [prefix + replacedParams[0] + suffix],
      quoted: true
    };
  }
  const result = [
    prefix + replacedParams[0],
    ...replacedParams.slice(1, -1),
    replacedParams[replacedParams.length - 1] + suffix
  ];
  return { values: result, quoted: true };
}
__name(handlePositionalPatternReplacement, "handlePositionalPatternReplacement");
async function handlePositionalPatternRemoval(ctx, wordParts, expandPart2, expandWordPartsAsync2) {
  if (wordParts.length !== 1 || wordParts[0].type !== "DoubleQuoted") {
    return null;
  }
  const dqPart = wordParts[0];
  let patRemAtIndex = -1;
  let patRemIsStar = false;
  for (let i = 0; i < dqPart.parts.length; i++) {
    const p = dqPart.parts[i];
    if (p.type === "ParameterExpansion" && (p.parameter === "@" || p.parameter === "*") && p.operation?.type === "PatternRemoval") {
      patRemAtIndex = i;
      patRemIsStar = p.parameter === "*";
      break;
    }
  }
  if (patRemAtIndex === -1) {
    return null;
  }
  const paramPart = dqPart.parts[patRemAtIndex];
  const operation = paramPart.operation;
  const params = getPositionalParams(ctx);
  let prefix = "";
  for (let i = 0; i < patRemAtIndex; i++) {
    prefix += await expandPart2(ctx, dqPart.parts[i]);
  }
  let suffix = "";
  for (let i = patRemAtIndex + 1; i < dqPart.parts.length; i++) {
    suffix += await expandPart2(ctx, dqPart.parts[i]);
  }
  if (params.length === 0) {
    const combined = prefix + suffix;
    return { values: combined ? [combined] : [], quoted: true };
  }
  let regexStr = "";
  const extglob = ctx.state.shoptOptions.extglob;
  if (operation.pattern) {
    for (const part of operation.pattern.parts) {
      if (part.type === "Glob") {
        regexStr += patternToRegex(part.pattern, operation.greedy, extglob);
      } else if (part.type === "Literal") {
        regexStr += patternToRegex(part.value, operation.greedy, extglob);
      } else if (part.type === "SingleQuoted" || part.type === "Escaped") {
        regexStr += escapeRegex(part.value);
      } else if (part.type === "DoubleQuoted") {
        const expanded = await expandWordPartsAsync2(ctx, part.parts);
        regexStr += escapeRegex(expanded);
      } else if (part.type === "ParameterExpansion") {
        const expanded = await expandPart2(ctx, part);
        regexStr += patternToRegex(expanded, operation.greedy, extglob);
      } else {
        const expanded = await expandPart2(ctx, part);
        regexStr += escapeRegex(expanded);
      }
    }
  }
  const strippedParams = [];
  for (const param of params) {
    strippedParams.push(applyPatternRemoval(param, regexStr, operation.side, operation.greedy));
  }
  if (patRemIsStar) {
    const ifsSep = getIfsSeparator(ctx.state.env);
    return {
      values: [prefix + strippedParams.join(ifsSep) + suffix],
      quoted: true
    };
  }
  if (strippedParams.length === 1) {
    return {
      values: [prefix + strippedParams[0] + suffix],
      quoted: true
    };
  }
  const result = [
    prefix + strippedParams[0],
    ...strippedParams.slice(1, -1),
    strippedParams[strippedParams.length - 1] + suffix
  ];
  return { values: result, quoted: true };
}
__name(handlePositionalPatternRemoval, "handlePositionalPatternRemoval");
async function handleSimplePositionalExpansion(ctx, wordParts, expandPart2) {
  if (wordParts.length !== 1 || wordParts[0].type !== "DoubleQuoted") {
    return null;
  }
  const dqPart = wordParts[0];
  let atIndex = -1;
  let isStar = false;
  for (let i = 0; i < dqPart.parts.length; i++) {
    const p = dqPart.parts[i];
    if (p.type === "ParameterExpansion" && (p.parameter === "@" || p.parameter === "*")) {
      atIndex = i;
      isStar = p.parameter === "*";
      break;
    }
  }
  if (atIndex === -1) {
    return null;
  }
  const paramPart = dqPart.parts[atIndex];
  if (paramPart.type === "ParameterExpansion" && paramPart.operation) {
    return null;
  }
  const numParams = Number.parseInt(ctx.state.env["#"] || "0", 10);
  let prefix = "";
  for (let i = 0; i < atIndex; i++) {
    prefix += await expandPart2(ctx, dqPart.parts[i]);
  }
  let suffix = "";
  for (let i = atIndex + 1; i < dqPart.parts.length; i++) {
    suffix += await expandPart2(ctx, dqPart.parts[i]);
  }
  if (numParams === 0) {
    if (isStar) {
      return { values: [prefix + suffix], quoted: true };
    }
    const combined = prefix + suffix;
    return { values: combined ? [combined] : [], quoted: true };
  }
  const params = [];
  for (let i = 1; i <= numParams; i++) {
    params.push(ctx.state.env[String(i)] || "");
  }
  if (isStar) {
    const ifsSep = getIfsSeparator(ctx.state.env);
    return {
      values: [prefix + params.join(ifsSep) + suffix],
      quoted: true
    };
  }
  if (params.length === 1) {
    return { values: [prefix + params[0] + suffix], quoted: true };
  }
  const result = [
    prefix + params[0],
    ...params.slice(1, -1),
    params[params.length - 1] + suffix
  ];
  return { values: result, quoted: true };
}
__name(handleSimplePositionalExpansion, "handleSimplePositionalExpansion");

// dist/interpreter/expansion/unquoted-expansion.js
function createGlobExpander(ctx) {
  return new GlobExpander(ctx.fs, ctx.state.cwd, ctx.state.env, {
    globstar: ctx.state.shoptOptions.globstar,
    nullglob: ctx.state.shoptOptions.nullglob,
    failglob: ctx.state.shoptOptions.failglob,
    dotglob: ctx.state.shoptOptions.dotglob,
    extglob: ctx.state.shoptOptions.extglob,
    globskipdots: ctx.state.shoptOptions.globskipdots
  });
}
__name(createGlobExpander, "createGlobExpander");
async function applyGlobExpansion(ctx, words) {
  if (ctx.state.options.noglob) {
    return words;
  }
  const globExpander = createGlobExpander(ctx);
  const expandedValues = [];
  for (const w of words) {
    if (hasGlobPattern(w, ctx.state.shoptOptions.extglob)) {
      const matches = await globExpander.expand(w);
      if (matches.length > 0) {
        expandedValues.push(...matches);
      } else if (globExpander.hasFailglob()) {
        throw new GlobError(w);
      } else if (globExpander.hasNullglob()) {
      } else {
        expandedValues.push(w);
      }
    } else {
      expandedValues.push(w);
    }
  }
  return expandedValues;
}
__name(applyGlobExpansion, "applyGlobExpansion");
async function handleUnquotedArrayPatternReplacement(ctx, wordParts, expandWordPartsAsync2, expandPart2) {
  let unquotedArrayPatReplIdx = -1;
  let unquotedArrayName = "";
  let unquotedArrayIsStar = false;
  for (let i = 0; i < wordParts.length; i++) {
    const p = wordParts[i];
    if (p.type === "ParameterExpansion" && p.operation?.type === "PatternReplacement") {
      const arrayMatch = p.parameter.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[([@*])\]$/);
      if (arrayMatch) {
        unquotedArrayPatReplIdx = i;
        unquotedArrayName = arrayMatch[1];
        unquotedArrayIsStar = arrayMatch[2] === "*";
        break;
      }
    }
  }
  if (unquotedArrayPatReplIdx === -1) {
    return null;
  }
  const paramPart = wordParts[unquotedArrayPatReplIdx];
  const operation = paramPart.operation;
  const elements = getArrayElements(ctx, unquotedArrayName);
  let values = elements.map(([, v]) => v);
  if (elements.length === 0) {
    const scalarValue = ctx.state.env[unquotedArrayName];
    if (scalarValue !== void 0) {
      values = [scalarValue];
    }
  }
  if (values.length === 0) {
    return { values: [], quoted: false };
  }
  let regex = "";
  if (operation.pattern) {
    for (const part of operation.pattern.parts) {
      if (part.type === "Glob") {
        regex += patternToRegex(part.pattern, true, ctx.state.shoptOptions.extglob);
      } else if (part.type === "Literal") {
        regex += patternToRegex(part.value, true, ctx.state.shoptOptions.extglob);
      } else if (part.type === "SingleQuoted" || part.type === "Escaped") {
        regex += escapeRegex(part.value);
      } else if (part.type === "DoubleQuoted") {
        const expanded = await expandWordPartsAsync2(ctx, part.parts);
        regex += escapeRegex(expanded);
      } else if (part.type === "ParameterExpansion") {
        const expanded = await expandPart2(ctx, part);
        regex += patternToRegex(expanded, true, ctx.state.shoptOptions.extglob);
      } else {
        const expanded = await expandPart2(ctx, part);
        regex += escapeRegex(expanded);
      }
    }
  }
  const replacement = operation.replacement ? await expandWordPartsAsync2(ctx, operation.replacement.parts) : "";
  let regexPattern = regex;
  if (operation.anchor === "start") {
    regexPattern = `^${regex}`;
  } else if (operation.anchor === "end") {
    regexPattern = `${regex}$`;
  }
  const replacedValues = [];
  try {
    const re = new RegExp(regexPattern, operation.all ? "g" : "");
    for (const value of values) {
      replacedValues.push(value.replace(re, replacement));
    }
  } catch {
    replacedValues.push(...values);
  }
  const ifsChars = getIfs(ctx.state.env);
  const ifsEmpty = isIfsEmpty(ctx.state.env);
  if (unquotedArrayIsStar) {
    const ifsSep = getIfsSeparator(ctx.state.env);
    const joined = replacedValues.join(ifsSep);
    if (ifsEmpty) {
      return { values: joined ? [joined] : [], quoted: false };
    }
    return {
      values: splitByIfsForExpansion(joined, ifsChars),
      quoted: false
    };
  }
  if (ifsEmpty) {
    return { values: replacedValues, quoted: false };
  }
  const allWords = [];
  for (const val of replacedValues) {
    if (val === "") {
      allWords.push("");
    } else {
      allWords.push(...splitByIfsForExpansion(val, ifsChars));
    }
  }
  return { values: allWords, quoted: false };
}
__name(handleUnquotedArrayPatternReplacement, "handleUnquotedArrayPatternReplacement");
async function handleUnquotedArrayPatternRemoval(ctx, wordParts, expandWordPartsAsync2, expandPart2) {
  let unquotedArrayPatRemIdx = -1;
  let unquotedArrayName = "";
  let unquotedArrayIsStar = false;
  for (let i = 0; i < wordParts.length; i++) {
    const p = wordParts[i];
    if (p.type === "ParameterExpansion" && p.operation?.type === "PatternRemoval") {
      const arrayMatch = p.parameter.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[([@*])\]$/);
      if (arrayMatch) {
        unquotedArrayPatRemIdx = i;
        unquotedArrayName = arrayMatch[1];
        unquotedArrayIsStar = arrayMatch[2] === "*";
        break;
      }
    }
  }
  if (unquotedArrayPatRemIdx === -1) {
    return null;
  }
  const paramPart = wordParts[unquotedArrayPatRemIdx];
  const operation = paramPart.operation;
  const elements = getArrayElements(ctx, unquotedArrayName);
  let values = elements.map(([, v]) => v);
  if (elements.length === 0) {
    const scalarValue = ctx.state.env[unquotedArrayName];
    if (scalarValue !== void 0) {
      values = [scalarValue];
    }
  }
  if (values.length === 0) {
    return { values: [], quoted: false };
  }
  let regexStr = "";
  const extglob = ctx.state.shoptOptions.extglob;
  if (operation.pattern) {
    for (const part of operation.pattern.parts) {
      if (part.type === "Glob") {
        regexStr += patternToRegex(part.pattern, operation.greedy, extglob);
      } else if (part.type === "Literal") {
        regexStr += patternToRegex(part.value, operation.greedy, extglob);
      } else if (part.type === "SingleQuoted" || part.type === "Escaped") {
        regexStr += escapeRegex(part.value);
      } else if (part.type === "DoubleQuoted") {
        const expanded = await expandWordPartsAsync2(ctx, part.parts);
        regexStr += escapeRegex(expanded);
      } else if (part.type === "ParameterExpansion") {
        const expanded = await expandPart2(ctx, part);
        regexStr += patternToRegex(expanded, operation.greedy, extglob);
      } else {
        const expanded = await expandPart2(ctx, part);
        regexStr += escapeRegex(expanded);
      }
    }
  }
  const strippedValues = [];
  for (const value of values) {
    strippedValues.push(applyPatternRemoval(value, regexStr, operation.side, operation.greedy));
  }
  const ifsChars = getIfs(ctx.state.env);
  const ifsEmpty = isIfsEmpty(ctx.state.env);
  if (unquotedArrayIsStar) {
    const ifsSep = getIfsSeparator(ctx.state.env);
    const joined = strippedValues.join(ifsSep);
    if (ifsEmpty) {
      return { values: joined ? [joined] : [], quoted: false };
    }
    return {
      values: splitByIfsForExpansion(joined, ifsChars),
      quoted: false
    };
  }
  if (ifsEmpty) {
    return { values: strippedValues, quoted: false };
  }
  const allWords = [];
  for (const val of strippedValues) {
    if (val === "") {
      allWords.push("");
    } else {
      allWords.push(...splitByIfsForExpansion(val, ifsChars));
    }
  }
  return { values: allWords, quoted: false };
}
__name(handleUnquotedArrayPatternRemoval, "handleUnquotedArrayPatternRemoval");
async function handleUnquotedPositionalPatternRemoval(ctx, wordParts, expandWordPartsAsync2, expandPart2) {
  let unquotedPosPatRemIdx = -1;
  let unquotedPosPatRemIsStar = false;
  for (let i = 0; i < wordParts.length; i++) {
    const p = wordParts[i];
    if (p.type === "ParameterExpansion" && (p.parameter === "@" || p.parameter === "*") && p.operation?.type === "PatternRemoval") {
      unquotedPosPatRemIdx = i;
      unquotedPosPatRemIsStar = p.parameter === "*";
      break;
    }
  }
  if (unquotedPosPatRemIdx === -1) {
    return null;
  }
  const paramPart = wordParts[unquotedPosPatRemIdx];
  const operation = paramPart.operation;
  const numParams = Number.parseInt(ctx.state.env["#"] || "0", 10);
  const params = [];
  for (let i = 1; i <= numParams; i++) {
    params.push(ctx.state.env[String(i)] || "");
  }
  if (params.length === 0) {
    return { values: [], quoted: false };
  }
  let regexStr = "";
  const extglob = ctx.state.shoptOptions.extglob;
  if (operation.pattern) {
    for (const part of operation.pattern.parts) {
      if (part.type === "Glob") {
        regexStr += patternToRegex(part.pattern, operation.greedy, extglob);
      } else if (part.type === "Literal") {
        regexStr += patternToRegex(part.value, operation.greedy, extglob);
      } else if (part.type === "SingleQuoted" || part.type === "Escaped") {
        regexStr += escapeRegex(part.value);
      } else if (part.type === "DoubleQuoted") {
        const expanded = await expandWordPartsAsync2(ctx, part.parts);
        regexStr += escapeRegex(expanded);
      } else if (part.type === "ParameterExpansion") {
        const expanded = await expandPart2(ctx, part);
        regexStr += patternToRegex(expanded, operation.greedy, extglob);
      } else {
        const expanded = await expandPart2(ctx, part);
        regexStr += escapeRegex(expanded);
      }
    }
  }
  const strippedParams = [];
  for (const param of params) {
    strippedParams.push(applyPatternRemoval(param, regexStr, operation.side, operation.greedy));
  }
  const ifsChars = getIfs(ctx.state.env);
  const ifsEmpty = isIfsEmpty(ctx.state.env);
  if (unquotedPosPatRemIsStar) {
    const ifsSep = getIfsSeparator(ctx.state.env);
    const joined = strippedParams.join(ifsSep);
    if (ifsEmpty) {
      return { values: joined ? [joined] : [], quoted: false };
    }
    return {
      values: splitByIfsForExpansion(joined, ifsChars),
      quoted: false
    };
  }
  if (ifsEmpty) {
    return { values: strippedParams, quoted: false };
  }
  const allWords = [];
  for (const val of strippedParams) {
    if (val === "") {
      allWords.push("");
    } else {
      allWords.push(...splitByIfsForExpansion(val, ifsChars));
    }
  }
  return { values: allWords, quoted: false };
}
__name(handleUnquotedPositionalPatternRemoval, "handleUnquotedPositionalPatternRemoval");
async function handleUnquotedPositionalSlicing(ctx, wordParts, evaluateArithmetic2, expandPart2) {
  let unquotedSliceAtIndex = -1;
  let unquotedSliceIsStar = false;
  for (let i = 0; i < wordParts.length; i++) {
    const p = wordParts[i];
    if (p.type === "ParameterExpansion" && (p.parameter === "@" || p.parameter === "*") && p.operation?.type === "Substring") {
      unquotedSliceAtIndex = i;
      unquotedSliceIsStar = p.parameter === "*";
      break;
    }
  }
  if (unquotedSliceAtIndex === -1) {
    return null;
  }
  const paramPart = wordParts[unquotedSliceAtIndex];
  const operation = paramPart.operation;
  const offset = operation.offset ? await evaluateArithmetic2(ctx, operation.offset.expression) : 0;
  const length = operation.length ? await evaluateArithmetic2(ctx, operation.length.expression) : void 0;
  const numParams = Number.parseInt(ctx.state.env["#"] || "0", 10);
  const allParams = [];
  for (let i = 1; i <= numParams; i++) {
    allParams.push(ctx.state.env[String(i)] || "");
  }
  const shellName = ctx.state.env["0"] || "bash";
  let slicedParams;
  if (offset <= 0) {
    const withZero = [shellName, ...allParams];
    const computedIdx = withZero.length + offset;
    if (computedIdx < 0) {
      slicedParams = [];
    } else {
      const startIdx = offset < 0 ? computedIdx : 0;
      if (length !== void 0) {
        const endIdx = length < 0 ? withZero.length + length : startIdx + length;
        slicedParams = withZero.slice(startIdx, Math.max(startIdx, endIdx));
      } else {
        slicedParams = withZero.slice(startIdx);
      }
    }
  } else {
    const startIdx = offset - 1;
    if (startIdx >= allParams.length) {
      slicedParams = [];
    } else if (length !== void 0) {
      const endIdx = length < 0 ? allParams.length + length : startIdx + length;
      slicedParams = allParams.slice(startIdx, Math.max(startIdx, endIdx));
    } else {
      slicedParams = allParams.slice(startIdx);
    }
  }
  let prefix = "";
  for (let i = 0; i < unquotedSliceAtIndex; i++) {
    prefix += await expandPart2(ctx, wordParts[i]);
  }
  let suffix = "";
  for (let i = unquotedSliceAtIndex + 1; i < wordParts.length; i++) {
    suffix += await expandPart2(ctx, wordParts[i]);
  }
  const ifsChars = getIfs(ctx.state.env);
  const ifsEmpty = isIfsEmpty(ctx.state.env);
  if (slicedParams.length === 0) {
    const combined = prefix + suffix;
    if (!combined) {
      return { values: [], quoted: false };
    }
    if (ifsEmpty) {
      return { values: [combined], quoted: false };
    }
    return {
      values: splitByIfsForExpansion(combined, ifsChars),
      quoted: false
    };
  }
  let allWords;
  if (unquotedSliceIsStar) {
    const ifsSep = getIfsSeparator(ctx.state.env);
    const joined = prefix + slicedParams.join(ifsSep) + suffix;
    if (ifsEmpty) {
      allWords = joined ? [joined] : [];
    } else {
      allWords = splitByIfsForExpansion(joined, ifsChars);
    }
  } else {
    if (ifsEmpty) {
      if (slicedParams.length === 1) {
        allWords = [prefix + slicedParams[0] + suffix];
      } else {
        allWords = [
          prefix + slicedParams[0],
          ...slicedParams.slice(1, -1),
          slicedParams[slicedParams.length - 1] + suffix
        ];
      }
    } else {
      allWords = [];
      for (let i = 0; i < slicedParams.length; i++) {
        let param = slicedParams[i];
        if (i === 0)
          param = prefix + param;
        if (i === slicedParams.length - 1)
          param = param + suffix;
        if (param === "") {
          allWords.push("");
        } else {
          const parts = splitByIfsForExpansion(param, ifsChars);
          allWords.push(...parts);
        }
      }
    }
  }
  return { values: await applyGlobExpansion(ctx, allWords), quoted: false };
}
__name(handleUnquotedPositionalSlicing, "handleUnquotedPositionalSlicing");
async function handleUnquotedSimplePositional(ctx, wordParts) {
  if (wordParts.length !== 1 || wordParts[0].type !== "ParameterExpansion" || wordParts[0].parameter !== "@" && wordParts[0].parameter !== "*" || wordParts[0].operation) {
    return null;
  }
  const isStar = wordParts[0].parameter === "*";
  const numParams = Number.parseInt(ctx.state.env["#"] || "0", 10);
  if (numParams === 0) {
    return { values: [], quoted: false };
  }
  const params = [];
  for (let i = 1; i <= numParams; i++) {
    params.push(ctx.state.env[String(i)] || "");
  }
  const ifsChars = getIfs(ctx.state.env);
  const ifsEmpty = isIfsEmpty(ctx.state.env);
  const ifsWhitespaceOnly = isIfsWhitespaceOnly(ctx.state.env);
  let allWords;
  if (isStar) {
    if (ifsEmpty) {
      allWords = params.filter((p) => p !== "");
    } else {
      const ifsSep = getIfsSeparator(ctx.state.env);
      const joined = params.join(ifsSep);
      allWords = splitByIfsForExpansion(joined, ifsChars);
    }
  } else {
    if (ifsEmpty) {
      allWords = params.filter((p) => p !== "");
    } else if (ifsWhitespaceOnly) {
      allWords = [];
      for (const param of params) {
        if (param === "") {
          continue;
        }
        const parts = splitByIfsForExpansion(param, ifsChars);
        allWords.push(...parts);
      }
    } else {
      allWords = [];
      for (const param of params) {
        if (param === "") {
          allWords.push("");
        } else {
          const parts = splitByIfsForExpansion(param, ifsChars);
          allWords.push(...parts);
        }
      }
      while (allWords.length > 0 && allWords[allWords.length - 1] === "") {
        allWords.pop();
      }
    }
  }
  return { values: await applyGlobExpansion(ctx, allWords), quoted: false };
}
__name(handleUnquotedSimplePositional, "handleUnquotedSimplePositional");
async function handleUnquotedSimpleArray(ctx, wordParts) {
  if (wordParts.length !== 1 || wordParts[0].type !== "ParameterExpansion" || wordParts[0].operation) {
    return null;
  }
  const arrayMatch = wordParts[0].parameter.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[([@*])\]$/);
  if (!arrayMatch) {
    return null;
  }
  const arrayName = arrayMatch[1];
  const isStar = arrayMatch[2] === "*";
  const elements = getArrayElements(ctx, arrayName);
  let values;
  if (elements.length === 0) {
    const scalarValue = ctx.state.env[arrayName];
    if (scalarValue !== void 0) {
      values = [scalarValue];
    } else {
      return { values: [], quoted: false };
    }
  } else {
    values = elements.map(([, v]) => v);
  }
  const ifsChars = getIfs(ctx.state.env);
  const ifsEmpty = isIfsEmpty(ctx.state.env);
  const ifsWhitespaceOnly = isIfsWhitespaceOnly(ctx.state.env);
  let allWords;
  if (isStar) {
    if (ifsEmpty) {
      allWords = values.filter((v) => v !== "");
    } else {
      const ifsSep = getIfsSeparator(ctx.state.env);
      const joined = values.join(ifsSep);
      allWords = splitByIfsForExpansion(joined, ifsChars);
    }
  } else {
    if (ifsEmpty) {
      allWords = values.filter((v) => v !== "");
    } else if (ifsWhitespaceOnly) {
      allWords = [];
      for (const val of values) {
        if (val === "") {
          continue;
        }
        const parts = splitByIfsForExpansion(val, ifsChars);
        allWords.push(...parts);
      }
    } else {
      allWords = [];
      for (const val of values) {
        if (val === "") {
          allWords.push("");
        } else {
          const parts = splitByIfsForExpansion(val, ifsChars);
          allWords.push(...parts);
        }
      }
      while (allWords.length > 0 && allWords[allWords.length - 1] === "") {
        allWords.pop();
      }
    }
  }
  return { values: await applyGlobExpansion(ctx, allWords), quoted: false };
}
__name(handleUnquotedSimpleArray, "handleUnquotedSimpleArray");
function handleUnquotedVarNamePrefix(ctx, wordParts) {
  if (wordParts.length !== 1 || wordParts[0].type !== "ParameterExpansion" || wordParts[0].operation?.type !== "VarNamePrefix") {
    return null;
  }
  const op = wordParts[0].operation;
  const matchingVars = getVarNamesWithPrefix(ctx, op.prefix);
  if (matchingVars.length === 0) {
    return { values: [], quoted: false };
  }
  const ifsChars = getIfs(ctx.state.env);
  const ifsEmpty = isIfsEmpty(ctx.state.env);
  let allWords;
  if (op.star) {
    if (ifsEmpty) {
      allWords = matchingVars;
    } else {
      const ifsSep = getIfsSeparator(ctx.state.env);
      const joined = matchingVars.join(ifsSep);
      allWords = splitByIfsForExpansion(joined, ifsChars);
    }
  } else {
    if (ifsEmpty) {
      allWords = matchingVars;
    } else {
      allWords = [];
      for (const name of matchingVars) {
        const parts = splitByIfsForExpansion(name, ifsChars);
        allWords.push(...parts);
      }
    }
  }
  return { values: allWords, quoted: false };
}
__name(handleUnquotedVarNamePrefix, "handleUnquotedVarNamePrefix");
function handleUnquotedArrayKeys(ctx, wordParts) {
  if (wordParts.length !== 1 || wordParts[0].type !== "ParameterExpansion" || wordParts[0].operation?.type !== "ArrayKeys") {
    return null;
  }
  const op = wordParts[0].operation;
  const elements = getArrayElements(ctx, op.array);
  const keys = elements.map(([k]) => String(k));
  if (keys.length === 0) {
    return { values: [], quoted: false };
  }
  const ifsChars = getIfs(ctx.state.env);
  const ifsEmpty = isIfsEmpty(ctx.state.env);
  let allWords;
  if (op.star) {
    if (ifsEmpty) {
      allWords = keys;
    } else {
      const ifsSep = getIfsSeparator(ctx.state.env);
      const joined = keys.join(ifsSep);
      allWords = splitByIfsForExpansion(joined, ifsChars);
    }
  } else {
    if (ifsEmpty) {
      allWords = keys;
    } else {
      allWords = [];
      for (const key of keys) {
        const parts = splitByIfsForExpansion(key, ifsChars);
        allWords.push(...parts);
      }
    }
  }
  return { values: allWords, quoted: false };
}
__name(handleUnquotedArrayKeys, "handleUnquotedArrayKeys");
async function handleUnquotedPositionalWithPrefixSuffix(ctx, wordParts, expandPart2) {
  let unquotedAtStarIndex = -1;
  for (let i = 0; i < wordParts.length; i++) {
    const p = wordParts[i];
    if (p.type === "ParameterExpansion" && (p.parameter === "@" || p.parameter === "*") && !p.operation) {
      unquotedAtStarIndex = i;
      break;
    }
  }
  if (unquotedAtStarIndex === -1 || wordParts.length <= 1) {
    return null;
  }
  const numParams = Number.parseInt(ctx.state.env["#"] || "0", 10);
  const params = [];
  for (let i = 1; i <= numParams; i++) {
    params.push(ctx.state.env[String(i)] || "");
  }
  let prefix = "";
  for (let i = 0; i < unquotedAtStarIndex; i++) {
    prefix += await expandPart2(ctx, wordParts[i]);
  }
  let suffix = "";
  for (let i = unquotedAtStarIndex + 1; i < wordParts.length; i++) {
    suffix += await expandPart2(ctx, wordParts[i]);
  }
  const ifsChars = getIfs(ctx.state.env);
  const ifsEmpty = isIfsEmpty(ctx.state.env);
  const ifsWhitespaceOnly = isIfsWhitespaceOnly(ctx.state.env);
  if (numParams === 0) {
    const combined = prefix + suffix;
    return { values: combined ? [combined] : [], quoted: false };
  }
  let words;
  {
    const rawWords = [];
    for (let i = 0; i < params.length; i++) {
      let word = params[i];
      if (i === 0)
        word = prefix + word;
      if (i === params.length - 1)
        word = word + suffix;
      rawWords.push(word);
    }
    if (ifsEmpty) {
      words = rawWords.filter((w) => w !== "");
    } else if (ifsWhitespaceOnly) {
      words = [];
      for (const word of rawWords) {
        if (word === "")
          continue;
        const parts = splitByIfsForExpansion(word, ifsChars);
        words.push(...parts);
      }
    } else {
      words = [];
      for (const word of rawWords) {
        if (word === "") {
          words.push("");
        } else {
          const parts = splitByIfsForExpansion(word, ifsChars);
          words.push(...parts);
        }
      }
      while (words.length > 0 && words[words.length - 1] === "") {
        words.pop();
      }
    }
  }
  if (words.length === 0) {
    return { values: [], quoted: false };
  }
  return { values: await applyGlobExpansion(ctx, words), quoted: false };
}
__name(handleUnquotedPositionalWithPrefixSuffix, "handleUnquotedPositionalWithPrefixSuffix");

// dist/interpreter/expansion/word-glob-expansion.js
async function expandWordWithGlobImpl(ctx, word, deps) {
  const wordParts = word.parts;
  const { hasQuoted, hasCommandSub, hasArrayVar, hasArrayAtExpansion, hasParamExpansion, hasVarNamePrefixExpansion, hasIndirection } = analyzeWordParts(wordParts);
  const hasBraces = deps.hasBraceExpansion(wordParts);
  const braceExpanded = hasBraces ? await deps.expandWordWithBracesAsync(ctx, word) : null;
  if (braceExpanded && braceExpanded.length > 1) {
    return handleBraceExpansionResults(ctx, braceExpanded, hasQuoted);
  }
  const arrayResult = await handleArrayExpansionCases(ctx, wordParts, hasArrayAtExpansion, hasVarNamePrefixExpansion, hasIndirection, deps);
  if (arrayResult !== null) {
    return arrayResult;
  }
  const positionalResult = await handlePositionalExpansionCases(ctx, wordParts, deps);
  if (positionalResult !== null) {
    return positionalResult;
  }
  const unquotedResult = await handleUnquotedExpansionCases(ctx, wordParts, deps);
  if (unquotedResult !== null) {
    return unquotedResult;
  }
  const mixedWordResult = await expandMixedWordParts(ctx, wordParts, deps.expandPart);
  if (mixedWordResult !== null) {
    return applyGlobToValues(ctx, mixedWordResult);
  }
  if ((hasCommandSub || hasArrayVar || hasParamExpansion) && !isIfsEmpty(ctx.state.env)) {
    const ifsChars = getIfs(ctx.state.env);
    const ifsPattern = deps.buildIfsCharClassPattern(ifsChars);
    const splitResult = await deps.smartWordSplit(ctx, wordParts, ifsChars, ifsPattern, deps.expandPart);
    return applyGlobToValues(ctx, splitResult);
  }
  const value = await deps.expandWordAsync(ctx, word);
  return handleFinalGlobExpansion(ctx, word, wordParts, value, hasQuoted, deps.expandWordForGlobbing);
}
__name(expandWordWithGlobImpl, "expandWordWithGlobImpl");
async function handleBraceExpansionResults(ctx, braceExpanded, hasQuoted) {
  const allValues = [];
  for (const value of braceExpanded) {
    if (!hasQuoted && value === "") {
      continue;
    }
    if (!hasQuoted && !ctx.state.options.noglob && hasGlobPattern(value, ctx.state.shoptOptions.extglob)) {
      const matches = await expandGlobPattern(ctx, value);
      allValues.push(...matches);
    } else {
      allValues.push(value);
    }
  }
  return { values: allValues, quoted: false };
}
__name(handleBraceExpansionResults, "handleBraceExpansionResults");
async function handleArrayExpansionCases(ctx, wordParts, hasArrayAtExpansion, hasVarNamePrefixExpansion, hasIndirection, deps) {
  if (hasArrayAtExpansion) {
    const simpleArrayResult = handleSimpleArrayExpansion(ctx, wordParts);
    if (simpleArrayResult !== null) {
      return simpleArrayResult;
    }
  }
  {
    const namerefArrayResult = handleNamerefArrayExpansion(ctx, wordParts);
    if (namerefArrayResult !== null) {
      return namerefArrayResult;
    }
  }
  {
    const arrayDefaultResult = await handleArrayDefaultValue(ctx, wordParts);
    if (arrayDefaultResult !== null) {
      return arrayDefaultResult;
    }
  }
  {
    const arrayPatternPrefixSuffixResult = await handleArrayPatternWithPrefixSuffix(ctx, wordParts, hasArrayAtExpansion, deps.expandPart, deps.expandWordPartsAsync);
    if (arrayPatternPrefixSuffixResult !== null) {
      return arrayPatternPrefixSuffixResult;
    }
  }
  {
    const arrayPrefixSuffixResult = await handleArrayWithPrefixSuffix(ctx, wordParts, hasArrayAtExpansion, deps.expandPart);
    if (arrayPrefixSuffixResult !== null) {
      return arrayPrefixSuffixResult;
    }
  }
  {
    const arraySlicingResult = await handleArraySlicing(ctx, wordParts, deps.evaluateArithmetic);
    if (arraySlicingResult !== null) {
      return arraySlicingResult;
    }
  }
  {
    const arrayTransformResult = handleArrayTransform(ctx, wordParts);
    if (arrayTransformResult !== null) {
      return arrayTransformResult;
    }
  }
  {
    const arrayPatReplResult = await handleArrayPatternReplacement(ctx, wordParts, deps.expandWordPartsAsync, deps.expandPart);
    if (arrayPatReplResult !== null) {
      return arrayPatReplResult;
    }
  }
  {
    const arrayPatRemResult = await handleArrayPatternRemoval(ctx, wordParts, deps.expandWordPartsAsync, deps.expandPart);
    if (arrayPatRemResult !== null) {
      return arrayPatRemResult;
    }
  }
  if (hasVarNamePrefixExpansion && wordParts.length === 1 && wordParts[0].type === "DoubleQuoted") {
    const result = handleVarNamePrefixExpansion(ctx, wordParts);
    if (result !== null) {
      return result;
    }
  }
  {
    const indirectArrayResult = await handleIndirectArrayExpansion(ctx, wordParts, hasIndirection, deps.expandParameterAsync, deps.expandWordPartsAsync);
    if (indirectArrayResult !== null) {
      return indirectArrayResult;
    }
  }
  {
    const indirectInAltResult = await handleIndirectInAlternative(ctx, wordParts);
    if (indirectInAltResult !== null) {
      return indirectInAltResult;
    }
  }
  {
    const indirectionWithInnerResult = await handleIndirectionWithInnerAlternative(ctx, wordParts);
    if (indirectionWithInnerResult !== null) {
      return indirectionWithInnerResult;
    }
  }
  return null;
}
__name(handleArrayExpansionCases, "handleArrayExpansionCases");
function handleVarNamePrefixExpansion(ctx, wordParts) {
  const dqPart = wordParts[0];
  if (dqPart.type !== "DoubleQuoted")
    return null;
  if (dqPart.parts.length === 1 && dqPart.parts[0].type === "ParameterExpansion" && dqPart.parts[0].operation?.type === "VarNamePrefix") {
    const op = dqPart.parts[0].operation;
    const matchingVars = getVarNamesWithPrefix(ctx, op.prefix);
    if (op.star) {
      return {
        values: [matchingVars.join(getIfsSeparator(ctx.state.env))],
        quoted: true
      };
    }
    return { values: matchingVars, quoted: true };
  }
  if (dqPart.parts.length === 1 && dqPart.parts[0].type === "ParameterExpansion" && dqPart.parts[0].operation?.type === "ArrayKeys") {
    const op = dqPart.parts[0].operation;
    const elements = getArrayElements(ctx, op.array);
    const keys = elements.map(([k]) => String(k));
    if (op.star) {
      return {
        values: [keys.join(getIfsSeparator(ctx.state.env))],
        quoted: true
      };
    }
    return { values: keys, quoted: true };
  }
  return null;
}
__name(handleVarNamePrefixExpansion, "handleVarNamePrefixExpansion");
async function handlePositionalExpansionCases(ctx, wordParts, deps) {
  {
    const positionalSlicingResult = await handlePositionalSlicing(ctx, wordParts, deps.evaluateArithmetic, deps.expandPart);
    if (positionalSlicingResult !== null) {
      return positionalSlicingResult;
    }
  }
  {
    const positionalPatReplResult = await handlePositionalPatternReplacement(ctx, wordParts, deps.expandPart, deps.expandWordPartsAsync);
    if (positionalPatReplResult !== null) {
      return positionalPatReplResult;
    }
  }
  {
    const positionalPatRemResult = await handlePositionalPatternRemoval(ctx, wordParts, deps.expandPart, deps.expandWordPartsAsync);
    if (positionalPatRemResult !== null) {
      return positionalPatRemResult;
    }
  }
  {
    const simplePositionalResult = await handleSimplePositionalExpansion(ctx, wordParts, deps.expandPart);
    if (simplePositionalResult !== null) {
      return simplePositionalResult;
    }
  }
  return null;
}
__name(handlePositionalExpansionCases, "handlePositionalExpansionCases");
async function handleUnquotedExpansionCases(ctx, wordParts, deps) {
  {
    const unquotedArrayPatReplResult = await handleUnquotedArrayPatternReplacement(ctx, wordParts, deps.expandWordPartsAsync, deps.expandPart);
    if (unquotedArrayPatReplResult !== null) {
      return unquotedArrayPatReplResult;
    }
  }
  {
    const unquotedArrayPatRemResult = await handleUnquotedArrayPatternRemoval(ctx, wordParts, deps.expandWordPartsAsync, deps.expandPart);
    if (unquotedArrayPatRemResult !== null) {
      return unquotedArrayPatRemResult;
    }
  }
  {
    const unquotedPosPatRemResult = await handleUnquotedPositionalPatternRemoval(ctx, wordParts, deps.expandWordPartsAsync, deps.expandPart);
    if (unquotedPosPatRemResult !== null) {
      return unquotedPosPatRemResult;
    }
  }
  {
    const unquotedSliceResult = await handleUnquotedPositionalSlicing(ctx, wordParts, deps.evaluateArithmetic, deps.expandPart);
    if (unquotedSliceResult !== null) {
      return unquotedSliceResult;
    }
  }
  {
    const unquotedSimplePositionalResult = await handleUnquotedSimplePositional(ctx, wordParts);
    if (unquotedSimplePositionalResult !== null) {
      return unquotedSimplePositionalResult;
    }
  }
  {
    const unquotedSimpleArrayResult = await handleUnquotedSimpleArray(ctx, wordParts);
    if (unquotedSimpleArrayResult !== null) {
      return unquotedSimpleArrayResult;
    }
  }
  {
    const unquotedVarNamePrefixResult = handleUnquotedVarNamePrefix(ctx, wordParts);
    if (unquotedVarNamePrefixResult !== null) {
      return unquotedVarNamePrefixResult;
    }
  }
  {
    const unquotedArrayKeysResult = handleUnquotedArrayKeys(ctx, wordParts);
    if (unquotedArrayKeysResult !== null) {
      return unquotedArrayKeysResult;
    }
  }
  {
    const unquotedPrefixSuffixResult = await handleUnquotedPositionalWithPrefixSuffix(ctx, wordParts, deps.expandPart);
    if (unquotedPrefixSuffixResult !== null) {
      return unquotedPrefixSuffixResult;
    }
  }
  return null;
}
__name(handleUnquotedExpansionCases, "handleUnquotedExpansionCases");
function findWordProducingExpansion(part) {
  if (part.type !== "DoubleQuoted")
    return null;
  for (let i = 0; i < part.parts.length; i++) {
    const inner = part.parts[i];
    if (inner.type !== "ParameterExpansion")
      continue;
    if (inner.operation)
      continue;
    const arrayMatch = inner.parameter.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[([@*])\]$/);
    if (arrayMatch) {
      return {
        type: "array",
        name: arrayMatch[1],
        atIndex: i,
        isStar: arrayMatch[2] === "*"
      };
    }
    if (inner.parameter === "@" || inner.parameter === "*") {
      return {
        type: "positional",
        atIndex: i,
        isStar: inner.parameter === "*"
      };
    }
  }
  return null;
}
__name(findWordProducingExpansion, "findWordProducingExpansion");
async function expandDoubleQuotedWithWordProducing(ctx, part, info, expandPart2) {
  let prefix = "";
  for (let i = 0; i < info.atIndex; i++) {
    prefix += await expandPart2(ctx, part.parts[i]);
  }
  let suffix = "";
  for (let i = info.atIndex + 1; i < part.parts.length; i++) {
    suffix += await expandPart2(ctx, part.parts[i]);
  }
  let values;
  if (info.type === "array") {
    const elements = getArrayElements(ctx, info.name);
    values = elements.map(([, v]) => v);
    if (values.length === 0) {
      const scalarValue = ctx.state.env[info.name];
      if (scalarValue !== void 0) {
        values = [scalarValue];
      }
    }
  } else {
    const numParams = Number.parseInt(ctx.state.env["#"] || "0", 10);
    values = [];
    for (let i = 1; i <= numParams; i++) {
      values.push(ctx.state.env[String(i)] || "");
    }
  }
  if (info.isStar) {
    const ifsSep = getIfsSeparator(ctx.state.env);
    const joined = values.join(ifsSep);
    return [prefix + joined + suffix];
  }
  if (values.length === 0) {
    const combined = prefix + suffix;
    return combined ? [combined] : [];
  }
  if (values.length === 1) {
    return [prefix + values[0] + suffix];
  }
  return [
    prefix + values[0],
    ...values.slice(1, -1),
    values[values.length - 1] + suffix
  ];
}
__name(expandDoubleQuotedWithWordProducing, "expandDoubleQuotedWithWordProducing");
async function expandMixedWordParts(ctx, wordParts, expandPart2) {
  if (wordParts.length < 2)
    return null;
  let hasWordProducing = false;
  for (const part of wordParts) {
    if (findWordProducingExpansion(part)) {
      hasWordProducing = true;
      break;
    }
  }
  if (!hasWordProducing)
    return null;
  const ifsChars = getIfs(ctx.state.env);
  const ifsEmpty = isIfsEmpty(ctx.state.env);
  const partWords = [];
  for (const part of wordParts) {
    const wpInfo = findWordProducingExpansion(part);
    if (wpInfo && part.type === "DoubleQuoted") {
      const words = await expandDoubleQuotedWithWordProducing(ctx, part, wpInfo, expandPart2);
      partWords.push(words);
    } else if (part.type === "DoubleQuoted" || part.type === "SingleQuoted") {
      const value = await expandPart2(ctx, part);
      partWords.push([value]);
    } else if (part.type === "Literal") {
      partWords.push([part.value]);
    } else if (part.type === "ParameterExpansion") {
      const value = await expandPart2(ctx, part);
      if (ifsEmpty) {
        partWords.push(value ? [value] : []);
      } else {
        const split = splitByIfsForExpansion(value, ifsChars);
        partWords.push(split);
      }
    } else {
      const value = await expandPart2(ctx, part);
      if (ifsEmpty) {
        partWords.push(value ? [value] : []);
      } else {
        const split = splitByIfsForExpansion(value, ifsChars);
        partWords.push(split);
      }
    }
  }
  const result = [];
  for (const words of partWords) {
    if (words.length === 0) {
      continue;
    }
    if (result.length === 0) {
      result.push(...words);
    } else {
      const lastIdx = result.length - 1;
      result[lastIdx] = result[lastIdx] + words[0];
      for (let j = 1; j < words.length; j++) {
        result.push(words[j]);
      }
    }
  }
  return result;
}
__name(expandMixedWordParts, "expandMixedWordParts");
async function applyGlobToValues(ctx, values) {
  if (ctx.state.options.noglob) {
    return { values, quoted: false };
  }
  const expandedValues = [];
  for (const v of values) {
    if (hasGlobPattern(v, ctx.state.shoptOptions.extglob)) {
      const matches = await expandGlobPattern(ctx, v);
      expandedValues.push(...matches);
    } else {
      expandedValues.push(v);
    }
  }
  return { values: expandedValues, quoted: false };
}
__name(applyGlobToValues, "applyGlobToValues");
async function expandGlobPattern(ctx, pattern) {
  const globExpander = new GlobExpander(ctx.fs, ctx.state.cwd, ctx.state.env, {
    globstar: ctx.state.shoptOptions.globstar,
    nullglob: ctx.state.shoptOptions.nullglob,
    failglob: ctx.state.shoptOptions.failglob,
    dotglob: ctx.state.shoptOptions.dotglob,
    extglob: ctx.state.shoptOptions.extglob,
    globskipdots: ctx.state.shoptOptions.globskipdots
  });
  const matches = await globExpander.expand(pattern);
  if (matches.length > 0) {
    return matches;
  }
  if (globExpander.hasFailglob()) {
    throw new GlobError(pattern);
  }
  if (globExpander.hasNullglob()) {
    return [];
  }
  return [pattern];
}
__name(expandGlobPattern, "expandGlobPattern");
async function handleFinalGlobExpansion(ctx, word, wordParts, value, hasQuoted, expandWordForGlobbing2) {
  const hasGlobParts = wordParts.some((p) => p.type === "Glob");
  if (!ctx.state.options.noglob && hasGlobParts) {
    const globPattern = await expandWordForGlobbing2(ctx, word);
    if (hasGlobPattern(globPattern, ctx.state.shoptOptions.extglob)) {
      const matches = await expandGlobPattern(ctx, globPattern);
      if (matches.length > 0 && matches[0] !== globPattern) {
        return { values: matches, quoted: false };
      }
      if (matches.length === 0) {
        return { values: [], quoted: false };
      }
    }
    const unescapedValue = unescapeGlobPattern(value);
    if (!isIfsEmpty(ctx.state.env)) {
      const ifsChars = getIfs(ctx.state.env);
      const splitValues = splitByIfsForExpansion(unescapedValue, ifsChars);
      return { values: splitValues, quoted: false };
    }
    return { values: [unescapedValue], quoted: false };
  }
  if (!hasQuoted && !ctx.state.options.noglob && hasGlobPattern(value, ctx.state.shoptOptions.extglob)) {
    const globPattern = await expandWordForGlobbing2(ctx, word);
    if (hasGlobPattern(globPattern, ctx.state.shoptOptions.extglob)) {
      const matches = await expandGlobPattern(ctx, globPattern);
      if (matches.length > 0 && matches[0] !== globPattern) {
        return { values: matches, quoted: false };
      }
    }
  }
  if (value === "" && !hasQuoted) {
    return { values: [], quoted: false };
  }
  if (hasGlobParts && !hasQuoted) {
    const unescapedValue = unescapeGlobPattern(value);
    if (!isIfsEmpty(ctx.state.env)) {
      const ifsChars = getIfs(ctx.state.env);
      const splitValues = splitByIfsForExpansion(unescapedValue, ifsChars);
      return { values: splitValues, quoted: false };
    }
    return { values: [unescapedValue], quoted: false };
  }
  return { values: [value], quoted: hasQuoted };
}
__name(handleFinalGlobExpansion, "handleFinalGlobExpansion");

// dist/interpreter/expansion/word-split.js
async function shouldUseOperationWord(ctx, part) {
  const op = part.operation;
  if (!op)
    return null;
  if (op.type !== "DefaultValue" && op.type !== "AssignDefault" && op.type !== "UseAlternative") {
    return null;
  }
  const word = op.word;
  if (!word || word.parts.length === 0)
    return null;
  const isSet = await isVariableSet(ctx, part.parameter);
  const value = await getVariable(ctx, part.parameter, false);
  const isEmpty = value === "";
  const checkEmpty = op.checkEmpty ?? false;
  let shouldUse;
  if (op.type === "UseAlternative") {
    shouldUse = isSet && !(checkEmpty && isEmpty);
  } else {
    shouldUse = !isSet || checkEmpty && isEmpty;
  }
  if (!shouldUse)
    return null;
  return word.parts;
}
__name(shouldUseOperationWord, "shouldUseOperationWord");
function isSimpleQuotedLiteral(part) {
  if (part.type === "SingleQuoted") {
    return true;
  }
  if (part.type === "DoubleQuoted") {
    const dqPart = part;
    return dqPart.parts.every((p) => p.type === "Literal");
  }
  return false;
}
__name(isSimpleQuotedLiteral, "isSimpleQuotedLiteral");
async function hasMixedQuotedDefaultValue(ctx, part) {
  if (part.type !== "ParameterExpansion")
    return null;
  const opWordParts = await shouldUseOperationWord(ctx, part);
  if (!opWordParts || opWordParts.length <= 1)
    return null;
  const hasSimpleQuotedParts = opWordParts.some((p) => isSimpleQuotedLiteral(p));
  const hasUnquotedParts = opWordParts.some((p) => p.type === "Literal" || p.type === "ParameterExpansion" || p.type === "CommandSubstitution" || p.type === "ArithmeticExpansion");
  if (hasSimpleQuotedParts && hasUnquotedParts) {
    return opWordParts;
  }
  return null;
}
__name(hasMixedQuotedDefaultValue, "hasMixedQuotedDefaultValue");
function isPartSplittable(part) {
  if (part.type === "DoubleQuoted" || part.type === "SingleQuoted") {
    return false;
  }
  if (part.type === "Literal") {
    return false;
  }
  if (part.type === "Glob") {
    return globPatternHasVarRef(part.pattern);
  }
  const isSplittable = part.type === "ParameterExpansion" || part.type === "CommandSubstitution" || part.type === "ArithmeticExpansion";
  if (!isSplittable) {
    return false;
  }
  if (part.type === "ParameterExpansion" && isOperationWordEntirelyQuoted(part)) {
    return false;
  }
  return true;
}
__name(isPartSplittable, "isPartSplittable");
async function smartWordSplit(ctx, wordParts, ifsChars, _ifsPattern, expandPartFn) {
  if (wordParts.length === 1 && wordParts[0].type === "ParameterExpansion") {
    const paramPart = wordParts[0];
    const opWordParts = await shouldUseOperationWord(ctx, paramPart);
    if (opWordParts && opWordParts.length > 0) {
      const hasMixedParts = opWordParts.length > 1 && opWordParts.some((p) => p.type === "DoubleQuoted" || p.type === "SingleQuoted") && opWordParts.some((p) => p.type === "Literal" || p.type === "ParameterExpansion" || p.type === "CommandSubstitution" || p.type === "ArithmeticExpansion");
      if (hasMixedParts) {
        return smartWordSplitWithUnquotedLiterals(ctx, opWordParts, ifsChars, _ifsPattern, expandPartFn);
      }
    }
  }
  const segments = [];
  let hasAnySplittable = false;
  for (const part of wordParts) {
    const splittable = isPartSplittable(part);
    const isQuoted = part.type === "DoubleQuoted" || part.type === "SingleQuoted";
    const mixedDefaultParts = splittable ? await hasMixedQuotedDefaultValue(ctx, part) : null;
    const expanded = await expandPartFn(ctx, part);
    segments.push({
      value: expanded,
      isSplittable: splittable,
      isQuoted,
      mixedDefaultParts: mixedDefaultParts ?? void 0
    });
    if (splittable) {
      hasAnySplittable = true;
    }
  }
  if (!hasAnySplittable) {
    const joined = segments.map((s) => s.value).join("");
    return joined ? [joined] : [];
  }
  const words = [];
  let currentWord = "";
  let hasProducedWord = false;
  let pendingWordBreak = false;
  let prevWasQuotedEmpty = false;
  for (const segment of segments) {
    if (!segment.isSplittable) {
      if (pendingWordBreak) {
        if (segment.isQuoted && segment.value === "") {
          if (currentWord !== "") {
            words.push(currentWord);
          }
          words.push("");
          hasProducedWord = true;
          currentWord = "";
          pendingWordBreak = false;
          prevWasQuotedEmpty = true;
        } else if (segment.value !== "") {
          if (currentWord !== "") {
            words.push(currentWord);
          }
          currentWord = segment.value;
          pendingWordBreak = false;
          prevWasQuotedEmpty = false;
        } else {
          currentWord += segment.value;
          prevWasQuotedEmpty = false;
        }
      } else {
        currentWord += segment.value;
        prevWasQuotedEmpty = segment.isQuoted && segment.value === "";
      }
    } else if (segment.mixedDefaultParts) {
      const splitParts = await smartWordSplitWithUnquotedLiterals(ctx, segment.mixedDefaultParts, ifsChars, _ifsPattern, expandPartFn);
      if (splitParts.length === 0) {
      } else if (splitParts.length === 1) {
        currentWord += splitParts[0];
        hasProducedWord = true;
      } else {
        currentWord += splitParts[0];
        words.push(currentWord);
        hasProducedWord = true;
        for (let i = 1; i < splitParts.length - 1; i++) {
          words.push(splitParts[i]);
        }
        currentWord = splitParts[splitParts.length - 1];
      }
      pendingWordBreak = false;
      prevWasQuotedEmpty = false;
    } else {
      const { words: parts, hadLeadingDelimiter, hadTrailingDelimiter } = splitByIfsForExpansionEx(segment.value, ifsChars);
      if (prevWasQuotedEmpty && hadLeadingDelimiter && currentWord === "") {
        words.push("");
        hasProducedWord = true;
      }
      if (parts.length === 0) {
        if (hadTrailingDelimiter) {
          pendingWordBreak = true;
        }
      } else if (parts.length === 1) {
        currentWord += parts[0];
        hasProducedWord = true;
        pendingWordBreak = hadTrailingDelimiter;
      } else {
        currentWord += parts[0];
        words.push(currentWord);
        hasProducedWord = true;
        for (let i = 1; i < parts.length - 1; i++) {
          words.push(parts[i]);
        }
        currentWord = parts[parts.length - 1];
        pendingWordBreak = hadTrailingDelimiter;
      }
      prevWasQuotedEmpty = false;
    }
  }
  if (currentWord !== "") {
    words.push(currentWord);
  } else if (words.length === 0 && hasProducedWord) {
    words.push("");
  }
  return words;
}
__name(smartWordSplit, "smartWordSplit");
function startsWithIfs(value, ifsChars) {
  return value.length > 0 && ifsChars.includes(value[0]);
}
__name(startsWithIfs, "startsWithIfs");
async function smartWordSplitWithUnquotedLiterals(ctx, wordParts, ifsChars, _ifsPattern, expandPartFn) {
  const segments = [];
  for (const part of wordParts) {
    const isQuoted = part.type === "DoubleQuoted" || part.type === "SingleQuoted";
    const splittable = !isQuoted;
    const expanded = await expandPartFn(ctx, part);
    segments.push({ value: expanded, isSplittable: splittable });
  }
  const words = [];
  let currentWord = "";
  let hasProducedWord = false;
  let pendingWordBreak = false;
  for (const segment of segments) {
    if (!segment.isSplittable) {
      if (pendingWordBreak && segment.value !== "") {
        if (currentWord !== "") {
          words.push(currentWord);
        }
        currentWord = segment.value;
        pendingWordBreak = false;
      } else {
        currentWord += segment.value;
      }
    } else {
      const startsWithIfsChar = startsWithIfs(segment.value, ifsChars);
      if (startsWithIfsChar && currentWord !== "") {
        words.push(currentWord);
        currentWord = "";
        hasProducedWord = true;
      }
      const { words: parts, hadTrailingDelimiter } = splitByIfsForExpansionEx(segment.value, ifsChars);
      if (parts.length === 0) {
        if (hadTrailingDelimiter) {
          pendingWordBreak = true;
        }
      } else if (parts.length === 1) {
        currentWord += parts[0];
        hasProducedWord = true;
        pendingWordBreak = hadTrailingDelimiter;
      } else {
        currentWord += parts[0];
        words.push(currentWord);
        hasProducedWord = true;
        for (let i = 1; i < parts.length - 1; i++) {
          words.push(parts[i]);
        }
        currentWord = parts[parts.length - 1];
        pendingWordBreak = hadTrailingDelimiter;
      }
    }
  }
  if (currentWord !== "") {
    words.push(currentWord);
  } else if (words.length === 0 && hasProducedWord) {
    words.push("");
  }
  return words;
}
__name(smartWordSplitWithUnquotedLiterals, "smartWordSplitWithUnquotedLiterals");

// dist/interpreter/helpers/word-parts.js
function getLiteralValue(part) {
  switch (part.type) {
    case "Literal":
      return part.value;
    case "SingleQuoted":
      return part.value;
    case "Escaped":
      return part.value;
    default:
      return null;
  }
}
__name(getLiteralValue, "getLiteralValue");
function isQuotedPart(part) {
  switch (part.type) {
    case "SingleQuoted":
    case "Escaped":
    case "DoubleQuoted":
      return true;
    case "Literal":
      return part.value === "";
    default:
      return false;
  }
}
__name(isQuotedPart, "isQuotedPart");

// dist/interpreter/expansion.js
async function expandWordPartsAsync(ctx, parts, inDoubleQuotes = false) {
  const results = [];
  for (const part of parts) {
    results.push(await expandPart(ctx, part, inDoubleQuotes));
  }
  return results.join("");
}
__name(expandWordPartsAsync, "expandWordPartsAsync");
function isPartFullyQuoted(part) {
  return isQuotedPart(part);
}
__name(isPartFullyQuoted, "isPartFullyQuoted");
function isWordFullyQuoted(word) {
  if (word.parts.length === 0)
    return true;
  for (const part of word.parts) {
    if (!isPartFullyQuoted(part)) {
      return false;
    }
  }
  return true;
}
__name(isWordFullyQuoted, "isWordFullyQuoted");
function expandSimplePart(ctx, part, inDoubleQuotes = false) {
  const literal = getLiteralValue(part);
  if (literal !== null)
    return literal;
  switch (part.type) {
    case "TildeExpansion":
      if (inDoubleQuotes) {
        return part.user === null ? "~" : `~${part.user}`;
      }
      if (part.user === null) {
        return ctx.state.env.HOME !== void 0 ? ctx.state.env.HOME : "/home/user";
      }
      if (part.user === "root") {
        return "/root";
      }
      return `~${part.user}`;
    case "Glob":
      return expandVariablesInPattern(ctx, part.pattern);
    default:
      return null;
  }
}
__name(expandSimplePart, "expandSimplePart");
async function expandWord(ctx, word) {
  return expandWordAsync(ctx, word);
}
__name(expandWord, "expandWord");
async function expandWordForRegex(ctx, word) {
  const parts = [];
  for (const part of word.parts) {
    if (part.type === "Escaped") {
      parts.push(`\\${part.value}`);
    } else if (part.type === "SingleQuoted") {
      parts.push(part.value);
    } else if (part.type === "DoubleQuoted") {
      const expanded = await expandWordPartsAsync(ctx, part.parts);
      parts.push(expanded);
    } else if (part.type === "TildeExpansion") {
      const expanded = await expandPart(ctx, part);
      parts.push(escapeRegexChars(expanded));
    } else {
      parts.push(await expandPart(ctx, part));
    }
  }
  return parts.join("");
}
__name(expandWordForRegex, "expandWordForRegex");
async function expandWordForPattern(ctx, word) {
  const parts = [];
  for (const part of word.parts) {
    if (part.type === "Escaped") {
      const ch = part.value;
      if ("()|*?[]".includes(ch)) {
        parts.push(`\\${ch}`);
      } else {
        parts.push(ch);
      }
    } else if (part.type === "SingleQuoted") {
      parts.push(escapeGlobChars(part.value));
    } else if (part.type === "DoubleQuoted") {
      const expanded = await expandWordPartsAsync(ctx, part.parts);
      parts.push(escapeGlobChars(expanded));
    } else {
      parts.push(await expandPart(ctx, part));
    }
  }
  return parts.join("");
}
__name(expandWordForPattern, "expandWordForPattern");
async function expandWordForGlobbing(ctx, word) {
  const parts = [];
  for (const part of word.parts) {
    if (part.type === "SingleQuoted") {
      parts.push(escapeGlobChars(part.value));
    } else if (part.type === "Escaped") {
      const ch = part.value;
      if ("*?[]\\()|".includes(ch)) {
        parts.push(`\\${ch}`);
      } else {
        parts.push(ch);
      }
    } else if (part.type === "DoubleQuoted") {
      const expanded = await expandWordPartsAsync(ctx, part.parts);
      parts.push(escapeGlobChars(expanded));
    } else if (part.type === "Glob") {
      if (patternHasCommandSubstitution(part.pattern)) {
        parts.push(await expandVariablesInPatternAsync(ctx, part.pattern));
      } else {
        parts.push(expandVariablesInPattern(ctx, part.pattern));
      }
    } else if (part.type === "Literal") {
      parts.push(part.value);
    } else {
      parts.push(await expandPart(ctx, part));
    }
  }
  return parts.join("");
}
__name(expandWordForGlobbing, "expandWordForGlobbing");
function hasBraceExpansion(parts) {
  for (const part of parts) {
    if (part.type === "BraceExpansion")
      return true;
    if (part.type === "DoubleQuoted" && hasBraceExpansion(part.parts))
      return true;
  }
  return false;
}
__name(hasBraceExpansion, "hasBraceExpansion");
var MAX_BRACE_EXPANSION_RESULTS = 1e4;
var MAX_BRACE_OPERATIONS = 1e5;
async function expandBracesInPartsAsync(ctx, parts, operationCounter = { count: 0 }) {
  if (operationCounter.count > MAX_BRACE_OPERATIONS) {
    return [[]];
  }
  let results = [[]];
  for (const part of parts) {
    if (part.type === "BraceExpansion") {
      const braceValues = [];
      let hasInvalidRange = false;
      let invalidRangeLiteral = "";
      for (const item of part.items) {
        if (item.type === "Range") {
          const range = expandBraceRange(item.start, item.end, item.step, item.startStr, item.endStr);
          if (range.expanded) {
            for (const val of range.expanded) {
              operationCounter.count++;
              braceValues.push(val);
            }
          } else {
            hasInvalidRange = true;
            invalidRangeLiteral = range.literal;
            break;
          }
        } else {
          const expanded = await expandBracesInPartsAsync(ctx, item.word.parts, operationCounter);
          for (const exp of expanded) {
            operationCounter.count++;
            const joinedParts = [];
            for (const p of exp) {
              if (typeof p === "string") {
                joinedParts.push(p);
              } else {
                joinedParts.push(await expandPart(ctx, p));
              }
            }
            braceValues.push(joinedParts.join(""));
          }
        }
      }
      if (hasInvalidRange) {
        for (const result of results) {
          operationCounter.count++;
          result.push(invalidRangeLiteral);
        }
        continue;
      }
      const newSize = results.length * braceValues.length;
      if (newSize > MAX_BRACE_EXPANSION_RESULTS || operationCounter.count > MAX_BRACE_OPERATIONS) {
        return results;
      }
      const newResults = [];
      for (const result of results) {
        for (const val of braceValues) {
          operationCounter.count++;
          if (operationCounter.count > MAX_BRACE_OPERATIONS) {
            return newResults.length > 0 ? newResults : results;
          }
          newResults.push([...result, val]);
        }
      }
      results = newResults;
    } else {
      for (const result of results) {
        operationCounter.count++;
        result.push(part);
      }
    }
  }
  return results;
}
__name(expandBracesInPartsAsync, "expandBracesInPartsAsync");
async function expandWordWithBracesAsync(ctx, word) {
  const parts = word.parts;
  if (!hasBraceExpansion(parts)) {
    return [await expandWord(ctx, word)];
  }
  const expanded = await expandBracesInPartsAsync(ctx, parts);
  const results = [];
  for (const resultParts of expanded) {
    const joinedParts = [];
    for (const p of resultParts) {
      if (typeof p === "string") {
        joinedParts.push(p);
      } else {
        joinedParts.push(await expandPart(ctx, p));
      }
    }
    results.push(applyTildeExpansion(ctx, joinedParts.join("")));
  }
  return results;
}
__name(expandWordWithBracesAsync, "expandWordWithBracesAsync");
function createWordGlobDeps() {
  return {
    expandWordAsync,
    expandWordForGlobbing,
    expandWordWithBracesAsync,
    expandWordPartsAsync,
    expandPart,
    expandParameterAsync,
    hasBraceExpansion,
    evaluateArithmetic,
    buildIfsCharClassPattern,
    smartWordSplit
  };
}
__name(createWordGlobDeps, "createWordGlobDeps");
async function expandWordWithGlob(ctx, word) {
  return expandWordWithGlobImpl(ctx, word, createWordGlobDeps());
}
__name(expandWordWithGlob, "expandWordWithGlob");
function getWordText(parts) {
  for (const p of parts) {
    if (p.type === "ParameterExpansion") {
      return p.parameter;
    }
    if (p.type === "Literal") {
      return p.value;
    }
  }
  return "";
}
__name(getWordText, "getWordText");
function hasQuotedMultiValueAt(ctx, word) {
  const numParams = Number.parseInt(ctx.state.env["#"] || "0", 10);
  if (numParams < 2)
    return false;
  function checkParts(parts) {
    for (const part of parts) {
      if (part.type === "DoubleQuoted") {
        for (const innerPart of part.parts) {
          if (innerPart.type === "ParameterExpansion" && innerPart.parameter === "@" && !innerPart.operation) {
            return true;
          }
        }
      }
    }
    return false;
  }
  __name(checkParts, "checkParts");
  return checkParts(word.parts);
}
__name(hasQuotedMultiValueAt, "hasQuotedMultiValueAt");
async function expandRedirectTarget(ctx, word) {
  if (hasQuotedMultiValueAt(ctx, word)) {
    return { error: "bash: $@: ambiguous redirect\n" };
  }
  const wordParts = word.parts;
  const { hasQuoted } = analyzeWordParts(wordParts);
  if (hasBraceExpansion(wordParts)) {
    const braceExpanded = await expandWordWithBracesAsync(ctx, word);
    if (braceExpanded.length > 1) {
      const originalText = wordParts.map((p) => {
        if (p.type === "Literal")
          return p.value;
        if (p.type === "BraceExpansion") {
          const items = p.items.map((item) => {
            if (item.type === "Range") {
              const step = item.step ? `..${item.step}` : "";
              return `${item.startStr ?? item.start}..${item.endStr ?? item.end}${step}`;
            }
            return item.word.parts.map((wp) => wp.type === "Literal" ? wp.value : "").join("");
          }).join(",");
          return `{${items}}`;
        }
        return "";
      }).join("");
      return { error: `bash: ${originalText}: ambiguous redirect
` };
    }
  }
  const value = await expandWordAsync(ctx, word);
  const { hasParamExpansion, hasCommandSub } = analyzeWordParts(wordParts);
  const hasUnquotedExpansion = (hasParamExpansion || hasCommandSub) && !hasQuoted;
  if (hasUnquotedExpansion && !isIfsEmpty(ctx.state.env)) {
    const ifsChars = getIfs(ctx.state.env);
    const splitWords = splitByIfsForExpansion(value, ifsChars);
    if (splitWords.length > 1) {
      return {
        error: `bash: $${getWordText(wordParts)}: ambiguous redirect
`
      };
    }
  }
  if (hasQuoted || ctx.state.options.noglob) {
    return { target: value };
  }
  const globPattern = await expandWordForGlobbing(ctx, word);
  if (!hasGlobPattern(globPattern, ctx.state.shoptOptions.extglob)) {
    return { target: value };
  }
  const globExpander = new GlobExpander(ctx.fs, ctx.state.cwd, ctx.state.env, {
    globstar: ctx.state.shoptOptions.globstar,
    nullglob: ctx.state.shoptOptions.nullglob,
    failglob: ctx.state.shoptOptions.failglob,
    dotglob: ctx.state.shoptOptions.dotglob,
    extglob: ctx.state.shoptOptions.extglob,
    globskipdots: ctx.state.shoptOptions.globskipdots
  });
  const matches = await globExpander.expand(globPattern);
  if (matches.length === 0) {
    if (globExpander.hasFailglob()) {
      return { error: `bash: no match: ${value}
` };
    }
    return { target: value };
  }
  if (matches.length === 1) {
    return { target: matches[0] };
  }
  return { error: `bash: ${value}: ambiguous redirect
` };
}
__name(expandRedirectTarget, "expandRedirectTarget");
async function expandWordAsync(ctx, word) {
  const wordParts = word.parts;
  const len = wordParts.length;
  if (len === 1) {
    return expandPart(ctx, wordParts[0]);
  }
  const parts = [];
  for (let i = 0; i < len; i++) {
    parts.push(await expandPart(ctx, wordParts[i]));
  }
  return parts.join("");
}
__name(expandWordAsync, "expandWordAsync");
async function expandPart(ctx, part, inDoubleQuotes = false) {
  if (part.type === "ParameterExpansion") {
    return expandParameterAsync(ctx, part, inDoubleQuotes);
  }
  const simple = expandSimplePart(ctx, part, inDoubleQuotes);
  if (simple !== null)
    return simple;
  switch (part.type) {
    case "DoubleQuoted": {
      const parts = [];
      for (const p of part.parts) {
        parts.push(await expandPart(ctx, p, true));
      }
      return parts.join("");
    }
    case "CommandSubstitution": {
      const fileReadShorthand = getFileReadShorthand(part.body);
      if (fileReadShorthand) {
        try {
          const filePath = await expandWord(ctx, fileReadShorthand.target);
          const resolvedPath = filePath.startsWith("/") ? filePath : `${ctx.state.cwd}/${filePath}`;
          const content = await ctx.fs.readFile(resolvedPath);
          ctx.state.lastExitCode = 0;
          ctx.state.env["?"] = "0";
          return content.replace(/\n+$/, "");
        } catch {
          ctx.state.lastExitCode = 1;
          ctx.state.env["?"] = "1";
          return "";
        }
      }
      const savedBashPid = ctx.state.bashPid;
      ctx.state.bashPid = ctx.state.nextVirtualPid++;
      const savedEnv = { ...ctx.state.env };
      const savedCwd = ctx.state.cwd;
      const savedSuppressVerbose = ctx.state.suppressVerbose;
      ctx.state.suppressVerbose = true;
      try {
        const result = await ctx.executeScript(part.body);
        const exitCode = result.exitCode;
        ctx.state.env = savedEnv;
        ctx.state.cwd = savedCwd;
        ctx.state.suppressVerbose = savedSuppressVerbose;
        ctx.state.lastExitCode = exitCode;
        ctx.state.env["?"] = String(exitCode);
        if (result.stderr) {
          ctx.state.expansionStderr = (ctx.state.expansionStderr || "") + result.stderr;
        }
        ctx.state.bashPid = savedBashPid;
        return result.stdout.replace(/\n+$/, "");
      } catch (error) {
        ctx.state.env = savedEnv;
        ctx.state.cwd = savedCwd;
        ctx.state.bashPid = savedBashPid;
        ctx.state.suppressVerbose = savedSuppressVerbose;
        if (error instanceof ExecutionLimitError) {
          throw error;
        }
        if (error instanceof ExitError) {
          ctx.state.lastExitCode = error.exitCode;
          ctx.state.env["?"] = String(error.exitCode);
          if (error.stderr) {
            ctx.state.expansionStderr = (ctx.state.expansionStderr || "") + error.stderr;
          }
          return error.stdout.replace(/\n+$/, "");
        }
        throw error;
      }
    }
    case "ArithmeticExpansion": {
      const originalText = part.expression.originalText;
      const hasDollarVars = originalText && /\$[a-zA-Z_][a-zA-Z0-9_]*(?![{[(])/.test(originalText);
      if (hasDollarVars) {
        const expandedText = await expandDollarVarsInArithText(ctx, originalText);
        const parser = new Parser();
        const newExpr = parseArithmeticExpression(parser, expandedText);
        return String(await evaluateArithmetic(ctx, newExpr.expression, true));
      }
      return String(await evaluateArithmetic(ctx, part.expression.expression, true));
    }
    case "BraceExpansion": {
      const results = [];
      for (const item of part.items) {
        if (item.type === "Range") {
          const range = expandBraceRange(item.start, item.end, item.step, item.startStr, item.endStr);
          if (range.expanded) {
            results.push(...range.expanded);
          } else {
            return range.literal;
          }
        } else {
          results.push(await expandWord(ctx, item.word));
        }
      }
      return results.join(" ");
    }
    default:
      return "";
  }
}
__name(expandPart, "expandPart");
async function expandParameterAsync(ctx, part, inDoubleQuotes = false) {
  let { parameter } = part;
  const { operation } = part;
  const bracketMatch = parameter.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[(.+)\]$/);
  if (bracketMatch) {
    const [, arrayName, subscript] = bracketMatch;
    const isAssoc = ctx.state.associativeArrays?.has(arrayName);
    if (isAssoc || subscript.includes("$(") || subscript.includes("`") || subscript.includes("${")) {
      const expandedSubscript = await expandSubscriptForAssocArray(ctx, subscript);
      parameter = `${arrayName}[${expandedSubscript}]`;
    }
  } else if (
    // Handle nameref pointing to array subscript with command substitution:
    // typeset -n ref='a[$(echo 2) + 1]'; echo $ref
    /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(parameter) && isNameref(ctx, parameter)
  ) {
    const target = resolveNameref(ctx, parameter);
    if (target && target !== parameter) {
      const targetBracketMatch = target.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[(.+)\]$/);
      if (targetBracketMatch) {
        const [, targetArrayName, targetSubscript] = targetBracketMatch;
        const isAssoc = ctx.state.associativeArrays?.has(targetArrayName);
        if (isAssoc || targetSubscript.includes("$(") || targetSubscript.includes("`") || targetSubscript.includes("${")) {
          const expandedSubscript = await expandSubscriptForAssocArray(ctx, targetSubscript);
          parameter = `${targetArrayName}[${expandedSubscript}]`;
        }
      }
    }
  }
  const skipNounset = operation && (operation.type === "DefaultValue" || operation.type === "AssignDefault" || operation.type === "UseAlternative" || operation.type === "ErrorIfUnset");
  const value = await getVariable(ctx, parameter, !skipNounset);
  if (!operation) {
    return value;
  }
  const isUnset = !await isVariableSet(ctx, parameter);
  const { isEmpty, effectiveValue } = computeIsEmpty(ctx, parameter, value, inDoubleQuotes);
  const opCtx = {
    value,
    isUnset,
    isEmpty,
    effectiveValue,
    inDoubleQuotes
  };
  switch (operation.type) {
    case "DefaultValue":
      return handleDefaultValue(ctx, operation, opCtx, expandWordPartsAsync);
    case "AssignDefault":
      return handleAssignDefault(ctx, parameter, operation, opCtx, expandWordPartsAsync);
    case "ErrorIfUnset":
      return handleErrorIfUnset(ctx, parameter, operation, opCtx, expandWordPartsAsync);
    case "UseAlternative":
      return handleUseAlternative(ctx, operation, opCtx, expandWordPartsAsync);
    case "PatternRemoval":
      return handlePatternRemoval(ctx, value, operation, expandWordPartsAsync, expandPart);
    case "PatternReplacement":
      return handlePatternReplacement(ctx, value, operation, expandWordPartsAsync, expandPart);
    case "Length":
      return handleLength(ctx, parameter, value);
    case "LengthSliceError":
      throw new BadSubstitutionError(parameter);
    case "BadSubstitution":
      throw new BadSubstitutionError(operation.text);
    case "Substring":
      return handleSubstring(ctx, parameter, value, operation);
    case "CaseModification":
      return handleCaseModification(ctx, value, operation, expandWordPartsAsync, expandParameterAsync);
    case "Transform":
      return handleTransform(ctx, parameter, value, isUnset, operation);
    case "Indirection":
      return handleIndirection(ctx, parameter, value, isUnset, operation, expandParameterAsync, inDoubleQuotes);
    case "ArrayKeys":
      return handleArrayKeys(ctx, operation);
    case "VarNamePrefix":
      return handleVarNamePrefix(ctx, operation);
    default:
      return value;
  }
}
__name(expandParameterAsync, "expandParameterAsync");

export {
  KERNEL_VERSION,
  formatProcStatus,
  LexerError,
  ParseException,
  parseArithmeticExpression,
  Parser,
  parse,
  getArrayIndices,
  clearArray,
  getAssocArrayKeys,
  parseKeyedElementFromWord,
  wordToLiteralString,
  getIfs,
  splitByIfsForRead,
  stripTrailingIfsWhitespace,
  isNameref,
  markNameref,
  unmarkNameref,
  markNamerefInvalid,
  markNamerefBound,
  targetExists,
  resolveNameref,
  getNamerefTarget,
  resolveNamerefForAssignment,
  getArrayElements,
  isArray,
  getVariable,
  escapeGlobChars,
  escapeRegexChars,
  markReadonly,
  isReadonly,
  checkReadonlyError,
  markExported,
  unmarkExported,
  isWordFullyQuoted,
  expandWord,
  expandWordForRegex,
  expandWordForPattern,
  expandWordWithGlob,
  hasQuotedMultiValueAt,
  expandRedirectTarget,
  evaluateArithmetic
};
