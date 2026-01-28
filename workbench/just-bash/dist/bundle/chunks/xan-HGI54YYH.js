import {
  cmdFlatten,
  cmdView,
  formatCsv,
  parseCsv,
  readCsvInput
} from "./chunk-WFBMJHLD.js";
import {
  require_papaparse
} from "./chunk-2NICSRZI.js";
import {
  evaluate
} from "./chunk-E7HLGBJ6.js";
import "./chunk-KRBYMBZY.js";
import {
  readFiles
} from "./chunk-XTSQ6SVV.js";
import "./chunk-PRIRMCRG.js";
import {
  hasHelpFlag,
  showHelp
} from "./chunk-HAN5425M.js";
import {
  __esm,
  __export,
  __name,
  __toCommonJS,
  __toESM
} from "./chunk-Y7IWVHJ4.js";

// dist/commands/xan/moonblade-tokenizer.js
var Tokenizer;
var init_moonblade_tokenizer = __esm({
  "dist/commands/xan/moonblade-tokenizer.js"() {
    "use strict";
    Tokenizer = class {
      static {
        __name(this, "Tokenizer");
      }
      input;
      pos = 0;
      tokens = [];
      constructor(input) {
        this.input = input;
      }
      tokenize() {
        while (this.pos < this.input.length) {
          this.skipWhitespace();
          if (this.pos >= this.input.length)
            break;
          const token = this.nextToken();
          if (token) {
            this.tokens.push(token);
          }
        }
        this.tokens.push({ type: "eof", value: "", pos: this.pos });
        return this.tokens;
      }
      skipWhitespace() {
        while (this.pos < this.input.length) {
          const ch = this.input[this.pos];
          if (ch === " " || ch === "	" || ch === "\n" || ch === "\r") {
            this.pos++;
          } else if (ch === "#") {
            while (this.pos < this.input.length && this.input[this.pos] !== "\n") {
              this.pos++;
            }
          } else {
            break;
          }
        }
      }
      nextToken() {
        const start = this.pos;
        const ch = this.input[this.pos];
        if (ch >= "0" && ch <= "9") {
          return this.readNumber();
        }
        if (ch === '"' || ch === "'" || ch === "`") {
          return this.readString(ch);
        }
        if (ch === "b" && this.pos + 1 < this.input.length) {
          const next = this.input[this.pos + 1];
          if (next === '"' || next === "'" || next === "`") {
            this.pos++;
            return this.readString(next);
          }
        }
        if (ch === "/") {
          const prev = this.tokens[this.tokens.length - 1];
          if (prev && (prev.type === "int" || prev.type === "float" || prev.type === "string" || prev.type === "ident" || prev.type === ")" || prev.type === "]")) {
            if (this.input[this.pos + 1] === "/") {
              this.pos += 2;
              return { type: "//", value: "//", pos: start };
            }
            this.pos++;
            return { type: "/", value: "/", pos: start };
          }
          return this.readRegex();
        }
        if (this.match("not in"))
          return { type: "not in", value: "not in", pos: start };
        if (this.match("=>"))
          return { type: "=>", value: "=>", pos: start };
        if (this.match("**"))
          return { type: "**", value: "**", pos: start };
        if (this.match("++"))
          return { type: "++", value: "++", pos: start };
        if (this.match("//"))
          return { type: "//", value: "//", pos: start };
        if (this.match("=="))
          return { type: "==", value: "==", pos: start };
        if (this.match("!="))
          return { type: "!=", value: "!=", pos: start };
        if (this.match("<="))
          return { type: "<=", value: "<=", pos: start };
        if (this.match(">="))
          return { type: ">=", value: ">=", pos: start };
        if (this.match("&&"))
          return { type: "&&", value: "&&", pos: start };
        if (this.match("||"))
          return { type: "||", value: "||", pos: start };
        const singleOps = {
          "(": "(",
          ")": ")",
          "[": "[",
          "]": "]",
          "{": "{",
          "}": "}",
          ",": ",",
          ":": ":",
          ";": ";",
          "+": "+",
          "-": "-",
          "*": "*",
          "%": "%",
          "<": "<",
          ">": ">",
          "!": "!",
          ".": ".",
          "|": "|",
          "=": "="
        };
        if (ch in singleOps) {
          this.pos++;
          return { type: singleOps[ch], value: ch, pos: start };
        }
        if (this.isIdentStart(ch)) {
          return this.readIdentifier();
        }
        throw new Error(`Unexpected character '${ch}' at position ${this.pos}`);
      }
      match(str) {
        if (this.input.slice(this.pos, this.pos + str.length) === str) {
          if (/^[a-zA-Z]/.test(str)) {
            const next = this.input[this.pos + str.length];
            if (next && this.isIdentChar(next)) {
              return false;
            }
          }
          this.pos += str.length;
          return true;
        }
        return false;
      }
      isIdentStart(ch) {
        return ch >= "a" && ch <= "z" || ch >= "A" && ch <= "Z" || ch === "_";
      }
      isIdentChar(ch) {
        return this.isIdentStart(ch) || ch >= "0" && ch <= "9";
      }
      readNumber() {
        const start = this.pos;
        let hasDecimal = false;
        let hasExponent = false;
        while (this.pos < this.input.length) {
          const ch = this.input[this.pos];
          if (ch >= "0" && ch <= "9") {
            this.pos++;
          } else if (ch === "_") {
            this.pos++;
          } else if (ch === "." && !hasDecimal && !hasExponent) {
            hasDecimal = true;
            this.pos++;
          } else if ((ch === "e" || ch === "E") && !hasExponent) {
            hasExponent = true;
            hasDecimal = true;
            this.pos++;
            if (this.pos < this.input.length && (this.input[this.pos] === "+" || this.input[this.pos] === "-")) {
              this.pos++;
            }
          } else {
            break;
          }
        }
        const value = this.input.slice(start, this.pos).replace(/_/g, "");
        return {
          type: hasDecimal ? "float" : "int",
          value,
          pos: start
        };
      }
      readString(quote) {
        const start = this.pos;
        this.pos++;
        let value = "";
        while (this.pos < this.input.length) {
          const ch = this.input[this.pos];
          if (ch === quote) {
            this.pos++;
            return { type: "string", value, pos: start };
          }
          if (ch === "\\") {
            this.pos++;
            if (this.pos < this.input.length) {
              const escaped = this.input[this.pos];
              switch (escaped) {
                case "n":
                  value += "\n";
                  break;
                case "r":
                  value += "\r";
                  break;
                case "t":
                  value += "	";
                  break;
                case "\\":
                  value += "\\";
                  break;
                case '"':
                  value += '"';
                  break;
                case "'":
                  value += "'";
                  break;
                case "`":
                  value += "`";
                  break;
                case "0":
                  value += "\0";
                  break;
                default:
                  value += escaped;
              }
              this.pos++;
            }
          } else {
            value += ch;
            this.pos++;
          }
        }
        throw new Error(`Unterminated string starting at position ${start}`);
      }
      readRegex() {
        const start = this.pos;
        this.pos++;
        let pattern = "";
        let flags = "";
        while (this.pos < this.input.length) {
          const ch = this.input[this.pos];
          if (ch === "/") {
            this.pos++;
            while (this.pos < this.input.length && this.input[this.pos] === "i") {
              flags += this.input[this.pos];
              this.pos++;
            }
            return {
              type: "regex",
              value: pattern + (flags ? `/${flags}` : ""),
              pos: start
            };
          }
          if (ch === "\\") {
            pattern += ch;
            this.pos++;
            if (this.pos < this.input.length) {
              pattern += this.input[this.pos];
              this.pos++;
            }
          } else {
            pattern += ch;
            this.pos++;
          }
        }
        throw new Error(`Unterminated regex starting at position ${start}`);
      }
      readIdentifier() {
        const start = this.pos;
        while (this.pos < this.input.length && this.isIdentChar(this.input[this.pos])) {
          this.pos++;
        }
        let unsure = false;
        if (this.pos < this.input.length && this.input[this.pos] === "?") {
          unsure = true;
          this.pos++;
        }
        let value = this.input.slice(start, unsure ? this.pos - 1 : this.pos);
        if (unsure)
          value += "?";
        const keywords = {
          true: "true",
          false: "false",
          null: "null",
          and: "and",
          or: "or",
          eq: "eq",
          ne: "ne",
          lt: "lt",
          le: "le",
          gt: "gt",
          ge: "ge",
          in: "in",
          as: "as",
          _: "_"
        };
        const baseValue = value.replace(/\?$/, "");
        if (baseValue in keywords && !unsure) {
          return { type: keywords[baseValue], value: baseValue, pos: start };
        }
        return { type: "ident", value, pos: start };
      }
    };
  }
});

// dist/commands/xan/moonblade-parser.js
var moonblade_parser_exports = {};
__export(moonblade_parser_exports, {
  parseMoonblade: () => parseMoonblade,
  parseNamedExpressions: () => parseNamedExpressions
});
function parseNamedExpressions(input) {
  const results = [];
  const tokenizer = new Tokenizer(input);
  const tokens = tokenizer.tokenize();
  let pos = 0;
  const peek = /* @__PURE__ */ __name(() => tokens[pos] || { type: "eof", value: "", pos: 0 }, "peek");
  const advance = /* @__PURE__ */ __name(() => tokens[pos++], "advance");
  while (peek().type !== "eof") {
    if (peek().type === "," && results.length > 0) {
      advance();
      continue;
    }
    const exprTokens = [];
    let depth = 0;
    const startPos = pos;
    while (peek().type !== "eof") {
      const token = peek();
      if ((token.type === "," || token.type === "as") && depth === 0) {
        break;
      }
      if (token.type === "(" || token.type === "[" || token.type === "{")
        depth++;
      if (token.type === ")" || token.type === "]" || token.type === "}")
        depth--;
      exprTokens.push(advance());
    }
    exprTokens.push({ type: "eof", value: "", pos: 0 });
    const parser = new Parser(exprTokens);
    const expr = parser.parse();
    let name;
    if (peek().type === "as") {
      advance();
      if (peek().type === "(") {
        advance();
        const names = [];
        while (peek().type !== ")" && peek().type !== "eof") {
          if (peek().type === "ident" || peek().type === "string") {
            names.push(peek().value);
            advance();
          }
          if (peek().type === ",")
            advance();
        }
        if (peek().type === ")")
          advance();
        name = names;
      } else if (peek().type === "ident" || peek().type === "string") {
        name = peek().value;
        advance();
      } else {
        throw new Error(`Expected name after 'as', got ${peek().type}`);
      }
    } else {
      name = input.slice(tokens[startPos].pos, tokens[pos - 1]?.pos || input.length).trim();
      if (expr.type === "identifier") {
        name = expr.name;
      }
    }
    results.push({ expr, name });
  }
  return results;
}
function parseMoonblade(input) {
  const tokenizer = new Tokenizer(input);
  const tokens = tokenizer.tokenize();
  const parser = new Parser(tokens);
  return parser.parse();
}
var PREC, Parser;
var init_moonblade_parser = __esm({
  "dist/commands/xan/moonblade-parser.js"() {
    "use strict";
    init_moonblade_tokenizer();
    PREC = {
      PIPE: 1,
      OR: 2,
      AND: 3,
      EQUALITY: 4,
      COMPARISON: 5,
      ADDITIVE: 6,
      MULTIPLICATIVE: 7,
      POWER: 8,
      UNARY: 9,
      POSTFIX: 10
    };
    Parser = class {
      static {
        __name(this, "Parser");
      }
      pos = 0;
      tokens;
      constructor(tokens) {
        this.tokens = tokens;
      }
      parse() {
        const expr = this.parseExpr(0);
        if (this.peek().type !== "eof") {
          throw new Error(`Unexpected token: ${this.peek().value}`);
        }
        return expr;
      }
      parseExpr(minPrec) {
        let left = this.parsePrefix();
        while (true) {
          const token = this.peek();
          const prec = this.getInfixPrec(token.type);
          if (prec < minPrec)
            break;
          left = this.parseInfix(left, prec);
        }
        return left;
      }
      parsePrefix() {
        const token = this.peek();
        switch (token.type) {
          case "int":
            this.advance();
            return { type: "int", value: Number.parseInt(token.value, 10) };
          case "float":
            this.advance();
            return { type: "float", value: Number.parseFloat(token.value) };
          case "string":
            this.advance();
            return { type: "string", value: token.value };
          case "regex": {
            this.advance();
            const parts = token.value.split("/");
            const flags = parts.length > 1 ? parts[parts.length - 1] : "";
            const pattern = parts.slice(0, -1).join("/") || token.value;
            return { type: "regex", pattern, caseInsensitive: flags.includes("i") };
          }
          case "true":
            this.advance();
            return { type: "bool", value: true };
          case "false":
            this.advance();
            return { type: "bool", value: false };
          case "null":
            this.advance();
            return { type: "null" };
          case "_":
            this.advance();
            return { type: "underscore" };
          case "ident": {
            const name = token.value;
            const unsure = name.endsWith("?");
            const cleanName = unsure ? name.slice(0, -1) : name;
            this.advance();
            if (this.peek().type === "(") {
              return this.parseFunctionCall(cleanName);
            }
            if (this.peek().type === "=>") {
              this.advance();
              const body = this.parseExpr(0);
              return this.bindLambdaArgs({ type: "lambda", params: [cleanName], body }, [cleanName]);
            }
            return { type: "identifier", name: cleanName, unsure };
          }
          case "(": {
            this.advance();
            const params = [];
            if (this.peek().type === ")") {
              this.advance();
              if (this.peek().type === "=>") {
                this.advance();
                const body = this.parseExpr(0);
                return { type: "lambda", params: [], body };
              }
              throw new Error("Empty parentheses not allowed");
            }
            if (this.peek().type === "ident") {
              const firstIdent = this.peek().value;
              this.advance();
              if (this.peek().type === "," || this.peek().type === ")") {
                params.push(firstIdent);
                while (this.peek().type === ",") {
                  this.advance();
                  if (this.peek().type === "ident") {
                    params.push(this.peek().value);
                    this.advance();
                  } else {
                    break;
                  }
                }
                if (this.peek().type === ")") {
                  this.advance();
                  if (this.peek().type === "=>") {
                    this.advance();
                    const body = this.parseExpr(0);
                    return this.bindLambdaArgs({ type: "lambda", params, body }, params);
                  }
                }
                this.pos -= params.length * 2;
                if (params.length > 1) {
                  this.pos = this.pos;
                }
              }
              this.pos--;
            }
            const expr = this.parseExpr(0);
            this.expect(")");
            if (this.peek().type === "=>") {
            }
            return expr;
          }
          case "[":
            return this.parseList();
          case "{":
            return this.parseMap();
          case "-": {
            this.advance();
            const operand = this.parseExpr(PREC.UNARY);
            if (operand.type === "int") {
              return { type: "int", value: -operand.value };
            }
            if (operand.type === "float") {
              return { type: "float", value: -operand.value };
            }
            return { type: "func", name: "neg", args: [{ expr: operand }] };
          }
          case "!": {
            this.advance();
            const operand = this.parseExpr(PREC.UNARY);
            return { type: "func", name: "not", args: [{ expr: operand }] };
          }
          default:
            throw new Error(`Unexpected token: ${token.type} (${token.value})`);
        }
      }
      parseFunctionCall(name) {
        this.expect("(");
        const args = [];
        if (this.peek().type !== ")") {
          do {
            if (args.length > 0 && this.peek().type === ",") {
              this.advance();
            }
            let argName;
            if (this.peek().type === "ident") {
              const ident = this.peek().value;
              const nextPos = this.pos + 1;
              if (nextPos < this.tokens.length && this.tokens[nextPos].type === "=") {
                argName = ident;
                this.advance();
                this.advance();
              }
            }
            const expr = this.parseExpr(0);
            args.push({ name: argName, expr });
          } while (this.peek().type === ",");
        }
        this.expect(")");
        return { type: "func", name: name.toLowerCase(), args };
      }
      parseList() {
        this.expect("[");
        const elements = [];
        if (this.peek().type !== "]") {
          do {
            if (elements.length > 0 && this.peek().type === ",") {
              this.advance();
            }
            elements.push(this.parseExpr(0));
          } while (this.peek().type === ",");
        }
        this.expect("]");
        return { type: "list", elements };
      }
      parseMap() {
        this.expect("{");
        const entries = [];
        if (this.peek().type !== "}") {
          do {
            if (entries.length > 0 && this.peek().type === ",") {
              this.advance();
            }
            let key;
            if (this.peek().type === "ident") {
              key = this.peek().value;
              this.advance();
            } else if (this.peek().type === "string") {
              key = this.peek().value;
              this.advance();
            } else {
              throw new Error(`Expected map key, got ${this.peek().type}`);
            }
            this.expect(":");
            const value = this.parseExpr(0);
            entries.push({ key, value });
          } while (this.peek().type === ",");
        }
        this.expect("}");
        return { type: "map", entries };
      }
      parseInfix(left, prec) {
        const token = this.peek();
        const binaryOps = {
          "+": "add",
          "-": "sub",
          "*": "mul",
          "/": "div",
          "//": "idiv",
          "%": "mod",
          "**": "pow",
          "++": "concat",
          "==": "==",
          "!=": "!=",
          "<": "<",
          "<=": "<=",
          ">": ">",
          ">=": ">=",
          eq: "eq",
          ne: "ne",
          lt: "lt",
          le: "le",
          gt: "gt",
          ge: "ge",
          "&&": "and",
          and: "and",
          "||": "or",
          or: "or"
        };
        if (token.type in binaryOps) {
          this.advance();
          const right = this.parseExpr(prec + (this.isRightAssoc(token.type) ? 0 : 1));
          return {
            type: "func",
            name: binaryOps[token.type],
            args: [{ expr: left }, { expr: right }]
          };
        }
        if (token.type === "|") {
          this.advance();
          const right = this.parseExpr(prec);
          return this.handlePipe(left, right);
        }
        if (token.type === ".") {
          this.advance();
          return this.handleDot(left);
        }
        if (token.type === "[") {
          this.advance();
          return this.handleIndexing(left);
        }
        if (token.type === "in") {
          this.advance();
          const right = this.parseExpr(prec + 1);
          return {
            type: "func",
            name: "contains",
            args: [{ expr: right }, { expr: left }]
          };
        }
        if (token.type === "not in") {
          this.advance();
          const right = this.parseExpr(prec + 1);
          return {
            type: "func",
            name: "not",
            args: [
              {
                expr: {
                  type: "func",
                  name: "contains",
                  args: [{ expr: right }, { expr: left }]
                }
              }
            ]
          };
        }
        throw new Error(`Unexpected infix token: ${token.type}`);
      }
      handlePipe(left, right) {
        if (right.type === "identifier") {
          return { type: "func", name: right.name, args: [{ expr: left }] };
        }
        if (right.type === "func") {
          const underscoreCount = this.countUnderscores(right);
          if (underscoreCount === 0) {
            return right;
          }
          if (underscoreCount === 1) {
            return this.fillUnderscore(right, left);
          }
          return { type: "pipeline", exprs: [left, right] };
        }
        if (this.countUnderscores(right) === 1) {
          return this.fillUnderscore(right, left);
        }
        return right;
      }
      handleDot(left) {
        const token = this.peek();
        if (token.type === "ident") {
          const name = token.value;
          this.advance();
          if (this.peek().type === "(") {
            const call = this.parseFunctionCall(name);
            if (call.type === "func") {
              call.args.unshift({ expr: left });
            }
            return call;
          }
          return {
            type: "func",
            name: "get",
            args: [{ expr: left }, { expr: { type: "string", value: name } }]
          };
        }
        if (token.type === "int") {
          const idx = Number.parseInt(token.value, 10);
          this.advance();
          return {
            type: "func",
            name: "get",
            args: [{ expr: left }, { expr: { type: "int", value: idx } }]
          };
        }
        if (token.type === "string") {
          const key = token.value;
          this.advance();
          return {
            type: "func",
            name: "get",
            args: [{ expr: left }, { expr: { type: "string", value: key } }]
          };
        }
        throw new Error(`Expected identifier, number, or string after dot, got ${token.type}`);
      }
      handleIndexing(left) {
        if (this.peek().type === ":") {
          this.advance();
          if (this.peek().type === "]") {
            this.advance();
            return { type: "func", name: "slice", args: [{ expr: left }] };
          }
          const end = this.parseExpr(0);
          this.expect("]");
          return {
            type: "func",
            name: "slice",
            args: [
              { expr: left },
              { expr: { type: "int", value: 0 } },
              { expr: end }
            ]
          };
        }
        const start = this.parseExpr(0);
        if (this.peek().type === ":") {
          this.advance();
          if (this.peek().type === "]") {
            this.advance();
            return {
              type: "func",
              name: "slice",
              args: [{ expr: left }, { expr: start }]
            };
          }
          const end = this.parseExpr(0);
          this.expect("]");
          return {
            type: "func",
            name: "slice",
            args: [{ expr: left }, { expr: start }, { expr: end }]
          };
        }
        this.expect("]");
        return {
          type: "func",
          name: "get",
          args: [{ expr: left }, { expr: start }]
        };
      }
      countUnderscores(expr) {
        if (expr.type === "underscore")
          return 1;
        if (expr.type === "func") {
          return expr.args.reduce((sum, arg) => sum + this.countUnderscores(arg.expr), 0);
        }
        if (expr.type === "list") {
          return expr.elements.reduce((sum, el) => sum + this.countUnderscores(el), 0);
        }
        if (expr.type === "map") {
          return expr.entries.reduce((sum, e) => sum + this.countUnderscores(e.value), 0);
        }
        return 0;
      }
      fillUnderscore(expr, fill) {
        if (expr.type === "underscore")
          return fill;
        if (expr.type === "func") {
          return {
            ...expr,
            args: expr.args.map((arg) => ({
              ...arg,
              expr: this.fillUnderscore(arg.expr, fill)
            }))
          };
        }
        if (expr.type === "list") {
          return {
            ...expr,
            elements: expr.elements.map((el) => this.fillUnderscore(el, fill))
          };
        }
        if (expr.type === "map") {
          return {
            ...expr,
            entries: expr.entries.map((e) => ({
              ...e,
              value: this.fillUnderscore(e.value, fill)
            }))
          };
        }
        return expr;
      }
      bindLambdaArgs(expr, names) {
        return {
          ...expr,
          body: this.bindLambdaArgsInExpr(expr.body, names)
        };
      }
      bindLambdaArgsInExpr(expr, names) {
        if (expr.type === "identifier" && names.includes(expr.name)) {
          return { type: "lambdaBinding", name: expr.name };
        }
        if (expr.type === "func") {
          return {
            ...expr,
            args: expr.args.map((arg) => ({
              ...arg,
              expr: this.bindLambdaArgsInExpr(arg.expr, names)
            }))
          };
        }
        if (expr.type === "list") {
          return {
            ...expr,
            elements: expr.elements.map((el) => this.bindLambdaArgsInExpr(el, names))
          };
        }
        if (expr.type === "map") {
          return {
            ...expr,
            entries: expr.entries.map((e) => ({
              ...e,
              value: this.bindLambdaArgsInExpr(e.value, names)
            }))
          };
        }
        return expr;
      }
      getInfixPrec(type) {
        switch (type) {
          case "|":
            return PREC.PIPE;
          case "||":
          case "or":
            return PREC.OR;
          case "&&":
          case "and":
            return PREC.AND;
          case "==":
          case "!=":
          case "eq":
          case "ne":
            return PREC.EQUALITY;
          case "<":
          case "<=":
          case ">":
          case ">=":
          case "lt":
          case "le":
          case "gt":
          case "ge":
          case "in":
          case "not in":
            return PREC.COMPARISON;
          case "+":
          case "-":
          case "++":
            return PREC.ADDITIVE;
          case "*":
          case "/":
          case "//":
          case "%":
            return PREC.MULTIPLICATIVE;
          case "**":
            return PREC.POWER;
          case ".":
          case "[":
            return PREC.POSTFIX;
          default:
            return -1;
        }
      }
      isRightAssoc(type) {
        return type === "**";
      }
      peek() {
        return this.tokens[this.pos] || { type: "eof", value: "", pos: 0 };
      }
      advance() {
        return this.tokens[this.pos++];
      }
      expect(type) {
        const token = this.peek();
        if (token.type !== type) {
          throw new Error(`Expected ${type}, got ${token.type}`);
        }
        return this.advance();
      }
    };
    __name(parseNamedExpressions, "parseNamedExpressions");
    __name(parseMoonblade, "parseMoonblade");
  }
});

// dist/commands/xan/aggregation.js
init_moonblade_parser();

// dist/commands/xan/moonblade-to-jq.js
function makePipeFunc(funcName, args) {
  if (args.length === 0) {
    return makeCall(funcName, []);
  }
  if (args.length === 1) {
    return { type: "Pipe", left: args[0], right: makeCall(funcName, []) };
  }
  return {
    type: "Pipe",
    left: args[0],
    right: makeCall(funcName, args.slice(1))
  };
}
__name(makePipeFunc, "makePipeFunc");
var FUNCTION_MAP = {
  // Arithmetic
  add: /* @__PURE__ */ __name((args) => makeBinaryOp("+", args[0], args[1]), "add"),
  sub: /* @__PURE__ */ __name((args) => makeBinaryOp("-", args[0], args[1]), "sub"),
  mul: /* @__PURE__ */ __name((args) => makeBinaryOp("*", args[0], args[1]), "mul"),
  div: /* @__PURE__ */ __name((args) => makeBinaryOp("/", args[0], args[1]), "div"),
  mod: /* @__PURE__ */ __name((args) => makeBinaryOp("%", args[0], args[1]), "mod"),
  idiv: /* @__PURE__ */ __name((args) => makeCall("floor", [makeBinaryOp("/", args[0], args[1])]), "idiv"),
  pow: /* @__PURE__ */ __name((args) => makePipeFunc("pow", args), "pow"),
  neg: /* @__PURE__ */ __name((args) => ({ type: "UnaryOp", op: "-", operand: args[0] }), "neg"),
  // Comparison
  "==": /* @__PURE__ */ __name((args) => makeBinaryOp("==", args[0], args[1]), "=="),
  "!=": /* @__PURE__ */ __name((args) => makeBinaryOp("!=", args[0], args[1]), "!="),
  "<": /* @__PURE__ */ __name((args) => makeBinaryOp("<", args[0], args[1]), "<"),
  "<=": /* @__PURE__ */ __name((args) => makeBinaryOp("<=", args[0], args[1]), "<="),
  ">": /* @__PURE__ */ __name((args) => makeBinaryOp(">", args[0], args[1]), ">"),
  ">=": /* @__PURE__ */ __name((args) => makeBinaryOp(">=", args[0], args[1]), ">="),
  // String comparison (case-sensitive string compare) - convert to strings first using pipe
  eq: /* @__PURE__ */ __name((args) => makeBinaryOp("==", makePipeTostring(args[0]), makePipeTostring(args[1])), "eq"),
  ne: /* @__PURE__ */ __name((args) => makeBinaryOp("!=", makePipeTostring(args[0]), makePipeTostring(args[1])), "ne"),
  lt: /* @__PURE__ */ __name((args) => makeBinaryOp("<", makePipeTostring(args[0]), makePipeTostring(args[1])), "lt"),
  le: /* @__PURE__ */ __name((args) => makeBinaryOp("<=", makePipeTostring(args[0]), makePipeTostring(args[1])), "le"),
  gt: /* @__PURE__ */ __name((args) => makeBinaryOp(">", makePipeTostring(args[0]), makePipeTostring(args[1])), "gt"),
  ge: /* @__PURE__ */ __name((args) => makeBinaryOp(">=", makePipeTostring(args[0]), makePipeTostring(args[1])), "ge"),
  // Logical
  and: /* @__PURE__ */ __name((args) => makeBinaryOp("and", args[0], args[1]), "and"),
  or: /* @__PURE__ */ __name((args) => makeBinaryOp("or", args[0], args[1]), "or"),
  not: /* @__PURE__ */ __name((args) => ({ type: "UnaryOp", op: "not", operand: args[0] }), "not"),
  // String functions - use pipe syntax for single-arg functions
  len: /* @__PURE__ */ __name((args) => makePipeFunc("length", args), "len"),
  length: /* @__PURE__ */ __name((args) => makePipeFunc("length", args), "length"),
  upper: /* @__PURE__ */ __name((args) => makePipeFunc("ascii_upcase", args), "upper"),
  lower: /* @__PURE__ */ __name((args) => makePipeFunc("ascii_downcase", args), "lower"),
  trim: /* @__PURE__ */ __name((args) => makePipeFunc("trim", args), "trim"),
  ltrim: /* @__PURE__ */ __name((args) => args.length === 0 ? makeCall("ltrimstr", [{ type: "Literal", value: " " }]) : {
    type: "Pipe",
    left: args[0],
    right: makeCall("ltrimstr", [{ type: "Literal", value: " " }])
  }, "ltrim"),
  rtrim: /* @__PURE__ */ __name((args) => args.length === 0 ? makeCall("rtrimstr", [{ type: "Literal", value: " " }]) : {
    type: "Pipe",
    left: args[0],
    right: makeCall("rtrimstr", [{ type: "Literal", value: " " }])
  }, "rtrim"),
  split: /* @__PURE__ */ __name((args) => makePipeFunc("split", args), "split"),
  join: /* @__PURE__ */ __name((args) => args.length === 1 ? makeCall("join", [{ type: "Literal", value: "" }]) : makePipeFunc("join", args), "join"),
  concat: /* @__PURE__ */ __name((args) => makeBinaryOp("+", args[0], args[1]), "concat"),
  startswith: /* @__PURE__ */ __name((args) => makePipeFunc("startswith", args), "startswith"),
  endswith: /* @__PURE__ */ __name((args) => makePipeFunc("endswith", args), "endswith"),
  contains: /* @__PURE__ */ __name((args) => makePipeFunc("contains", args), "contains"),
  replace: /* @__PURE__ */ __name((args) => makePipeFunc("gsub", args), "replace"),
  substr: /* @__PURE__ */ __name((args) => {
    if (args.length === 2) {
      return { type: "Slice", base: args[0], start: args[1] };
    }
    return {
      type: "Slice",
      base: args[0],
      start: args[1],
      end: makeBinaryOp("+", args[1], args[2])
    };
  }, "substr"),
  // Math functions - use pipe syntax for single-arg functions
  abs: /* @__PURE__ */ __name((args) => makePipeFunc("fabs", args), "abs"),
  floor: /* @__PURE__ */ __name((args) => makePipeFunc("floor", args), "floor"),
  ceil: /* @__PURE__ */ __name((args) => makePipeFunc("ceil", args), "ceil"),
  round: /* @__PURE__ */ __name((args) => makePipeFunc("round", args), "round"),
  sqrt: /* @__PURE__ */ __name((args) => makePipeFunc("sqrt", args), "sqrt"),
  log: /* @__PURE__ */ __name((args) => makePipeFunc("log", args), "log"),
  log10: /* @__PURE__ */ __name((args) => makePipeFunc("log10", args), "log10"),
  log2: /* @__PURE__ */ __name((args) => makePipeFunc("log2", args), "log2"),
  exp: /* @__PURE__ */ __name((args) => makePipeFunc("exp", args), "exp"),
  sin: /* @__PURE__ */ __name((args) => makePipeFunc("sin", args), "sin"),
  cos: /* @__PURE__ */ __name((args) => makePipeFunc("cos", args), "cos"),
  tan: /* @__PURE__ */ __name((args) => makePipeFunc("tan", args), "tan"),
  asin: /* @__PURE__ */ __name((args) => makePipeFunc("asin", args), "asin"),
  acos: /* @__PURE__ */ __name((args) => makePipeFunc("acos", args), "acos"),
  atan: /* @__PURE__ */ __name((args) => makePipeFunc("atan", args), "atan"),
  min: /* @__PURE__ */ __name((args) => makePipeFunc("min", args), "min"),
  max: /* @__PURE__ */ __name((args) => makePipeFunc("max", args), "max"),
  // Collection functions
  first: /* @__PURE__ */ __name((args) => args.length === 0 ? { type: "Index", index: { type: "Literal", value: 0 } } : { type: "Index", index: { type: "Literal", value: 0 }, base: args[0] }, "first"),
  last: /* @__PURE__ */ __name((args) => args.length === 0 ? { type: "Index", index: { type: "Literal", value: -1 } } : { type: "Index", index: { type: "Literal", value: -1 }, base: args[0] }, "last"),
  get: /* @__PURE__ */ __name((args) => {
    if (args.length === 1) {
      return { type: "Index", index: args[0] };
    }
    return { type: "Index", index: args[1], base: args[0] };
  }, "get"),
  slice: /* @__PURE__ */ __name((args) => {
    if (args.length === 1) {
      return { type: "Slice", base: args[0] };
    }
    if (args.length === 2) {
      return { type: "Slice", base: args[0], start: args[1] };
    }
    return { type: "Slice", base: args[0], start: args[1], end: args[2] };
  }, "slice"),
  keys: "keys",
  values: "values",
  entries: /* @__PURE__ */ __name((args) => makeCall("to_entries", args), "entries"),
  from_entries: "from_entries",
  reverse: "reverse",
  sort: "sort",
  sort_by: "sort_by",
  group_by: "group_by",
  unique: "unique",
  unique_by: "unique_by",
  flatten: "flatten",
  map: /* @__PURE__ */ __name((args) => ({
    type: "Pipe",
    left: args[0],
    right: { type: "Array", elements: args[1] }
  }), "map"),
  select: /* @__PURE__ */ __name((args) => makeCall("select", args), "select"),
  empty: /* @__PURE__ */ __name(() => makeCall("empty", []), "empty"),
  // Aggregation functions (used in agg/groupby context)
  count: /* @__PURE__ */ __name(() => makeCall("length", []), "count"),
  sum: /* @__PURE__ */ __name((args) => args.length === 0 ? makeCall("add", []) : {
    type: "Pipe",
    left: { type: "Array", elements: args[0] },
    right: makeCall("add", [])
  }, "sum"),
  mean: /* @__PURE__ */ __name((args) => args.length === 0 ? {
    type: "Pipe",
    left: { type: "Identity" },
    right: makeBinaryOp("/", makeCall("add", []), makeCall("length", []))
  } : {
    type: "Pipe",
    left: { type: "Array", elements: args[0] },
    right: makeBinaryOp("/", makeCall("add", []), makeCall("length", []))
  }, "mean"),
  avg: /* @__PURE__ */ __name((args) => args.length === 0 ? {
    type: "Pipe",
    left: { type: "Identity" },
    right: makeBinaryOp("/", makeCall("add", []), makeCall("length", []))
  } : {
    type: "Pipe",
    left: { type: "Array", elements: args[0] },
    right: makeBinaryOp("/", makeCall("add", []), makeCall("length", []))
  }, "avg"),
  // Type functions
  type: "type",
  isnull: /* @__PURE__ */ __name((args) => args.length === 0 ? makeBinaryOp("==", { type: "Identity" }, { type: "Literal", value: null }) : makeBinaryOp("==", args[0], { type: "Literal", value: null }), "isnull"),
  isempty: /* @__PURE__ */ __name((args) => args.length === 0 ? makeBinaryOp("==", { type: "Identity" }, { type: "Literal", value: "" }) : makeBinaryOp("==", args[0], { type: "Literal", value: "" }), "isempty"),
  tonumber: /* @__PURE__ */ __name((args) => args.length === 0 ? makeCall("tonumber", []) : makeCall("tonumber", args), "tonumber"),
  tostring: /* @__PURE__ */ __name((args) => args.length === 0 ? makeCall("tostring", []) : makeCall("tostring", args), "tostring"),
  // Conditional
  if: /* @__PURE__ */ __name((args) => makeCond(args[0], args[1], args[2]), "if"),
  coalesce: /* @__PURE__ */ __name((args) => {
    if (args.length === 0)
      return { type: "Literal", value: null };
    if (args.length === 1)
      return args[0];
    const [first, ...rest] = args;
    const condition = makeBinaryOp("and", makeBinaryOp("!=", first, { type: "Literal", value: null }), makeBinaryOp("!=", first, { type: "Literal", value: "" }));
    return makeCond(condition, first, rest.length === 1 ? rest[0] : FUNCTION_MAP.coalesce(rest));
  }, "coalesce"),
  // Index function for xan - access the _row_index field
  index: /* @__PURE__ */ __name(() => ({ type: "Field", name: "_row_index" }), "index"),
  // Date/time functions
  now: /* @__PURE__ */ __name(() => makeCall("now", []), "now"),
  // Format functions (these may need special handling)
  fmt: /* @__PURE__ */ __name((args) => makeCall("tostring", args), "fmt"),
  format: /* @__PURE__ */ __name((args) => makeCall("tostring", args), "format")
};
function makeBinaryOp(op, left, right) {
  return { type: "BinaryOp", op, left, right };
}
__name(makeBinaryOp, "makeBinaryOp");
function makeCall(name, args) {
  return { type: "Call", name, args };
}
__name(makeCall, "makeCall");
var THEN_PROP = "then";
function makeCond(cond, thenBranch, elseBranch) {
  const node = {
    type: "Cond",
    cond,
    elifs: [],
    else: elseBranch || { type: "Literal", value: null }
  };
  node[THEN_PROP] = thenBranch;
  return node;
}
__name(makeCond, "makeCond");
function makePipeTostring(node) {
  return {
    type: "Pipe",
    left: node,
    right: { type: "Call", name: "tostring", args: [] }
  };
}
__name(makePipeTostring, "makePipeTostring");
function moonbladeToJq(expr, rowContext = true) {
  switch (expr.type) {
    case "int":
    case "float":
      return { type: "Literal", value: expr.value };
    case "string":
      return { type: "Literal", value: expr.value };
    case "bool":
      return { type: "Literal", value: expr.value };
    case "null":
      return { type: "Literal", value: null };
    case "underscore":
      return {
        type: "Index",
        base: { type: "Identity" },
        index: { type: "Literal", value: "_" }
      };
    case "identifier":
      if (rowContext) {
        return { type: "Field", name: expr.name };
      }
      return { type: "VarRef", name: expr.name };
    case "lambdaBinding":
      return { type: "VarRef", name: expr.name };
    case "func": {
      const args = expr.args.map((a) => moonbladeToJq(a.expr, rowContext));
      const handler = FUNCTION_MAP[expr.name];
      if (typeof handler === "function") {
        return handler(args);
      }
      if (typeof handler === "string") {
        return makeCall(handler, args);
      }
      return makeCall(expr.name, args);
    }
    case "list":
      if (expr.elements.length === 0) {
        return { type: "Array" };
      }
      return {
        type: "Array",
        elements: expr.elements.reduce((acc, el, i) => {
          const node = moonbladeToJq(el, rowContext);
          if (i === 0)
            return node;
          return { type: "Comma", left: acc, right: node };
        }, null)
      };
    case "map":
      return {
        type: "Object",
        entries: expr.entries.map((e) => ({
          key: e.key,
          value: moonbladeToJq(e.value, rowContext)
        }))
      };
    case "regex":
      return { type: "Literal", value: expr.pattern };
    case "slice":
      return {
        type: "Slice",
        start: expr.start ? moonbladeToJq(expr.start, rowContext) : void 0,
        end: expr.end ? moonbladeToJq(expr.end, rowContext) : void 0
      };
    case "lambda":
      return moonbladeToJq(expr.body, rowContext);
    case "pipeline":
      return { type: "Identity" };
    default:
      throw new Error(`Unknown moonblade expression type: ${expr.type}`);
  }
}
__name(moonbladeToJq, "moonbladeToJq");

// dist/commands/xan/aggregation.js
function parseAggExpr(expr) {
  const specs = [];
  let i = 0;
  while (i < expr.length) {
    while (i < expr.length && (expr[i] === " " || expr[i] === ","))
      i++;
    if (i >= expr.length)
      break;
    const funcStart = i;
    while (i < expr.length && /\w/.test(expr[i]))
      i++;
    const func = expr.slice(funcStart, i);
    while (i < expr.length && expr[i] === " ")
      i++;
    if (expr[i] !== "(")
      break;
    i++;
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
    i++;
    while (i < expr.length && expr[i] === " ")
      i++;
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
    if (!alias) {
      alias = innerExpr ? `${func}(${innerExpr})` : `${func}()`;
    }
    specs.push({ func, expr: innerExpr, alias });
  }
  return specs;
}
__name(parseAggExpr, "parseAggExpr");
function isSimpleColumn(expr) {
  return /^\w+$/.test(expr);
}
__name(isSimpleColumn, "isSimpleColumn");
function evalExpr(row, expr, evalOptions) {
  const ast = moonbladeToJq(parseMoonblade(expr));
  const results = evaluate(row, ast, evalOptions);
  return results.length > 0 ? results[0] : null;
}
__name(evalExpr, "evalExpr");
function computeAgg(data, spec, evalOptions = {}) {
  const { func, expr } = spec;
  if (func === "count" && !expr) {
    return data.length;
  }
  let values;
  if (isSimpleColumn(expr)) {
    values = data.map((r) => r[expr]).filter((v) => v !== null && v !== void 0);
  } else {
    values = data.map((r) => evalExpr(r, expr, evalOptions)).filter((v) => v !== null && v !== void 0);
  }
  switch (func) {
    case "count": {
      if (isSimpleColumn(expr)) {
        return values.length;
      }
      return values.filter((v) => !!v).length;
    }
    case "sum": {
      const nums = values.map((v) => typeof v === "number" ? v : Number.parseFloat(String(v)));
      return nums.reduce((a, b) => a + b, 0);
    }
    case "mean":
    case "avg": {
      const nums = values.map((v) => typeof v === "number" ? v : Number.parseFloat(String(v)));
      return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
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
      return values.length > 0 ? values[values.length - 1] : null;
    case "median": {
      const nums = values.map((v) => typeof v === "number" ? v : Number.parseFloat(String(v))).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
      if (nums.length === 0)
        return null;
      const mid = Math.floor(nums.length / 2);
      if (nums.length % 2 === 0) {
        return (nums[mid - 1] + nums[mid]) / 2;
      }
      return nums[mid];
    }
    case "mode": {
      const counts = /* @__PURE__ */ new Map();
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
__name(computeAgg, "computeAgg");
function buildAggRow(data, specs, evalOptions = {}) {
  const row = {};
  for (const spec of specs) {
    row[spec.alias] = computeAgg(data, spec, evalOptions);
  }
  return row;
}
__name(buildAggRow, "buildAggRow");

// dist/commands/xan/xan-agg.js
async function cmdAgg(args, ctx) {
  let expr = "";
  const fileArgs = [];
  for (const arg of args) {
    if (!arg.startsWith("-")) {
      if (!expr) {
        expr = arg;
      } else {
        fileArgs.push(arg);
      }
    }
  }
  if (!expr) {
    return {
      stdout: "",
      stderr: "xan agg: no aggregation expression\n",
      exitCode: 1
    };
  }
  const { data, error } = await readCsvInput(fileArgs, ctx);
  if (error)
    return error;
  const evalOptions = {
    limits: ctx.limits ? { maxIterations: ctx.limits.maxJqIterations } : void 0
  };
  const specs = parseAggExpr(expr);
  const headers = specs.map((s) => s.alias);
  const row = buildAggRow(data, specs, evalOptions);
  return { stdout: formatCsv(headers, [row]), stderr: "", exitCode: 0 };
}
__name(cmdAgg, "cmdAgg");
async function cmdGroupby(args, ctx) {
  let groupCols = "";
  let aggExpr = "";
  const fileArgs = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--sorted") {
    } else if (!arg.startsWith("-")) {
      if (!groupCols) {
        groupCols = arg;
      } else if (!aggExpr) {
        aggExpr = arg;
      } else {
        fileArgs.push(arg);
      }
    }
  }
  if (!groupCols || !aggExpr) {
    return {
      stdout: "",
      stderr: "xan groupby: usage: xan groupby COLS EXPR [FILE]\n",
      exitCode: 1
    };
  }
  const { data, error } = await readCsvInput(fileArgs, ctx);
  if (error)
    return error;
  const evalOptions = {
    limits: ctx.limits ? { maxIterations: ctx.limits.maxJqIterations } : void 0
  };
  const groupKeys = groupCols.split(",");
  const specs = parseAggExpr(aggExpr);
  const groupOrder = [];
  const groups = /* @__PURE__ */ new Map();
  for (const row of data) {
    const key = groupKeys.map((k) => String(row[k])).join("\0");
    if (!groups.has(key)) {
      groups.set(key, []);
      groupOrder.push(key);
    }
    groups.get(key)?.push(row);
  }
  const headers = [...groupKeys, ...specs.map((s) => s.alias)];
  const results = [];
  for (const key of groupOrder) {
    const groupData = groups.get(key);
    if (!groupData)
      continue;
    const row = {};
    for (const k of groupKeys) {
      row[k] = groupData[0][k];
    }
    for (const spec of specs) {
      row[spec.alias] = computeAgg(groupData, spec, evalOptions);
    }
    results.push(row);
  }
  return { stdout: formatCsv(headers, results), stderr: "", exitCode: 0 };
}
__name(cmdGroupby, "cmdGroupby");
async function cmdFrequency(args, ctx) {
  let selectCols = [];
  let groupCol = "";
  let limit = 10;
  let noExtra = false;
  const fileArgs = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "-s" || arg === "--select") && i + 1 < args.length) {
      selectCols = args[++i].split(",");
    } else if ((arg === "-g" || arg === "--groupby") && i + 1 < args.length) {
      groupCol = args[++i];
    } else if ((arg === "-l" || arg === "--limit") && i + 1 < args.length) {
      limit = Number.parseInt(args[++i], 10);
    } else if (arg === "--no-extra") {
      noExtra = true;
    } else if (arg === "-A" || arg === "--all") {
      limit = 0;
    } else if (!arg.startsWith("-")) {
      fileArgs.push(arg);
    }
  }
  const { headers, data, error } = await readCsvInput(fileArgs, ctx);
  if (error)
    return error;
  let targetCols = selectCols.length > 0 ? selectCols : headers.filter((h) => h !== groupCol);
  if (groupCol && selectCols.length === 0) {
    targetCols = headers.filter((h) => h !== groupCol);
  }
  const results = [];
  const resultHeaders = groupCol ? ["field", groupCol, "value", "count"] : ["field", "value", "count"];
  if (groupCol) {
    const groups = /* @__PURE__ */ new Map();
    for (const row of data) {
      const key = String(row[groupCol] ?? "");
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)?.push(row);
    }
    for (const col of targetCols) {
      for (const [groupKey, groupData] of groups) {
        const counts = /* @__PURE__ */ new Map();
        for (const row of groupData) {
          const val = row[col];
          const key = val === "" || val === null || val === void 0 ? "" : String(val);
          counts.set(key, (counts.get(key) || 0) + 1);
        }
        let entries = [...counts.entries()].sort((a, b) => {
          if (b[1] !== a[1])
            return b[1] - a[1];
          return a[0].localeCompare(b[0]);
        });
        if (noExtra) {
          entries = entries.filter(([val]) => val !== "");
        }
        if (limit > 0) {
          entries = entries.slice(0, limit);
        }
        for (const [val, count] of entries) {
          results.push({
            field: col,
            [groupCol]: groupKey,
            value: val === "" ? "<empty>" : val,
            count
          });
        }
      }
    }
  } else {
    for (const col of targetCols) {
      const counts = /* @__PURE__ */ new Map();
      for (const row of data) {
        const val = row[col];
        const key = val === "" || val === null || val === void 0 ? "" : String(val);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      let entries = [...counts.entries()].sort((a, b) => {
        if (b[1] !== a[1])
          return b[1] - a[1];
        return a[0].localeCompare(b[0]);
      });
      if (noExtra) {
        entries = entries.filter(([val]) => val !== "");
      }
      if (limit > 0) {
        entries = entries.slice(0, limit);
      }
      for (const [val, count] of entries) {
        results.push({
          field: col,
          value: val === "" ? "<empty>" : val,
          count
        });
      }
    }
  }
  return { stdout: formatCsv(resultHeaders, results), stderr: "", exitCode: 0 };
}
__name(cmdFrequency, "cmdFrequency");
async function cmdStats(args, ctx) {
  let columns = [];
  const fileArgs = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-s" && i + 1 < args.length) {
      columns = args[++i].split(",");
    } else if (!arg.startsWith("-")) {
      fileArgs.push(arg);
    }
  }
  const { headers, data, error } = await readCsvInput(fileArgs, ctx);
  if (error)
    return error;
  const targetCols = columns.length > 0 ? columns : headers;
  const statsHeaders = ["field", "type", "count", "min", "max", "mean"];
  const results = [];
  for (const col of targetCols) {
    const values = data.map((r) => r[col]).filter((v) => v !== null && v !== void 0);
    const nums = values.map((v) => typeof v === "number" ? v : Number.parseFloat(String(v))).filter((n) => !Number.isNaN(n));
    const isNumeric = nums.length === values.length && nums.length > 0;
    results.push({
      field: col,
      type: isNumeric ? "Number" : "String",
      count: values.length,
      min: isNumeric ? Math.min(...nums) : "",
      max: isNumeric ? Math.max(...nums) : "",
      mean: isNumeric ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length * 1e10) / 1e10 : ""
    });
  }
  return { stdout: formatCsv(statsHeaders, results), stderr: "", exitCode: 0 };
}
__name(cmdStats, "cmdStats");

// dist/commands/xan/column-selection.js
init_moonblade_parser();
function parseMoonbladeExpr(expr) {
  const moonbladeAst = parseMoonblade(expr);
  return moonbladeToJq(moonbladeAst);
}
__name(parseMoonbladeExpr, "parseMoonbladeExpr");
function globToRegex(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const regexStr = escaped.replace(/\*/g, ".*");
  return new RegExp(`^${regexStr}$`);
}
__name(globToRegex, "globToRegex");
function parseColumnSpec(spec, headers) {
  const result = [];
  const excludes = /* @__PURE__ */ new Set();
  for (const part of spec.split(",")) {
    const trimmed = part.trim();
    if (trimmed.startsWith("!")) {
      const toExclude = trimmed.slice(1);
      const excluded = parseColumnSpec(toExclude, headers);
      for (const col of excluded) {
        excludes.add(col);
      }
      continue;
    }
    if (trimmed === "*") {
      for (const h of headers) {
        if (!result.includes(h))
          result.push(h);
      }
      continue;
    }
    if (trimmed.includes("*")) {
      const regex = globToRegex(trimmed);
      for (const h of headers) {
        if (regex.test(h) && !result.includes(h)) {
          result.push(h);
        }
      }
      continue;
    }
    const colRangeMatch = trimmed.match(/^([^:]*):([^:]*)$/);
    if (colRangeMatch && (colRangeMatch[1] || colRangeMatch[2])) {
      const startCol = colRangeMatch[1];
      const endCol = colRangeMatch[2];
      const startIdx = startCol ? headers.indexOf(startCol) : 0;
      const endIdx = endCol ? headers.indexOf(endCol) : headers.length - 1;
      if (startIdx !== -1 && endIdx !== -1) {
        const step = startIdx <= endIdx ? 1 : -1;
        for (let i = startIdx; step > 0 ? i <= endIdx : i >= endIdx; i += step) {
          if (!result.includes(headers[i])) {
            result.push(headers[i]);
          }
        }
      }
      continue;
    }
    const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = Number.parseInt(rangeMatch[1], 10);
      const end = Number.parseInt(rangeMatch[2], 10);
      for (let i = start; i <= end && i < headers.length; i++) {
        result.push(headers[i]);
      }
      continue;
    }
    const idx = Number.parseInt(trimmed, 10);
    if (!Number.isNaN(idx) && idx >= 0 && idx < headers.length) {
      result.push(headers[idx]);
      continue;
    }
    if (headers.includes(trimmed)) {
      result.push(trimmed);
    }
  }
  if (excludes.size > 0) {
    return result.filter((col) => !excludes.has(col));
  }
  return result;
}
__name(parseColumnSpec, "parseColumnSpec");

// dist/commands/xan/xan-columns.js
async function cmdSelect(args, ctx) {
  let colSpec = "";
  const fileArgs = [];
  for (const arg of args) {
    if (arg.startsWith("-"))
      continue;
    if (!colSpec) {
      colSpec = arg;
    } else {
      fileArgs.push(arg);
    }
  }
  if (!colSpec) {
    return {
      stdout: "",
      stderr: "xan select: no columns specified\n",
      exitCode: 1
    };
  }
  const { headers, data, error } = await readCsvInput(fileArgs, ctx);
  if (error)
    return error;
  const newHeaders = parseColumnSpec(colSpec, headers);
  const newData = data.map((row) => {
    const newRow = {};
    for (const col of newHeaders) {
      newRow[col] = row[col];
    }
    return newRow;
  });
  return { stdout: formatCsv(newHeaders, newData), stderr: "", exitCode: 0 };
}
__name(cmdSelect, "cmdSelect");
async function cmdDrop(args, ctx) {
  let colSpec = "";
  const fileArgs = [];
  for (const arg of args) {
    if (arg.startsWith("-"))
      continue;
    if (!colSpec) {
      colSpec = arg;
    } else {
      fileArgs.push(arg);
    }
  }
  if (!colSpec) {
    return {
      stdout: "",
      stderr: "xan drop: no columns specified\n",
      exitCode: 1
    };
  }
  const { headers, data, error } = await readCsvInput(fileArgs, ctx);
  if (error)
    return error;
  const dropCols = new Set(parseColumnSpec(colSpec, headers));
  const newHeaders = headers.filter((h) => !dropCols.has(h));
  const newData = data.map((row) => {
    const newRow = {};
    for (const col of newHeaders) {
      newRow[col] = row[col];
    }
    return newRow;
  });
  return { stdout: formatCsv(newHeaders, newData), stderr: "", exitCode: 0 };
}
__name(cmdDrop, "cmdDrop");
async function cmdRename(args, ctx) {
  let newNames = "";
  let selectCols = "";
  const fileArgs = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-s" && i + 1 < args.length) {
      selectCols = args[++i];
    } else if (!arg.startsWith("-")) {
      if (!newNames) {
        newNames = arg;
      } else {
        fileArgs.push(arg);
      }
    }
  }
  if (!newNames) {
    return {
      stdout: "",
      stderr: "xan rename: no new name(s) specified\n",
      exitCode: 1
    };
  }
  const { headers, data, error } = await readCsvInput(fileArgs, ctx);
  if (error)
    return error;
  let newHeaders;
  if (selectCols) {
    const oldCols = selectCols.split(",");
    const newNamesList = newNames.split(",");
    const renames = /* @__PURE__ */ new Map();
    for (let i = 0; i < oldCols.length && i < newNamesList.length; i++) {
      renames.set(oldCols[i], newNamesList[i]);
    }
    newHeaders = headers.map((h) => renames.get(h) || h);
  } else {
    const newNamesList = newNames.split(",");
    newHeaders = headers.map((h, i) => i < newNamesList.length ? newNamesList[i] : h);
  }
  const newData = data.map((row) => {
    const newRow = {};
    for (let i = 0; i < headers.length; i++) {
      newRow[newHeaders[i]] = row[headers[i]];
    }
    return newRow;
  });
  return { stdout: formatCsv(newHeaders, newData), stderr: "", exitCode: 0 };
}
__name(cmdRename, "cmdRename");
async function cmdEnum(args, ctx) {
  let colName = "index";
  const filteredArgs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-c" && i + 1 < args.length) {
      colName = args[++i];
    } else {
      filteredArgs.push(args[i]);
    }
  }
  const { headers, data, error } = await readCsvInput(filteredArgs, ctx);
  if (error)
    return error;
  const newHeaders = [colName, ...headers];
  const newData = data.map((row, idx) => {
    const newRow = { [colName]: idx };
    for (const h of headers) {
      newRow[h] = row[h];
    }
    return newRow;
  });
  return { stdout: formatCsv(newHeaders, newData), stderr: "", exitCode: 0 };
}
__name(cmdEnum, "cmdEnum");

// dist/commands/xan/xan-core.js
async function cmdHeaders(args, ctx) {
  const justNames = args.includes("-j") || args.includes("--just-names");
  const { headers, error } = await readCsvInput(args.filter((a) => a !== "-j" && a !== "--just-names"), ctx);
  if (error)
    return error;
  const output = justNames ? `${headers.map((h) => h).join("\n")}
` : `${headers.map((h, i) => `${i}   ${h}`).join("\n")}
`;
  return { stdout: output, stderr: "", exitCode: 0 };
}
__name(cmdHeaders, "cmdHeaders");
async function cmdCount(args, ctx) {
  const { data, error } = await readCsvInput(args, ctx);
  if (error)
    return error;
  return { stdout: `${data.length}
`, stderr: "", exitCode: 0 };
}
__name(cmdCount, "cmdCount");
async function cmdHead(args, ctx) {
  let n = 10;
  const filteredArgs = [];
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "-l" || args[i] === "-n") && i + 1 < args.length) {
      n = Number.parseInt(args[++i], 10);
    } else {
      filteredArgs.push(args[i]);
    }
  }
  const { headers, data, error } = await readCsvInput(filteredArgs, ctx);
  if (error)
    return error;
  const rows = data.slice(0, n);
  return { stdout: formatCsv(headers, rows), stderr: "", exitCode: 0 };
}
__name(cmdHead, "cmdHead");
async function cmdTail(args, ctx) {
  let n = 10;
  const filteredArgs = [];
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "-l" || args[i] === "-n") && i + 1 < args.length) {
      n = Number.parseInt(args[++i], 10);
    } else {
      filteredArgs.push(args[i]);
    }
  }
  const { headers, data, error } = await readCsvInput(filteredArgs, ctx);
  if (error)
    return error;
  const rows = data.slice(-n);
  return { stdout: formatCsv(headers, rows), stderr: "", exitCode: 0 };
}
__name(cmdTail, "cmdTail");
async function cmdSlice(args, ctx) {
  let start;
  let end;
  let len;
  const fileArgs = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "-s" || arg === "--start") && i + 1 < args.length) {
      start = Number.parseInt(args[++i], 10);
    } else if ((arg === "-e" || arg === "--end") && i + 1 < args.length) {
      end = Number.parseInt(args[++i], 10);
    } else if ((arg === "-l" || arg === "--len") && i + 1 < args.length) {
      len = Number.parseInt(args[++i], 10);
    } else if (!arg.startsWith("-")) {
      fileArgs.push(arg);
    }
  }
  const { headers, data, error } = await readCsvInput(fileArgs, ctx);
  if (error)
    return error;
  const startIdx = start ?? 0;
  let endIdx;
  if (len !== void 0) {
    endIdx = startIdx + len;
  } else if (end !== void 0) {
    endIdx = end;
  } else {
    endIdx = data.length;
  }
  const rows = data.slice(startIdx, endIdx);
  return { stdout: formatCsv(headers, rows), stderr: "", exitCode: 0 };
}
__name(cmdSlice, "cmdSlice");
async function cmdReverse(args, ctx) {
  const { headers, data, error } = await readCsvInput(args, ctx);
  if (error)
    return error;
  const rows = [...data].reverse();
  return { stdout: formatCsv(headers, rows), stderr: "", exitCode: 0 };
}
__name(cmdReverse, "cmdReverse");

// dist/commands/xan/xan-data.js
var import_papaparse = __toESM(require_papaparse(), 1);
async function cmdTranspose(args, ctx) {
  const fileArgs = args.filter((a) => !a.startsWith("-"));
  const { headers, data, error } = await readCsvInput(fileArgs, ctx);
  if (error)
    return error;
  if (data.length === 0) {
    const newHeaders2 = ["column"];
    const newData2 = headers.map((h) => ({ column: h }));
    return { stdout: formatCsv(newHeaders2, newData2), stderr: "", exitCode: 0 };
  }
  const firstCol = headers[0];
  const newHeaders = [
    firstCol,
    ...data.map((row, i) => String(row[firstCol] ?? `row_${i}`))
  ];
  const newData = [];
  for (let i = 1; i < headers.length; i++) {
    const col = headers[i];
    const newRow = { [firstCol]: col };
    for (let j = 0; j < data.length; j++) {
      newRow[newHeaders[j + 1]] = data[j][col];
    }
    newData.push(newRow);
  }
  return { stdout: formatCsv(newHeaders, newData), stderr: "", exitCode: 0 };
}
__name(cmdTranspose, "cmdTranspose");
async function cmdShuffle(args, ctx) {
  let seed = null;
  const fileArgs = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--seed" && i + 1 < args.length) {
      seed = Number.parseInt(args[++i], 10);
    } else if (!arg.startsWith("-")) {
      fileArgs.push(arg);
    }
  }
  const { headers, data, error } = await readCsvInput(fileArgs, ctx);
  if (error)
    return error;
  let rng = seed !== null ? seed : Date.now();
  const random = /* @__PURE__ */ __name(() => {
    rng = rng * 1103515245 + 12345 & 2147483647;
    return rng / 2147483647;
  }, "random");
  const shuffled = [...data];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return { stdout: formatCsv(headers, shuffled), stderr: "", exitCode: 0 };
}
__name(cmdShuffle, "cmdShuffle");
async function cmdFixlengths(args, ctx) {
  let targetLen = null;
  let defaultValue = "";
  const fileArgs = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "-l" || arg === "--length") && i + 1 < args.length) {
      targetLen = Number.parseInt(args[++i], 10);
    } else if ((arg === "-d" || arg === "--default") && i + 1 < args.length) {
      defaultValue = args[++i];
    } else if (!arg.startsWith("-")) {
      fileArgs.push(arg);
    }
  }
  const file = fileArgs[0];
  let input;
  if (!file || file === "-") {
    input = ctx.stdin;
  } else {
    try {
      const path = ctx.fs.resolvePath(ctx.cwd, file);
      input = await ctx.fs.readFile(path);
    } catch {
      return {
        stdout: "",
        stderr: `xan fixlengths: ${file}: No such file or directory
`,
        exitCode: 1
      };
    }
  }
  const result = import_papaparse.default.parse(input.trim(), {
    header: false,
    skipEmptyLines: true
  });
  const rows = result.data;
  if (rows.length === 0) {
    return { stdout: "", stderr: "", exitCode: 0 };
  }
  const maxLen = Math.max(...rows.map((r) => r.length));
  const len = targetLen ?? maxLen;
  const fixed = rows.map((row) => {
    if (row.length === len)
      return row;
    if (row.length < len) {
      return [...row, ...Array(len - row.length).fill(defaultValue)];
    }
    return row.slice(0, len);
  });
  const output = import_papaparse.default.unparse(fixed);
  return {
    stdout: `${output.replace(/\r\n/g, "\n")}
`,
    stderr: "",
    exitCode: 0
  };
}
__name(cmdFixlengths, "cmdFixlengths");
async function cmdSplit(args, ctx) {
  let numParts = null;
  let partSize = null;
  let outputDir = ".";
  const fileArgs = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "-c" || arg === "--chunks") && i + 1 < args.length) {
      numParts = Number.parseInt(args[++i], 10);
    } else if ((arg === "-S" || arg === "--size") && i + 1 < args.length) {
      partSize = Number.parseInt(args[++i], 10);
    } else if ((arg === "-o" || arg === "--output") && i + 1 < args.length) {
      outputDir = args[++i];
    } else if (!arg.startsWith("-")) {
      fileArgs.push(arg);
    }
  }
  if (!numParts && !partSize) {
    return {
      stdout: "",
      stderr: "xan split: must specify -c or -S\n",
      exitCode: 1
    };
  }
  const { headers, data, error } = await readCsvInput(fileArgs, ctx);
  if (error)
    return error;
  const parts = [];
  if (numParts) {
    const size = Math.ceil(data.length / numParts);
    for (let i = 0; i < numParts; i++) {
      parts.push(data.slice(i * size, (i + 1) * size));
    }
  } else if (partSize) {
    for (let i = 0; i < data.length; i += partSize) {
      parts.push(data.slice(i, i + partSize));
    }
  }
  const nonEmptyParts = parts.filter((p) => p.length > 0);
  const baseName = fileArgs[0]?.replace(/\.csv$/, "") || "part";
  try {
    const outPath = ctx.fs.resolvePath(ctx.cwd, outputDir);
    for (let i = 0; i < nonEmptyParts.length; i++) {
      const fileName = `${baseName}_${String(i + 1).padStart(3, "0")}.csv`;
      const filePath = ctx.fs.resolvePath(outPath, fileName);
      await ctx.fs.writeFile(filePath, formatCsv(headers, nonEmptyParts[i]));
    }
    return {
      stdout: `Split into ${nonEmptyParts.length} parts
`,
      stderr: "",
      exitCode: 0
    };
  } catch {
    const output = nonEmptyParts.map((p, i) => `Part ${i + 1}: ${p.length} rows`).join("\n");
    return { stdout: `${output}
`, stderr: "", exitCode: 0 };
  }
}
__name(cmdSplit, "cmdSplit");
async function cmdPartition(args, ctx) {
  let column = "";
  let outputDir = ".";
  const fileArgs = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "-o" || arg === "--output") && i + 1 < args.length) {
      outputDir = args[++i];
    } else if (!arg.startsWith("-")) {
      if (!column) {
        column = arg;
      } else {
        fileArgs.push(arg);
      }
    }
  }
  if (!column) {
    return {
      stdout: "",
      stderr: "xan partition: usage: xan partition COLUMN [FILE]\n",
      exitCode: 1
    };
  }
  const { headers, data, error } = await readCsvInput(fileArgs, ctx);
  if (error)
    return error;
  if (!headers.includes(column)) {
    return {
      stdout: "",
      stderr: `xan partition: column '${column}' not found
`,
      exitCode: 1
    };
  }
  const groups = /* @__PURE__ */ new Map();
  for (const row of data) {
    const val = String(row[column] ?? "");
    if (!groups.has(val)) {
      groups.set(val, []);
    }
    groups.get(val)?.push(row);
  }
  try {
    const outPath = ctx.fs.resolvePath(ctx.cwd, outputDir);
    for (const [val, rows] of groups) {
      const safeVal = val.replace(/[^a-zA-Z0-9_-]/g, "_") || "empty";
      const fileName = `${safeVal}.csv`;
      const filePath = ctx.fs.resolvePath(outPath, fileName);
      await ctx.fs.writeFile(filePath, formatCsv(headers, rows));
    }
    return {
      stdout: `Partitioned into ${groups.size} files by '${column}'
`,
      stderr: "",
      exitCode: 0
    };
  } catch {
    const output = Array.from(groups.entries()).map(([val, rows]) => `${val}: ${rows.length} rows`).join("\n");
    return { stdout: `${output}
`, stderr: "", exitCode: 0 };
  }
}
__name(cmdPartition, "cmdPartition");
async function cmdTo(args, ctx) {
  if (args.length === 0) {
    return {
      stdout: "",
      stderr: "xan to: usage: xan to <format> [FILE]\n",
      exitCode: 1
    };
  }
  const format = args[0];
  const subArgs = args.slice(1);
  if (format === "json") {
    return cmdToJson(subArgs, ctx);
  }
  return {
    stdout: "",
    stderr: `xan to: unsupported format '${format}'
`,
    exitCode: 1
  };
}
__name(cmdTo, "cmdTo");
async function cmdToJson(args, ctx) {
  const fileArgs = args.filter((a) => !a.startsWith("-"));
  const { data, error } = await readCsvInput(fileArgs, ctx);
  if (error)
    return error;
  const json = JSON.stringify(data, null, 2);
  return { stdout: `${json}
`, stderr: "", exitCode: 0 };
}
__name(cmdToJson, "cmdToJson");
async function cmdFrom(args, ctx) {
  let format = "";
  const fileArgs = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "-f" || arg === "--format") && i + 1 < args.length) {
      format = args[++i];
    } else if (!arg.startsWith("-")) {
      fileArgs.push(arg);
    }
  }
  if (!format) {
    return {
      stdout: "",
      stderr: "xan from: usage: xan from -f <format> [FILE]\n",
      exitCode: 1
    };
  }
  if (format === "json") {
    return cmdFromJson(fileArgs, ctx);
  }
  return {
    stdout: "",
    stderr: `xan from: unsupported format '${format}'
`,
    exitCode: 1
  };
}
__name(cmdFrom, "cmdFrom");
async function cmdFromJson(fileArgs, ctx) {
  const file = fileArgs[0];
  let input;
  if (!file || file === "-") {
    input = ctx.stdin;
  } else {
    try {
      const path = ctx.fs.resolvePath(ctx.cwd, file);
      input = await ctx.fs.readFile(path);
    } catch {
      return {
        stdout: "",
        stderr: `xan from: ${file}: No such file or directory
`,
        exitCode: 1
      };
    }
  }
  try {
    const data = JSON.parse(input.trim());
    if (!Array.isArray(data)) {
      return {
        stdout: "",
        stderr: "xan from: JSON input must be an array\n",
        exitCode: 1
      };
    }
    if (data.length === 0) {
      return { stdout: "\n", stderr: "", exitCode: 0 };
    }
    if (Array.isArray(data[0])) {
      const [headers2, ...rows] = data;
      const csvData = rows.map((row) => {
        const obj = {};
        for (let i = 0; i < headers2.length; i++) {
          obj[headers2[i]] = row[i];
        }
        return obj;
      });
      return {
        stdout: formatCsv(headers2, csvData),
        stderr: "",
        exitCode: 0
      };
    }
    const headers = Object.keys(data[0]).sort();
    return {
      stdout: formatCsv(headers, data),
      stderr: "",
      exitCode: 0
    };
  } catch {
    return {
      stdout: "",
      stderr: "xan from: invalid JSON input\n",
      exitCode: 1
    };
  }
}
__name(cmdFromJson, "cmdFromJson");

// dist/commands/xan/xan-filter.js
async function cmdFilter(args, ctx) {
  let invert = false;
  let limit = 0;
  let expr = "";
  const fileArgs = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-v" || arg === "--invert") {
      invert = true;
    } else if ((arg === "-l" || arg === "--limit") && i + 1 < args.length) {
      limit = Number.parseInt(args[++i], 10);
    } else if (arg === "--help") {
      return showHelp({
        name: "xan filter",
        summary: "Filter rows by expression",
        usage: "xan filter [OPTIONS] EXPR [FILE]",
        description: "Filter CSV rows using moonblade expressions.",
        options: [
          "-v, --invert    invert match",
          "-l, --limit N   limit output to N rows",
          "    --help      display help"
        ]
      });
    } else if (!arg.startsWith("-")) {
      if (!expr) {
        expr = arg;
      } else {
        fileArgs.push(arg);
      }
    }
  }
  if (!expr) {
    return {
      stdout: "",
      stderr: "xan filter: no expression specified\n",
      exitCode: 1
    };
  }
  const { headers, data, error } = await readCsvInput(fileArgs, ctx);
  if (error)
    return error;
  const evalOptions = {
    limits: ctx.limits ? { maxIterations: ctx.limits.maxJqIterations } : void 0
  };
  const ast = parseMoonbladeExpr(expr);
  const filtered = [];
  for (const row of data) {
    if (limit > 0 && filtered.length >= limit)
      break;
    const results = evaluate(row, ast, evalOptions);
    const matches = results.length > 0 && results.some((r) => !!r);
    if (invert ? !matches : matches) {
      filtered.push(row);
    }
  }
  return { stdout: formatCsv(headers, filtered), stderr: "", exitCode: 0 };
}
__name(cmdFilter, "cmdFilter");
async function cmdSort(args, ctx) {
  let column = "";
  let numeric = false;
  let reverse = false;
  const fileArgs = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-N" || arg === "--numeric") {
      numeric = true;
    } else if (arg === "-R" || arg === "-r" || arg === "--reverse") {
      reverse = true;
    } else if (arg === "-s" && i + 1 < args.length) {
      column = args[++i];
    } else if (!arg.startsWith("-")) {
      fileArgs.push(arg);
    }
  }
  const { headers, data, error } = await readCsvInput(fileArgs, ctx);
  if (error)
    return error;
  if (!column && headers.length > 0) {
    column = headers[0];
  }
  const sorted = [...data].sort((a, b) => {
    const va = a[column];
    const vb = b[column];
    let cmp;
    if (numeric) {
      const na = typeof va === "number" ? va : Number.parseFloat(String(va));
      const nb = typeof vb === "number" ? vb : Number.parseFloat(String(vb));
      cmp = na - nb;
    } else {
      cmp = String(va).localeCompare(String(vb));
    }
    return reverse ? -cmp : cmp;
  });
  return { stdout: formatCsv(headers, sorted), stderr: "", exitCode: 0 };
}
__name(cmdSort, "cmdSort");
async function cmdDedup(args, ctx) {
  let column = "";
  const fileArgs = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-s" && i + 1 < args.length) {
      column = args[++i];
    } else if (!arg.startsWith("-")) {
      fileArgs.push(arg);
    }
  }
  const { headers, data, error } = await readCsvInput(fileArgs, ctx);
  if (error)
    return error;
  const seen = /* @__PURE__ */ new Set();
  const deduped = data.filter((row) => {
    const key = column ? String(row[column]) : JSON.stringify(row);
    if (seen.has(key))
      return false;
    seen.add(key);
    return true;
  });
  return { stdout: formatCsv(headers, deduped), stderr: "", exitCode: 0 };
}
__name(cmdDedup, "cmdDedup");
async function cmdTop(args, ctx) {
  let n = 10;
  let column = "";
  let reverse = false;
  const fileArgs = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "-l" || arg === "-n") && i + 1 < args.length) {
      n = Number.parseInt(args[++i], 10);
    } else if (arg === "-R" || arg === "-r" || arg === "--reverse") {
      reverse = true;
    } else if (!arg.startsWith("-")) {
      if (!column) {
        column = arg;
      } else {
        fileArgs.push(arg);
      }
    }
  }
  const { headers, data, error } = await readCsvInput(fileArgs, ctx);
  if (error)
    return error;
  if (!column && headers.length > 0) {
    column = headers[0];
  }
  const sorted = [...data].sort((a, b) => {
    const va = a[column];
    const vb = b[column];
    const na = typeof va === "number" ? va : Number.parseFloat(String(va));
    const nb = typeof vb === "number" ? vb : Number.parseFloat(String(vb));
    return reverse ? na - nb : nb - na;
  });
  const rows = sorted.slice(0, n);
  return { stdout: formatCsv(headers, rows), stderr: "", exitCode: 0 };
}
__name(cmdTop, "cmdTop");

// dist/commands/xan/xan-map.js
init_moonblade_parser();
async function cmdMap(args, ctx) {
  let mapExpr = "";
  let overwrite = false;
  let filter = false;
  const fileArgs = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-O" || arg === "--overwrite") {
      overwrite = true;
    } else if (arg === "--filter") {
      filter = true;
    } else if (!arg.startsWith("-")) {
      if (!mapExpr) {
        mapExpr = arg;
      } else {
        fileArgs.push(arg);
      }
    }
  }
  if (!mapExpr) {
    return {
      stdout: "",
      stderr: "xan map: no expression specified\n",
      exitCode: 1
    };
  }
  const { headers, data, error } = await readCsvInput(fileArgs, ctx);
  if (error)
    return error;
  const namedExprs = parseNamedExpressions(mapExpr);
  const specs = namedExprs.map(({ expr, name }) => ({
    alias: typeof name === "string" ? name : name[0],
    ast: moonbladeToJq(expr)
  }));
  const evalOptions = {
    limits: ctx.limits ? { maxIterations: ctx.limits.maxJqIterations } : void 0
  };
  let newHeaders;
  if (overwrite) {
    newHeaders = [...headers];
    for (const spec of specs) {
      if (!headers.includes(spec.alias)) {
        newHeaders.push(spec.alias);
      }
    }
  } else {
    newHeaders = [...headers, ...specs.map((s) => s.alias)];
  }
  const newData = [];
  for (let rowIndex = 0; rowIndex < data.length; rowIndex++) {
    const row = data[rowIndex];
    const newRow = { ...row };
    let skip = false;
    const rowWithIndex = { ...row, _row_index: rowIndex };
    for (const spec of specs) {
      const results = evaluate(rowWithIndex, spec.ast, evalOptions);
      const value = results.length > 0 ? results[0] : null;
      if (filter && (value === null || value === void 0)) {
        skip = true;
        break;
      }
      newRow[spec.alias] = value;
    }
    if (!skip) {
      newData.push(newRow);
    }
  }
  return { stdout: formatCsv(newHeaders, newData), stderr: "", exitCode: 0 };
}
__name(cmdMap, "cmdMap");
async function cmdTransform(args, ctx) {
  let targetCol = "";
  let transformExpr = "";
  let rename = "";
  const fileArgs = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "-r" || arg === "--rename") && i + 1 < args.length) {
      rename = args[++i];
    } else if (!arg.startsWith("-")) {
      if (!targetCol) {
        targetCol = arg;
      } else if (!transformExpr) {
        transformExpr = arg;
      } else {
        fileArgs.push(arg);
      }
    }
  }
  if (!targetCol || !transformExpr) {
    return {
      stdout: "",
      stderr: "xan transform: usage: xan transform COLUMN EXPR [FILE]\n",
      exitCode: 1
    };
  }
  const { headers, data, error } = await readCsvInput(fileArgs, ctx);
  if (error)
    return error;
  const targetCols = targetCol.split(",").map((c) => c.trim());
  const renameCols = rename ? rename.split(",").map((c) => c.trim()) : [];
  for (const col of targetCols) {
    if (!headers.includes(col)) {
      return {
        stdout: "",
        stderr: `xan transform: column '${col}' not found
`,
        exitCode: 1
      };
    }
  }
  const ast = moonbladeToJq(parseNamedExpressions(transformExpr)[0]?.expr || (init_moonblade_parser(), __toCommonJS(moonblade_parser_exports)).parseMoonblade(transformExpr));
  const evalOptions = {
    limits: ctx.limits ? { maxIterations: ctx.limits.maxJqIterations } : void 0
  };
  const newHeaders = headers.map((h) => {
    const idx = targetCols.indexOf(h);
    if (idx !== -1 && renameCols[idx]) {
      return renameCols[idx];
    }
    return h;
  });
  const newData = [];
  for (const row of data) {
    const newRow = { ...row };
    for (let i = 0; i < targetCols.length; i++) {
      const col = targetCols[i];
      const rowWithUnderscore = { ...row, _: row[col] };
      const results = evaluate(rowWithUnderscore, ast, evalOptions);
      const value = results.length > 0 ? results[0] : null;
      const newColName = renameCols[i] || col;
      if (newColName !== col) {
        delete newRow[col];
      }
      newRow[newColName] = value;
    }
    newData.push(newRow);
  }
  return { stdout: formatCsv(newHeaders, newData), stderr: "", exitCode: 0 };
}
__name(cmdTransform, "cmdTransform");

// dist/commands/xan/xan-reshape.js
async function cmdExplode(args, ctx) {
  let column = "";
  let separator = "|";
  let dropEmpty = false;
  let rename = "";
  const fileArgs = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "-s" || arg === "--separator") && i + 1 < args.length) {
      separator = args[++i];
    } else if (arg === "--drop-empty") {
      dropEmpty = true;
    } else if ((arg === "-r" || arg === "--rename") && i + 1 < args.length) {
      rename = args[++i];
    } else if (!arg.startsWith("-")) {
      if (!column) {
        column = arg;
      } else {
        fileArgs.push(arg);
      }
    }
  }
  if (!column) {
    return {
      stdout: "",
      stderr: "xan explode: usage: xan explode COLUMN [FILE]\n",
      exitCode: 1
    };
  }
  const { headers, data, error } = await readCsvInput(fileArgs, ctx);
  if (error)
    return error;
  if (!headers.includes(column)) {
    return {
      stdout: "",
      stderr: `xan explode: column '${column}' not found
`,
      exitCode: 1
    };
  }
  const newHeaders = rename ? headers.map((h) => h === column ? rename : h) : headers;
  const targetCol = rename || column;
  const newData = [];
  for (const row of data) {
    const value = row[column];
    const strValue = value === null || value === void 0 ? "" : String(value);
    if (strValue === "") {
      if (!dropEmpty) {
        const newRow = { ...row };
        if (rename) {
          delete newRow[column];
          newRow[targetCol] = "";
        }
        newData.push(newRow);
      }
    } else {
      const parts = strValue.split(separator);
      for (const part of parts) {
        const newRow = { ...row };
        if (rename) {
          delete newRow[column];
        }
        newRow[targetCol] = part;
        newData.push(newRow);
      }
    }
  }
  return { stdout: formatCsv(newHeaders, newData), stderr: "", exitCode: 0 };
}
__name(cmdExplode, "cmdExplode");
async function cmdImplode(args, ctx) {
  let column = "";
  let separator = "|";
  let rename = "";
  const fileArgs = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "-s" || arg === "--sep") && i + 1 < args.length) {
      separator = args[++i];
    } else if ((arg === "-r" || arg === "--rename") && i + 1 < args.length) {
      rename = args[++i];
    } else if (!arg.startsWith("-")) {
      if (!column) {
        column = arg;
      } else {
        fileArgs.push(arg);
      }
    }
  }
  if (!column) {
    return {
      stdout: "",
      stderr: "xan implode: usage: xan implode COLUMN [FILE]\n",
      exitCode: 1
    };
  }
  const { headers, data, error } = await readCsvInput(fileArgs, ctx);
  if (error)
    return error;
  if (!headers.includes(column)) {
    return {
      stdout: "",
      stderr: `xan implode: column '${column}' not found
`,
      exitCode: 1
    };
  }
  const keyCols = headers.filter((h) => h !== column);
  const newHeaders = rename ? headers.map((h) => h === column ? rename : h) : headers;
  const targetCol = rename || column;
  const newData = [];
  let currentKey = null;
  let currentValues = [];
  let currentRow = null;
  for (const row of data) {
    const key = keyCols.map((k) => String(row[k] ?? "")).join("\0");
    const value = row[column];
    const strValue = value === null || value === void 0 ? "" : String(value);
    if (key !== currentKey) {
      if (currentRow !== null) {
        const newRow = { ...currentRow };
        if (rename) {
          delete newRow[column];
        }
        newRow[targetCol] = currentValues.join(separator);
        newData.push(newRow);
      }
      currentKey = key;
      currentValues = [strValue];
      currentRow = row;
    } else {
      currentValues.push(strValue);
    }
  }
  if (currentRow !== null) {
    const newRow = { ...currentRow };
    if (rename) {
      delete newRow[column];
    }
    newRow[targetCol] = currentValues.join(separator);
    newData.push(newRow);
  }
  return { stdout: formatCsv(newHeaders, newData), stderr: "", exitCode: 0 };
}
__name(cmdImplode, "cmdImplode");
async function cmdJoin(args, ctx) {
  let key1 = "";
  let file1 = "";
  let key2 = "";
  let file2 = "";
  let joinType = "inner";
  let defaultValue = "";
  let positionalCount = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--left") {
      joinType = "left";
    } else if (arg === "--right") {
      joinType = "right";
    } else if (arg === "--full") {
      joinType = "full";
    } else if ((arg === "-D" || arg === "--default") && i + 1 < args.length) {
      defaultValue = args[++i];
    } else if (!arg.startsWith("-")) {
      positionalCount++;
      if (positionalCount === 1)
        key1 = arg;
      else if (positionalCount === 2)
        file1 = arg;
      else if (positionalCount === 3)
        key2 = arg;
      else if (positionalCount === 4)
        file2 = arg;
    }
  }
  if (!key1 || !file1 || !key2 || !file2) {
    return {
      stdout: "",
      stderr: "xan join: usage: xan join KEY1 FILE1 KEY2 FILE2 [OPTIONS]\n",
      exitCode: 1
    };
  }
  const result1 = await readCsvInput([file1], ctx);
  if (result1.error)
    return result1.error;
  const result2 = await readCsvInput([file2], ctx);
  if (result2.error)
    return result2.error;
  const { headers: headers1, data: data1 } = result1;
  const { headers: headers2, data: data2 } = result2;
  if (!headers1.includes(key1)) {
    return {
      stdout: "",
      stderr: `xan join: column '${key1}' not found in first file
`,
      exitCode: 1
    };
  }
  if (!headers2.includes(key2)) {
    return {
      stdout: "",
      stderr: `xan join: column '${key2}' not found in second file
`,
      exitCode: 1
    };
  }
  const index2 = /* @__PURE__ */ new Map();
  for (const row of data2) {
    const keyVal = String(row[key2] ?? "");
    if (!index2.has(keyVal)) {
      index2.set(keyVal, []);
    }
    index2.get(keyVal)?.push(row);
  }
  const headers1Set = new Set(headers1);
  const headers2Unique = headers2.filter((h) => !headers1Set.has(h));
  const newHeaders = [...headers1, ...headers2Unique];
  const newData = [];
  const matched2Keys = /* @__PURE__ */ new Set();
  for (const row1 of data1) {
    const keyVal = String(row1[key1] ?? "");
    const matches = index2.get(keyVal);
    if (matches && matches.length > 0) {
      matched2Keys.add(keyVal);
      for (const row2 of matches) {
        const newRow = {};
        for (const h of headers1) {
          newRow[h] = row1[h];
        }
        for (const h of headers2Unique) {
          newRow[h] = row2[h];
        }
        newData.push(newRow);
      }
    } else if (joinType === "left" || joinType === "full") {
      const newRow = {};
      for (const h of headers1) {
        newRow[h] = row1[h];
      }
      for (const h of headers2Unique) {
        newRow[h] = defaultValue;
      }
      newData.push(newRow);
    }
  }
  if (joinType === "right" || joinType === "full") {
    for (const row2 of data2) {
      const keyVal = String(row2[key2] ?? "");
      if (!matched2Keys.has(keyVal)) {
        const newRow = {};
        for (const h of headers1) {
          newRow[h] = headers2.includes(h) ? row2[h] : defaultValue;
        }
        for (const h of headers2Unique) {
          newRow[h] = row2[h];
        }
        newData.push(newRow);
      }
    }
  }
  return { stdout: formatCsv(newHeaders, newData), stderr: "", exitCode: 0 };
}
__name(cmdJoin, "cmdJoin");
async function cmdPivot(args, ctx) {
  let pivotCol = "";
  let aggExpr = "";
  let groupCols = [];
  const fileArgs = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "-g" || arg === "--groupby") && i + 1 < args.length) {
      groupCols = args[++i].split(",").map((s) => s.trim());
    } else if (!arg.startsWith("-")) {
      if (!pivotCol) {
        pivotCol = arg;
      } else if (!aggExpr) {
        aggExpr = arg;
      } else {
        fileArgs.push(arg);
      }
    }
  }
  if (!pivotCol || !aggExpr) {
    return {
      stdout: "",
      stderr: "xan pivot: usage: xan pivot COLUMN AGG_EXPR [OPTIONS] [FILE]\n",
      exitCode: 1
    };
  }
  const { headers, data, error } = await readCsvInput(fileArgs, ctx);
  if (error)
    return error;
  if (!headers.includes(pivotCol)) {
    return {
      stdout: "",
      stderr: `xan pivot: column '${pivotCol}' not found
`,
      exitCode: 1
    };
  }
  const aggMatch = aggExpr.match(/^(\w+)\((\w+)\)$/);
  if (!aggMatch) {
    return {
      stdout: "",
      stderr: `xan pivot: invalid aggregation expression '${aggExpr}'
`,
      exitCode: 1
    };
  }
  const [, aggFunc, aggCol] = aggMatch;
  if (groupCols.length === 0) {
    groupCols = headers.filter((h) => h !== pivotCol && h !== aggCol);
  }
  const pivotValues = [];
  for (const row of data) {
    const val = String(row[pivotCol] ?? "");
    if (!pivotValues.includes(val)) {
      pivotValues.push(val);
    }
  }
  const groups = /* @__PURE__ */ new Map();
  const groupOrder = [];
  for (const row of data) {
    const groupKey = groupCols.map((c) => String(row[c] ?? "")).join("\0");
    const pivotVal = String(row[pivotCol] ?? "");
    const aggVal = row[aggCol];
    if (!groups.has(groupKey)) {
      groups.set(groupKey, /* @__PURE__ */ new Map());
      groupOrder.push(groupKey);
    }
    const group = groups.get(groupKey);
    if (!group)
      continue;
    if (!group.has(pivotVal)) {
      group.set(pivotVal, []);
    }
    group.get(pivotVal)?.push(aggVal);
  }
  const newHeaders = [...groupCols, ...pivotValues];
  const newData = [];
  for (const groupKey of groupOrder) {
    const groupKeyParts = groupKey.split("\0");
    const group = groups.get(groupKey);
    if (!group)
      continue;
    const row = {};
    for (let i = 0; i < groupCols.length; i++) {
      row[groupCols[i]] = groupKeyParts[i];
    }
    for (const pivotVal of pivotValues) {
      const values = group.get(pivotVal) || [];
      row[pivotVal] = computeSimpleAgg(aggFunc, values);
    }
    newData.push(row);
  }
  return { stdout: formatCsv(newHeaders, newData), stderr: "", exitCode: 0 };
}
__name(cmdPivot, "cmdPivot");
function computeSimpleAgg(func, values) {
  const nums = values.filter((v) => v !== null && v !== void 0).map((v) => typeof v === "number" ? v : Number.parseFloat(String(v))).filter((n) => !Number.isNaN(n));
  switch (func) {
    case "count":
      return values.length;
    case "sum":
      return nums.reduce((a, b) => a + b, 0);
    case "mean":
    case "avg":
      return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
    case "min":
      return nums.length > 0 ? Math.min(...nums) : null;
    case "max":
      return nums.length > 0 ? Math.max(...nums) : null;
    case "first":
      return values.length > 0 ? String(values[0] ?? "") : null;
    case "last":
      return values.length > 0 ? String(values[values.length - 1] ?? "") : null;
    default:
      return null;
  }
}
__name(computeSimpleAgg, "computeSimpleAgg");
async function cmdMerge(args, ctx) {
  let sortCol = "";
  const fileArgs = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "-s" || arg === "--sort") && i + 1 < args.length) {
      sortCol = args[++i];
    } else if (!arg.startsWith("-")) {
      fileArgs.push(arg);
    }
  }
  if (fileArgs.length < 2) {
    return {
      stdout: "",
      stderr: "xan merge: usage: xan merge [OPTIONS] FILE1 FILE2 ...\n",
      exitCode: 1
    };
  }
  const allData = [];
  let commonHeaders = null;
  for (const file of fileArgs) {
    const result = await readCsvInput([file], ctx);
    if (result.error)
      return result.error;
    if (commonHeaders === null) {
      commonHeaders = result.headers;
    } else if (JSON.stringify(commonHeaders) !== JSON.stringify(result.headers)) {
      return {
        stdout: "",
        stderr: "xan merge: all files must have the same headers\n",
        exitCode: 1
      };
    }
    allData.push({ headers: result.headers, data: result.data });
  }
  if (!commonHeaders) {
    return { stdout: "", stderr: "", exitCode: 0 };
  }
  let merged = [];
  for (const { data } of allData) {
    merged = merged.concat(data);
  }
  if (sortCol) {
    if (!commonHeaders.includes(sortCol)) {
      return {
        stdout: "",
        stderr: `xan merge: column '${sortCol}' not found
`,
        exitCode: 1
      };
    }
    merged.sort((a, b) => {
      const aVal = a[sortCol];
      const bVal = b[sortCol];
      const aNum = typeof aVal === "number" ? aVal : Number.parseFloat(String(aVal));
      const bNum = typeof bVal === "number" ? bVal : Number.parseFloat(String(bVal));
      if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) {
        return aNum - bNum;
      }
      return String(aVal ?? "").localeCompare(String(bVal ?? ""));
    });
  }
  return { stdout: formatCsv(commonHeaders, merged), stderr: "", exitCode: 0 };
}
__name(cmdMerge, "cmdMerge");

// dist/commands/xan/xan-simple.js
init_moonblade_parser();
async function cmdBehead(args, ctx) {
  const fileArgs = args.filter((a) => !a.startsWith("-"));
  const { headers, data, error } = await readCsvInput(fileArgs, ctx);
  if (error)
    return error;
  if (data.length === 0) {
    return { stdout: "", stderr: "", exitCode: 0 };
  }
  const rows = data.map((row) => headers.map((h) => row[h]));
  const output = rows.map((row) => row.map((v) => formatValue(v)).join(",")).join("\n") + "\n";
  return { stdout: output, stderr: "", exitCode: 0 };
}
__name(cmdBehead, "cmdBehead");
function formatValue(v) {
  if (v === null || v === void 0)
    return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
__name(formatValue, "formatValue");
async function cmdSample(args, ctx) {
  let num = null;
  let seed = null;
  const fileArgs = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--seed" && i + 1 < args.length) {
      seed = Number.parseInt(args[++i], 10);
    } else if (!arg.startsWith("-")) {
      const parsed = Number.parseInt(arg, 10);
      if (num === null && !Number.isNaN(parsed) && parsed > 0) {
        num = parsed;
      } else {
        fileArgs.push(arg);
      }
    }
  }
  if (num === null) {
    return {
      stdout: "",
      stderr: "xan sample: usage: xan sample <sample-size> [FILE]\n",
      exitCode: 1
    };
  }
  const { headers, data, error } = await readCsvInput(fileArgs, ctx);
  if (error)
    return error;
  if (data.length <= num) {
    return { stdout: formatCsv(headers, data), stderr: "", exitCode: 0 };
  }
  let rng = seed !== null ? seed : Date.now();
  const random = /* @__PURE__ */ __name(() => {
    rng = rng * 1103515245 + 12345 & 2147483647;
    return rng / 2147483647;
  }, "random");
  const indices = data.map((_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  const sampled = indices.slice(0, num).sort((a, b) => a - b).map((i) => data[i]);
  return { stdout: formatCsv(headers, sampled), stderr: "", exitCode: 0 };
}
__name(cmdSample, "cmdSample");
async function cmdCat(args, ctx) {
  let pad = false;
  const fileArgs = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-p" || arg === "--pad") {
      pad = true;
    } else if (!arg.startsWith("-")) {
      fileArgs.push(arg);
    }
  }
  if (fileArgs.length === 0) {
    return {
      stdout: "",
      stderr: "xan cat: no files specified\n",
      exitCode: 1
    };
  }
  const result = await readFiles(ctx, fileArgs, {
    cmdName: "xan cat",
    stopOnError: true
  });
  if (result.exitCode !== 0) {
    return { stdout: "", stderr: result.stderr, exitCode: result.exitCode };
  }
  const allFiles = [];
  let allHeaders = [];
  for (const { content } of result.files) {
    const { headers, data } = parseCsv(content);
    allFiles.push({ headers, data });
    for (const h of headers) {
      if (!allHeaders.includes(h)) {
        allHeaders.push(h);
      }
    }
  }
  if (!pad) {
    const firstHeaders = JSON.stringify(allFiles[0].headers);
    for (let i = 1; i < allFiles.length; i++) {
      if (JSON.stringify(allFiles[i].headers) !== firstHeaders) {
        return {
          stdout: "",
          stderr: "xan cat: headers do not match (use -p to pad)\n",
          exitCode: 1
        };
      }
    }
    allHeaders = allFiles[0].headers;
  }
  const allData = [];
  for (const { headers, data } of allFiles) {
    for (const row of data) {
      const newRow = {};
      for (const h of allHeaders) {
        newRow[h] = headers.includes(h) ? row[h] : "";
      }
      allData.push(newRow);
    }
  }
  return { stdout: formatCsv(allHeaders, allData), stderr: "", exitCode: 0 };
}
__name(cmdCat, "cmdCat");
async function cmdSearch(args, ctx) {
  let pattern = "";
  let selectCols = [];
  let invert = false;
  let ignoreCase = false;
  const fileArgs = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "-s" || arg === "--select") && i + 1 < args.length) {
      selectCols = args[++i].split(",");
    } else if (arg === "-v" || arg === "--invert") {
      invert = true;
    } else if (arg === "-i" || arg === "--ignore-case") {
      ignoreCase = true;
    } else if (arg === "-r" || arg === "--regex") {
    } else if (!arg.startsWith("-")) {
      if (!pattern) {
        pattern = arg;
      } else {
        fileArgs.push(arg);
      }
    }
  }
  if (!pattern) {
    return {
      stdout: "",
      stderr: "xan search: no pattern specified\n",
      exitCode: 1
    };
  }
  const { headers, data, error } = await readCsvInput(fileArgs, ctx);
  if (error)
    return error;
  const searchCols = selectCols.length > 0 ? selectCols : headers;
  let regex;
  try {
    regex = new RegExp(pattern, ignoreCase ? "i" : "");
  } catch {
    return {
      stdout: "",
      stderr: `xan search: invalid regex pattern '${pattern}'
`,
      exitCode: 1
    };
  }
  const filtered = data.filter((row) => {
    const matches = searchCols.some((col) => {
      const val = row[col];
      return val !== null && val !== void 0 && regex.test(String(val));
    });
    return invert ? !matches : matches;
  });
  return { stdout: formatCsv(headers, filtered), stderr: "", exitCode: 0 };
}
__name(cmdSearch, "cmdSearch");
async function cmdFlatmap(args, ctx) {
  let expr = "";
  const fileArgs = [];
  for (const arg of args) {
    if (!arg.startsWith("-")) {
      if (!expr) {
        expr = arg;
      } else {
        fileArgs.push(arg);
      }
    }
  }
  if (!expr) {
    return {
      stdout: "",
      stderr: "xan flatmap: no expression specified\n",
      exitCode: 1
    };
  }
  const { headers, data, error } = await readCsvInput(fileArgs, ctx);
  if (error)
    return error;
  const namedExprs = parseNamedExpressions(expr);
  const specs = namedExprs.map(({ expr: e, name }) => ({
    alias: typeof name === "string" ? name : name[0],
    ast: moonbladeToJq(e)
  }));
  const evalOptions = {
    limits: ctx.limits ? { maxIterations: ctx.limits.maxJqIterations } : void 0
  };
  const newHeaders = [...headers, ...specs.map((s) => s.alias)];
  const newData = [];
  for (const row of data) {
    const results = [];
    let maxLen = 1;
    for (const spec of specs) {
      const evalResults = evaluate(row, spec.ast, evalOptions);
      const expanded = evalResults.length > 0 && Array.isArray(evalResults[0]) ? evalResults[0] : evalResults;
      results.push(expanded);
      maxLen = Math.max(maxLen, expanded.length);
    }
    for (let i = 0; i < maxLen; i++) {
      const newRow = { ...row };
      for (let j = 0; j < specs.length; j++) {
        const val = results[j][i] ?? null;
        newRow[specs[j].alias] = val;
      }
      newData.push(newRow);
    }
  }
  return { stdout: formatCsv(newHeaders, newData), stderr: "", exitCode: 0 };
}
__name(cmdFlatmap, "cmdFlatmap");
async function cmdFmt(args, ctx) {
  const { cmdView: cmdView2 } = await import("./xan-view-YXRJKE2Y.js");
  return cmdView2(args, ctx);
}
__name(cmdFmt, "cmdFmt");

// dist/commands/xan/xan.js
var NOT_IMPLEMENTED = /* @__PURE__ */ new Set([
  "fuzzy-join",
  "glob",
  "hist",
  "input",
  "parallel",
  "plot",
  "progress",
  "range",
  "scrape",
  "tokenize",
  // Real xan's tokenize is NLP tokenizer
  "union-find"
]);
var KNOWN_COMMANDS = /* @__PURE__ */ new Set([
  // Implemented
  "agg",
  "behead",
  "cat",
  "count",
  "dedup",
  "drop",
  "enum",
  "explode",
  "f",
  // alias for flatten
  "filter",
  "fixlengths",
  "flatmap",
  "flatten",
  "fmt",
  "frequency",
  "freq",
  "from",
  "groupby",
  "head",
  "headers",
  "implode",
  "join",
  "map",
  "merge",
  "partition",
  "pivot",
  "rename",
  "reverse",
  "sample",
  "search",
  "select",
  "shuffle",
  "slice",
  "sort",
  "split",
  "stats",
  "tail",
  "to",
  "top",
  "transform",
  "transpose",
  "view",
  // Not implemented
  ...NOT_IMPLEMENTED
]);
var xanHelp = {
  name: "xan",
  summary: "CSV toolkit for data manipulation",
  usage: "xan <COMMAND> [OPTIONS] [FILE]",
  description: `xan is a collection of commands for working with CSV data.
It provides a simple, ergonomic interface for common data operations.

COMMANDS:
  Core:
    headers    Show column names
    count      Count rows
    head       Show first N rows
    tail       Show last N rows
    slice      Extract row range
    reverse    Reverse row order
    behead     Remove header row
    sample     Random sample of rows

  Column operations:
    select     Select columns (supports glob, ranges, negation)
    drop       Drop columns
    rename     Rename columns
    enum       Add row index column

  Row operations:
    filter     Filter rows by expression
    search     Filter rows by regex match
    sort       Sort rows
    dedup      Remove duplicates
    top        Get top N by column

  Transformations:
    map        Add computed columns
    transform  Modify existing columns
    explode    Split column into multiple rows
    implode    Combine rows, join column values
    flatmap    Map returning multiple rows
    pivot      Reshape rows into columns
    transpose  Swap rows and columns

  Aggregation:
    agg        Aggregate values
    groupby    Group and aggregate
    frequency  Count value occurrences
    stats      Show column statistics

  Multi-file:
    cat        Concatenate CSV files
    join       Join two CSV files on key
    merge      Merge sorted CSV files
    split      Split into multiple files
    partition  Split by column value

  Data conversion:
    to         Convert CSV to other formats (json)
    from       Convert other formats to CSV (json)
    shuffle    Randomly reorder rows
    fixlengths Fix ragged CSV files

  Output:
    view       Pretty print as table
    flatten    Display records vertically (alias: f)
    fmt        Format output

EXAMPLES:
  xan headers data.csv
  xan count data.csv
  xan head -n 5 data.csv
  xan select name,email data.csv
  xan select 'vec_*' data.csv          # glob pattern
  xan select 'a:c' data.csv            # column range
  xan filter 'age > 30' data.csv
  xan search -r '^foo' data.csv
  xan sort -N price data.csv
  xan agg 'sum(amount) as total' data.csv
  xan groupby region 'count() as n' data.csv
  xan explode tags data.csv
  xan join id file1.csv id file2.csv
  xan pivot year 'sum(sales)' data.csv`,
  options: ["    --help    display this help and exit"]
};
var subHelps = {
  headers: {
    name: "xan headers",
    summary: "Show column names",
    usage: "xan headers [OPTIONS] [FILE]",
    description: "Display column names from a CSV file.",
    options: ["-j, --just-names    show names only (no index)"]
  },
  count: {
    name: "xan count",
    summary: "Count rows",
    usage: "xan count [FILE]",
    description: "Count the number of data rows (excluding header).",
    options: []
  },
  filter: {
    name: "xan filter",
    summary: "Filter rows by expression",
    usage: "xan filter [OPTIONS] EXPR [FILE]",
    description: "Filter CSV rows using moonblade expressions.",
    options: [
      "-v, --invert    invert match",
      "-l, --limit N   limit output rows"
    ]
  },
  search: {
    name: "xan search",
    summary: "Filter rows by regex",
    usage: "xan search [OPTIONS] PATTERN [FILE]",
    description: "Filter CSV rows by regex match on columns.",
    options: [
      "-s, --select COLS   search only these columns",
      "-v, --invert        invert match",
      "-i, --ignore-case   case insensitive"
    ]
  },
  select: {
    name: "xan select",
    summary: "Select columns",
    usage: "xan select COLS [FILE]",
    description: "Select columns by name, index, glob, or range.",
    options: [
      "Supports: col names, indices (0,1), ranges (a:c), globs (vec_*), negation (!col)"
    ]
  },
  explode: {
    name: "xan explode",
    summary: "Split column into rows",
    usage: "xan explode COLUMN [OPTIONS] [FILE]",
    description: "Split delimited column values into multiple rows.",
    options: [
      "-s, --separator SEP  separator (default: |)",
      "--drop-empty         drop empty values",
      "-r, --rename NAME    rename column"
    ]
  },
  implode: {
    name: "xan implode",
    summary: "Combine rows",
    usage: "xan implode COLUMN [OPTIONS] [FILE]",
    description: "Combine consecutive rows, joining column values.",
    options: [
      "-s, --sep SEP        separator (default: |)",
      "-r, --rename NAME    rename column"
    ]
  },
  join: {
    name: "xan join",
    summary: "Join CSV files",
    usage: "xan join KEY1 FILE1 KEY2 FILE2 [OPTIONS]",
    description: "Join two CSV files on key columns.",
    options: [
      "--left               left outer join",
      "--right              right outer join",
      "--full               full outer join",
      "-D, --default VAL    default for missing"
    ]
  },
  pivot: {
    name: "xan pivot",
    summary: "Reshape to columns",
    usage: "xan pivot COLUMN AGG_EXPR [OPTIONS] [FILE]",
    description: "Turn row values into columns.",
    options: ["-g, --groupby COLS   group by columns"]
  }
};
var xanCommand = {
  name: "xan",
  async execute(args, ctx) {
    if (args.length === 0 || hasHelpFlag(args)) {
      return showHelp(xanHelp);
    }
    const subcommand = args[0];
    const subArgs = args.slice(1);
    if (hasHelpFlag(subArgs)) {
      const help = subHelps[subcommand];
      if (help) {
        return showHelp(help);
      }
      return showHelp(xanHelp);
    }
    if (NOT_IMPLEMENTED.has(subcommand)) {
      return {
        stdout: "",
        stderr: `xan ${subcommand}: not yet implemented
`,
        exitCode: 1
      };
    }
    switch (subcommand) {
      // Core
      case "headers":
        return cmdHeaders(subArgs, ctx);
      case "count":
        return cmdCount(subArgs, ctx);
      case "head":
        return cmdHead(subArgs, ctx);
      case "tail":
        return cmdTail(subArgs, ctx);
      case "slice":
        return cmdSlice(subArgs, ctx);
      case "reverse":
        return cmdReverse(subArgs, ctx);
      case "behead":
        return cmdBehead(subArgs, ctx);
      case "sample":
        return cmdSample(subArgs, ctx);
      // Column operations
      case "select":
        return cmdSelect(subArgs, ctx);
      case "drop":
        return cmdDrop(subArgs, ctx);
      case "rename":
        return cmdRename(subArgs, ctx);
      case "enum":
        return cmdEnum(subArgs, ctx);
      // Row operations
      case "filter":
        return cmdFilter(subArgs, ctx);
      case "search":
        return cmdSearch(subArgs, ctx);
      case "sort":
        return cmdSort(subArgs, ctx);
      case "dedup":
        return cmdDedup(subArgs, ctx);
      case "top":
        return cmdTop(subArgs, ctx);
      // Transformations
      case "map":
        return cmdMap(subArgs, ctx);
      case "transform":
        return cmdTransform(subArgs, ctx);
      case "explode":
        return cmdExplode(subArgs, ctx);
      case "implode":
        return cmdImplode(subArgs, ctx);
      case "flatmap":
        return cmdFlatmap(subArgs, ctx);
      case "pivot":
        return cmdPivot(subArgs, ctx);
      // Aggregation
      case "agg":
        return cmdAgg(subArgs, ctx);
      case "groupby":
        return cmdGroupby(subArgs, ctx);
      case "frequency":
      case "freq":
        return cmdFrequency(subArgs, ctx);
      case "stats":
        return cmdStats(subArgs, ctx);
      // Multi-file
      case "cat":
        return cmdCat(subArgs, ctx);
      case "join":
        return cmdJoin(subArgs, ctx);
      case "merge":
        return cmdMerge(subArgs, ctx);
      case "split":
        return cmdSplit(subArgs, ctx);
      case "partition":
        return cmdPartition(subArgs, ctx);
      // Data conversion
      case "to":
        return cmdTo(subArgs, ctx);
      case "from":
        return cmdFrom(subArgs, ctx);
      case "transpose":
        return cmdTranspose(subArgs, ctx);
      case "shuffle":
        return cmdShuffle(subArgs, ctx);
      case "fixlengths":
        return cmdFixlengths(subArgs, ctx);
      // Output
      case "view":
        return cmdView(subArgs, ctx);
      case "flatten":
      case "f":
        return cmdFlatten(subArgs, ctx);
      case "fmt":
        return cmdFmt(subArgs, ctx);
      default:
        if (KNOWN_COMMANDS.has(subcommand)) {
          return {
            stdout: "",
            stderr: `xan ${subcommand}: not yet implemented
`,
            exitCode: 1
          };
        }
        return {
          stdout: "",
          stderr: `xan: unknown command '${subcommand}'
Run 'xan --help' for usage.
`,
          exitCode: 1
        };
    }
  }
};
export {
  xanCommand
};
