/**
 * AWK Lexer
 *
 * Tokenizes AWK source code into a stream of tokens.
 */
export var TokenType;
(function (TokenType) {
    // Literals
    TokenType["NUMBER"] = "NUMBER";
    TokenType["STRING"] = "STRING";
    TokenType["REGEX"] = "REGEX";
    // Identifiers
    TokenType["IDENT"] = "IDENT";
    // Keywords
    TokenType["BEGIN"] = "BEGIN";
    TokenType["END"] = "END";
    TokenType["IF"] = "IF";
    TokenType["ELSE"] = "ELSE";
    TokenType["WHILE"] = "WHILE";
    TokenType["DO"] = "DO";
    TokenType["FOR"] = "FOR";
    TokenType["IN"] = "IN";
    TokenType["BREAK"] = "BREAK";
    TokenType["CONTINUE"] = "CONTINUE";
    TokenType["NEXT"] = "NEXT";
    TokenType["NEXTFILE"] = "NEXTFILE";
    TokenType["EXIT"] = "EXIT";
    TokenType["RETURN"] = "RETURN";
    TokenType["DELETE"] = "DELETE";
    TokenType["FUNCTION"] = "FUNCTION";
    TokenType["PRINT"] = "PRINT";
    TokenType["PRINTF"] = "PRINTF";
    TokenType["GETLINE"] = "GETLINE";
    // Operators
    TokenType["PLUS"] = "PLUS";
    TokenType["MINUS"] = "MINUS";
    TokenType["STAR"] = "STAR";
    TokenType["SLASH"] = "SLASH";
    TokenType["PERCENT"] = "PERCENT";
    TokenType["CARET"] = "CARET";
    TokenType["EQ"] = "EQ";
    TokenType["NE"] = "NE";
    TokenType["LT"] = "LT";
    TokenType["GT"] = "GT";
    TokenType["LE"] = "LE";
    TokenType["GE"] = "GE";
    TokenType["MATCH"] = "MATCH";
    TokenType["NOT_MATCH"] = "NOT_MATCH";
    TokenType["AND"] = "AND";
    TokenType["OR"] = "OR";
    TokenType["NOT"] = "NOT";
    TokenType["ASSIGN"] = "ASSIGN";
    TokenType["PLUS_ASSIGN"] = "PLUS_ASSIGN";
    TokenType["MINUS_ASSIGN"] = "MINUS_ASSIGN";
    TokenType["STAR_ASSIGN"] = "STAR_ASSIGN";
    TokenType["SLASH_ASSIGN"] = "SLASH_ASSIGN";
    TokenType["PERCENT_ASSIGN"] = "PERCENT_ASSIGN";
    TokenType["CARET_ASSIGN"] = "CARET_ASSIGN";
    TokenType["INCREMENT"] = "INCREMENT";
    TokenType["DECREMENT"] = "DECREMENT";
    TokenType["QUESTION"] = "QUESTION";
    TokenType["COLON"] = "COLON";
    TokenType["COMMA"] = "COMMA";
    TokenType["SEMICOLON"] = "SEMICOLON";
    TokenType["NEWLINE"] = "NEWLINE";
    TokenType["LPAREN"] = "LPAREN";
    TokenType["RPAREN"] = "RPAREN";
    TokenType["LBRACE"] = "LBRACE";
    TokenType["RBRACE"] = "RBRACE";
    TokenType["LBRACKET"] = "LBRACKET";
    TokenType["RBRACKET"] = "RBRACKET";
    TokenType["DOLLAR"] = "DOLLAR";
    TokenType["APPEND"] = "APPEND";
    TokenType["PIPE"] = "PIPE";
    TokenType["EOF"] = "EOF";
})(TokenType || (TokenType = {}));
const KEYWORDS = {
    BEGIN: TokenType.BEGIN,
    END: TokenType.END,
    if: TokenType.IF,
    else: TokenType.ELSE,
    while: TokenType.WHILE,
    do: TokenType.DO,
    for: TokenType.FOR,
    in: TokenType.IN,
    break: TokenType.BREAK,
    continue: TokenType.CONTINUE,
    next: TokenType.NEXT,
    nextfile: TokenType.NEXTFILE,
    exit: TokenType.EXIT,
    return: TokenType.RETURN,
    delete: TokenType.DELETE,
    function: TokenType.FUNCTION,
    print: TokenType.PRINT,
    printf: TokenType.PRINTF,
    getline: TokenType.GETLINE,
};
/**
 * Expand POSIX character classes in regex patterns
 */
function expandPosixClasses(pattern) {
    return pattern
        .replace(/\[\[:space:\]\]/g, "[ \\t\\n\\r\\f\\v]")
        .replace(/\[\[:blank:\]\]/g, "[ \\t]")
        .replace(/\[\[:alpha:\]\]/g, "[a-zA-Z]")
        .replace(/\[\[:digit:\]\]/g, "[0-9]")
        .replace(/\[\[:alnum:\]\]/g, "[a-zA-Z0-9]")
        .replace(/\[\[:upper:\]\]/g, "[A-Z]")
        .replace(/\[\[:lower:\]\]/g, "[a-z]")
        .replace(/\[\[:punct:\]\]/g, "[!\"#$%&'()*+,\\-./:;<=>?@\\[\\]\\\\^_`{|}~]")
        .replace(/\[\[:xdigit:\]\]/g, "[0-9A-Fa-f]")
        .replace(/\[\[:graph:\]\]/g, "[!-~]")
        .replace(/\[\[:print:\]\]/g, "[ -~]")
        .replace(/\[\[:cntrl:\]\]/g, "[\\x00-\\x1f\\x7f]");
}
export class AwkLexer {
    input;
    pos = 0;
    line = 1;
    column = 1;
    lastTokenType = null;
    constructor(input) {
        this.input = input;
    }
    tokenize() {
        const tokens = [];
        while (this.pos < this.input.length) {
            const token = this.nextToken();
            if (token) {
                tokens.push(token);
                this.lastTokenType = token.type;
            }
        }
        tokens.push(this.makeToken(TokenType.EOF, ""));
        return tokens;
    }
    makeToken(type, value) {
        return { type, value, line: this.line, column: this.column };
    }
    peek(offset = 0) {
        return this.input[this.pos + offset] || "";
    }
    advance() {
        const ch = this.input[this.pos++] || "";
        if (ch === "\n") {
            this.line++;
            this.column = 1;
        }
        else {
            this.column++;
        }
        return ch;
    }
    skipWhitespace() {
        while (this.pos < this.input.length) {
            const ch = this.peek();
            if (ch === " " || ch === "\t" || ch === "\r") {
                this.advance();
            }
            else if (ch === "\\") {
                // Line continuation
                if (this.peek(1) === "\n") {
                    this.advance(); // skip \
                    this.advance(); // skip \n
                }
                else {
                    break;
                }
            }
            else if (ch === "#") {
                // Comment - skip to end of line
                while (this.pos < this.input.length && this.peek() !== "\n") {
                    this.advance();
                }
            }
            else {
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
        // Newline
        if (ch === "\n") {
            this.advance();
            return {
                type: TokenType.NEWLINE,
                value: "\n",
                line: startLine,
                column: startColumn,
            };
        }
        // String literal
        if (ch === '"') {
            return this.readString();
        }
        // Regex literal - context-sensitive
        if (ch === "/" && this.canBeRegex()) {
            return this.readRegex();
        }
        // Number
        if (this.isDigit(ch) || (ch === "." && this.isDigit(this.peek(1)))) {
            return this.readNumber();
        }
        // Identifier or keyword
        if (this.isAlpha(ch) || ch === "_") {
            return this.readIdentifier();
        }
        // Operators and punctuation
        return this.readOperator();
    }
    canBeRegex() {
        // Regex can appear after these tokens (or at start)
        const regexPreceders = new Set([
            null,
            TokenType.NEWLINE,
            TokenType.SEMICOLON,
            TokenType.LBRACE,
            TokenType.RBRACE, // After closing action block, a new rule may start with regex
            TokenType.LPAREN,
            TokenType.LBRACKET,
            TokenType.COMMA,
            TokenType.ASSIGN,
            TokenType.PLUS_ASSIGN,
            TokenType.MINUS_ASSIGN,
            TokenType.STAR_ASSIGN,
            TokenType.SLASH_ASSIGN,
            TokenType.PERCENT_ASSIGN,
            TokenType.CARET_ASSIGN,
            TokenType.AND,
            TokenType.OR,
            TokenType.NOT,
            TokenType.MATCH,
            TokenType.NOT_MATCH,
            TokenType.QUESTION,
            TokenType.COLON,
            TokenType.LT,
            TokenType.GT,
            TokenType.LE,
            TokenType.GE,
            TokenType.EQ,
            TokenType.NE,
            TokenType.PLUS,
            TokenType.MINUS,
            TokenType.STAR,
            TokenType.PERCENT,
            TokenType.CARET,
            TokenType.PRINT,
            TokenType.PRINTF,
            TokenType.IF,
            TokenType.WHILE,
            TokenType.DO,
            TokenType.FOR,
            TokenType.RETURN,
        ]);
        return regexPreceders.has(this.lastTokenType);
    }
    readString() {
        const startLine = this.line;
        const startColumn = this.column;
        this.advance(); // skip opening quote
        let value = "";
        while (this.pos < this.input.length && this.peek() !== '"') {
            if (this.peek() === "\\") {
                this.advance();
                const escaped = this.advance();
                switch (escaped) {
                    case "n":
                        value += "\n";
                        break;
                    case "t":
                        value += "\t";
                        break;
                    case "r":
                        value += "\r";
                        break;
                    case "f":
                        value += "\f";
                        break;
                    case "b":
                        value += "\b";
                        break;
                    case "v":
                        value += "\v";
                        break;
                    case "a":
                        value += "\x07"; // bell/alert
                        break;
                    case "\\":
                        value += "\\";
                        break;
                    case '"':
                        value += '"';
                        break;
                    case "/":
                        value += "/";
                        break;
                    case "x": {
                        // Hex escape: \xHH (2 hex digits max)
                        // Note: Different AWK implementations vary in how many digits they consume
                        // We use 2 digits which matches OneTrue AWK test expectations
                        let hex = "";
                        while (hex.length < 2 && /[0-9a-fA-F]/.test(this.peek())) {
                            hex += this.advance();
                        }
                        if (hex.length > 0) {
                            value += String.fromCharCode(parseInt(hex, 16));
                        }
                        else {
                            value += "x"; // No hex digits, treat as literal x
                        }
                        break;
                    }
                    default:
                        // Check for octal escape: \0 to \377
                        if (/[0-7]/.test(escaped)) {
                            let octal = escaped;
                            // Read up to 2 more octal digits (max 3 total)
                            while (octal.length < 3 && /[0-7]/.test(this.peek())) {
                                octal += this.advance();
                            }
                            value += String.fromCharCode(parseInt(octal, 8));
                        }
                        else {
                            value += escaped;
                        }
                }
            }
            else {
                value += this.advance();
            }
        }
        if (this.peek() === '"') {
            this.advance(); // skip closing quote
        }
        return {
            type: TokenType.STRING,
            value,
            line: startLine,
            column: startColumn,
        };
    }
    readRegex() {
        const startLine = this.line;
        const startColumn = this.column;
        this.advance(); // skip opening /
        let pattern = "";
        while (this.pos < this.input.length && this.peek() !== "/") {
            if (this.peek() === "\\") {
                pattern += this.advance();
                if (this.pos < this.input.length) {
                    pattern += this.advance();
                }
            }
            else if (this.peek() === "\n") {
                // Unterminated regex
                break;
            }
            else {
                pattern += this.advance();
            }
        }
        if (this.peek() === "/") {
            this.advance(); // skip closing /
        }
        // Expand POSIX character classes
        pattern = expandPosixClasses(pattern);
        return {
            type: TokenType.REGEX,
            value: pattern,
            line: startLine,
            column: startColumn,
        };
    }
    readNumber() {
        const startLine = this.line;
        const startColumn = this.column;
        let numStr = "";
        // Integer part
        while (this.isDigit(this.peek())) {
            numStr += this.advance();
        }
        // Decimal part
        if (this.peek() === "." && this.isDigit(this.peek(1))) {
            numStr += this.advance(); // .
            while (this.isDigit(this.peek())) {
                numStr += this.advance();
            }
        }
        // Exponent part
        if (this.peek() === "e" || this.peek() === "E") {
            numStr += this.advance();
            if (this.peek() === "+" || this.peek() === "-") {
                numStr += this.advance();
            }
            while (this.isDigit(this.peek())) {
                numStr += this.advance();
            }
        }
        return {
            type: TokenType.NUMBER,
            value: parseFloat(numStr),
            line: startLine,
            column: startColumn,
        };
    }
    readIdentifier() {
        const startLine = this.line;
        const startColumn = this.column;
        let name = "";
        while (this.isAlphaNumeric(this.peek()) || this.peek() === "_") {
            name += this.advance();
        }
        const keywordType = KEYWORDS[name];
        if (keywordType) {
            return {
                type: keywordType,
                value: name,
                line: startLine,
                column: startColumn,
            };
        }
        return {
            type: TokenType.IDENT,
            value: name,
            line: startLine,
            column: startColumn,
        };
    }
    readOperator() {
        const startLine = this.line;
        const startColumn = this.column;
        const ch = this.advance();
        const next = this.peek();
        switch (ch) {
            case "+":
                if (next === "+") {
                    this.advance();
                    return {
                        type: TokenType.INCREMENT,
                        value: "++",
                        line: startLine,
                        column: startColumn,
                    };
                }
                if (next === "=") {
                    this.advance();
                    return {
                        type: TokenType.PLUS_ASSIGN,
                        value: "+=",
                        line: startLine,
                        column: startColumn,
                    };
                }
                return {
                    type: TokenType.PLUS,
                    value: "+",
                    line: startLine,
                    column: startColumn,
                };
            case "-":
                if (next === "-") {
                    this.advance();
                    return {
                        type: TokenType.DECREMENT,
                        value: "--",
                        line: startLine,
                        column: startColumn,
                    };
                }
                if (next === "=") {
                    this.advance();
                    return {
                        type: TokenType.MINUS_ASSIGN,
                        value: "-=",
                        line: startLine,
                        column: startColumn,
                    };
                }
                return {
                    type: TokenType.MINUS,
                    value: "-",
                    line: startLine,
                    column: startColumn,
                };
            case "*":
                if (next === "*") {
                    this.advance();
                    // ** is an alias for ^ (power operator)
                    return {
                        type: TokenType.CARET,
                        value: "**",
                        line: startLine,
                        column: startColumn,
                    };
                }
                if (next === "=") {
                    this.advance();
                    return {
                        type: TokenType.STAR_ASSIGN,
                        value: "*=",
                        line: startLine,
                        column: startColumn,
                    };
                }
                return {
                    type: TokenType.STAR,
                    value: "*",
                    line: startLine,
                    column: startColumn,
                };
            case "/":
                if (next === "=") {
                    this.advance();
                    return {
                        type: TokenType.SLASH_ASSIGN,
                        value: "/=",
                        line: startLine,
                        column: startColumn,
                    };
                }
                return {
                    type: TokenType.SLASH,
                    value: "/",
                    line: startLine,
                    column: startColumn,
                };
            case "%":
                if (next === "=") {
                    this.advance();
                    return {
                        type: TokenType.PERCENT_ASSIGN,
                        value: "%=",
                        line: startLine,
                        column: startColumn,
                    };
                }
                return {
                    type: TokenType.PERCENT,
                    value: "%",
                    line: startLine,
                    column: startColumn,
                };
            case "^":
                if (next === "=") {
                    this.advance();
                    return {
                        type: TokenType.CARET_ASSIGN,
                        value: "^=",
                        line: startLine,
                        column: startColumn,
                    };
                }
                return {
                    type: TokenType.CARET,
                    value: "^",
                    line: startLine,
                    column: startColumn,
                };
            case "=":
                if (next === "=") {
                    this.advance();
                    return {
                        type: TokenType.EQ,
                        value: "==",
                        line: startLine,
                        column: startColumn,
                    };
                }
                return {
                    type: TokenType.ASSIGN,
                    value: "=",
                    line: startLine,
                    column: startColumn,
                };
            case "!":
                if (next === "=") {
                    this.advance();
                    return {
                        type: TokenType.NE,
                        value: "!=",
                        line: startLine,
                        column: startColumn,
                    };
                }
                if (next === "~") {
                    this.advance();
                    return {
                        type: TokenType.NOT_MATCH,
                        value: "!~",
                        line: startLine,
                        column: startColumn,
                    };
                }
                return {
                    type: TokenType.NOT,
                    value: "!",
                    line: startLine,
                    column: startColumn,
                };
            case "<":
                if (next === "=") {
                    this.advance();
                    return {
                        type: TokenType.LE,
                        value: "<=",
                        line: startLine,
                        column: startColumn,
                    };
                }
                return {
                    type: TokenType.LT,
                    value: "<",
                    line: startLine,
                    column: startColumn,
                };
            case ">":
                if (next === "=") {
                    this.advance();
                    return {
                        type: TokenType.GE,
                        value: ">=",
                        line: startLine,
                        column: startColumn,
                    };
                }
                if (next === ">") {
                    this.advance();
                    return {
                        type: TokenType.APPEND,
                        value: ">>",
                        line: startLine,
                        column: startColumn,
                    };
                }
                return {
                    type: TokenType.GT,
                    value: ">",
                    line: startLine,
                    column: startColumn,
                };
            case "&":
                if (next === "&") {
                    this.advance();
                    return {
                        type: TokenType.AND,
                        value: "&&",
                        line: startLine,
                        column: startColumn,
                    };
                }
                // Single & is not valid in AWK, treat as unknown
                return {
                    type: TokenType.IDENT,
                    value: "&",
                    line: startLine,
                    column: startColumn,
                };
            case "|":
                if (next === "|") {
                    this.advance();
                    return {
                        type: TokenType.OR,
                        value: "||",
                        line: startLine,
                        column: startColumn,
                    };
                }
                return {
                    type: TokenType.PIPE,
                    value: "|",
                    line: startLine,
                    column: startColumn,
                };
            case "~":
                return {
                    type: TokenType.MATCH,
                    value: "~",
                    line: startLine,
                    column: startColumn,
                };
            case "?":
                return {
                    type: TokenType.QUESTION,
                    value: "?",
                    line: startLine,
                    column: startColumn,
                };
            case ":":
                return {
                    type: TokenType.COLON,
                    value: ":",
                    line: startLine,
                    column: startColumn,
                };
            case ",":
                return {
                    type: TokenType.COMMA,
                    value: ",",
                    line: startLine,
                    column: startColumn,
                };
            case ";":
                return {
                    type: TokenType.SEMICOLON,
                    value: ";",
                    line: startLine,
                    column: startColumn,
                };
            case "(":
                return {
                    type: TokenType.LPAREN,
                    value: "(",
                    line: startLine,
                    column: startColumn,
                };
            case ")":
                return {
                    type: TokenType.RPAREN,
                    value: ")",
                    line: startLine,
                    column: startColumn,
                };
            case "{":
                return {
                    type: TokenType.LBRACE,
                    value: "{",
                    line: startLine,
                    column: startColumn,
                };
            case "}":
                return {
                    type: TokenType.RBRACE,
                    value: "}",
                    line: startLine,
                    column: startColumn,
                };
            case "[":
                return {
                    type: TokenType.LBRACKET,
                    value: "[",
                    line: startLine,
                    column: startColumn,
                };
            case "]":
                return {
                    type: TokenType.RBRACKET,
                    value: "]",
                    line: startLine,
                    column: startColumn,
                };
            case "$":
                return {
                    type: TokenType.DOLLAR,
                    value: "$",
                    line: startLine,
                    column: startColumn,
                };
            default:
                // Unknown character - return as identifier to allow graceful handling
                return {
                    type: TokenType.IDENT,
                    value: ch,
                    line: startLine,
                    column: startColumn,
                };
        }
    }
    isDigit(ch) {
        return ch >= "0" && ch <= "9";
    }
    isAlpha(ch) {
        return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");
    }
    isAlphaNumeric(ch) {
        return this.isDigit(ch) || this.isAlpha(ch);
    }
}
