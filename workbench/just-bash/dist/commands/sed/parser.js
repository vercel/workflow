// Parser for sed scripts using lexer-based tokenization
import { SedLexer, SedTokenType } from "./lexer.js";
class SedParser {
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
                // Skip empty tokens
                if (this.check(SedTokenType.NEWLINE) ||
                    this.check(SedTokenType.SEMICOLON)) {
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
        // Parse optional address range
        const addressResult = this.parseAddressRange();
        // Check for incomplete range error (e.g., "1,")
        if (addressResult?.error) {
            return { command: null, error: addressResult.error };
        }
        const address = addressResult?.address;
        // Check for negation modifier (!)
        if (this.check(SedTokenType.NEGATION)) {
            this.advance();
            if (address) {
                address.negated = true;
            }
        }
        // Skip whitespace tokens
        while (this.check(SedTokenType.NEWLINE) ||
            this.check(SedTokenType.SEMICOLON)) {
            this.advance();
        }
        if (this.isAtEnd()) {
            // Address with no command is an error (standard sed behavior)
            if (address &&
                (address.start !== undefined || address.end !== undefined)) {
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
                    command: { type: "label", name: token.label || "" },
                };
            case SedTokenType.BRANCH:
                this.advance();
                return {
                    command: { type: "branch", address, label: token.label },
                };
            case SedTokenType.BRANCH_ON_SUBST:
                this.advance();
                return {
                    command: { type: "branchOnSubst", address, label: token.label },
                };
            case SedTokenType.BRANCH_ON_NO_SUBST:
                this.advance();
                return {
                    command: { type: "branchOnNoSubst", address, label: token.label },
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
                        filename: token.filename || "",
                    },
                };
            case SedTokenType.FILE_READ_LINE:
                this.advance();
                return {
                    command: {
                        type: "readFileLine",
                        address,
                        filename: token.filename || "",
                    },
                };
            case SedTokenType.FILE_WRITE:
                this.advance();
                return {
                    command: {
                        type: "writeFile",
                        address,
                        filename: token.filename || "",
                    },
                };
            case SedTokenType.FILE_WRITE_LINE:
                this.advance();
                return {
                    command: {
                        type: "writeFirstLine",
                        address,
                        filename: token.filename || "",
                    },
                };
            case SedTokenType.EXECUTE:
                this.advance();
                return {
                    command: { type: "execute", address, command: token.command },
                };
            case SedTokenType.VERSION:
                this.advance();
                return {
                    command: {
                        type: "version",
                        address,
                        minVersion: token.label, // label field holds version string
                    },
                };
            case SedTokenType.LBRACE:
                return this.parseGroup(address);
            case SedTokenType.RBRACE:
                // End of group - handled by parseGroup
                return { command: null };
            case SedTokenType.ERROR:
                return { command: null, error: `invalid command: ${token.value}` };
            default:
                // Address with no recognized command is an error
                if (address &&
                    (address.start !== undefined || address.end !== undefined)) {
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
                extendedRegex: this.extendedRegex,
            },
        };
    }
    parseTransliterateFromToken(token, address) {
        this.advance();
        const source = token.source || "";
        const dest = token.dest || "";
        if (source.length !== dest.length) {
            return {
                command: null,
                error: "transliteration sets must have same length",
            };
        }
        return {
            command: {
                type: "transliterate",
                address,
                source,
                dest,
            },
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
        this.advance(); // consume {
        const commands = [];
        while (!this.isAtEnd() && !this.check(SedTokenType.RBRACE)) {
            // Skip empty tokens
            if (this.check(SedTokenType.NEWLINE) ||
                this.check(SedTokenType.SEMICOLON)) {
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
        this.advance(); // consume }
        return {
            command: { type: "group", address, commands },
        };
    }
    parseAddressRange() {
        // Try to parse first address
        const start = this.parseAddress();
        if (start === undefined) {
            return undefined;
        }
        // Check for range separator or relative offset (GNU extension: ,+N)
        let end;
        if (this.check(SedTokenType.RELATIVE_OFFSET)) {
            // GNU extension: /pattern/,+N means "match N more lines after pattern"
            const token = this.advance();
            end = { offset: token.offset || 0 };
        }
        else if (this.check(SedTokenType.COMMA)) {
            this.advance();
            end = this.parseAddress();
            // If we consumed a comma but have no end address, that's an error
            if (end === undefined) {
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
                    step: token.step || 0,
                };
            case SedTokenType.RELATIVE_OFFSET:
                this.advance();
                return { offset: token.offset || 0 };
            default:
                return undefined;
        }
    }
    peek() {
        return (this.tokens[this.pos] || {
            type: SedTokenType.EOF,
            value: "",
            line: 0,
            column: 0,
        });
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
}
/**
 * Parse multiple sed scripts into a list of commands.
 * This is the main entry point for parsing sed scripts.
 *
 * Also detects #n or #r special comments at the start of the first script:
 * - #n enables silent mode (equivalent to -n flag)
 * - #r enables extended regex mode (equivalent to -r/-E flag)
 *
 * Handles backslash continuation across -e arguments:
 * - If a script ends with \, the next script is treated as continuation
 */
export function parseMultipleScripts(scripts, extendedRegex = false) {
    // Check for #n or #r special comments at the start of the first script
    let silentMode = false;
    let extendedRegexFromComment = false;
    // First, join scripts that have backslash continuation
    // e.g., -e 'a\' -e 'text' becomes 'a\ntext'
    const joinedScripts = [];
    for (let i = 0; i < scripts.length; i++) {
        let script = scripts[i];
        // Handle #n/#r comments in first script
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
        // Check if last script ends with backslash (continuation)
        // For a/i/c commands, the backslash indicates text continues on next line
        // Keep the backslash so the lexer knows to read the text from the next line
        if (joinedScripts.length > 0 &&
            joinedScripts[joinedScripts.length - 1].endsWith("\\")) {
            // Keep trailing backslash and join with newline
            const lastScript = joinedScripts[joinedScripts.length - 1];
            joinedScripts[joinedScripts.length - 1] = `${lastScript}\n${script}`;
        }
        else {
            joinedScripts.push(script);
        }
    }
    // Join all scripts with newlines to form a single script
    // This is necessary for grouped commands { } where { and } may be in different -e arguments
    const combinedScript = joinedScripts.join("\n");
    const parser = new SedParser([combinedScript], extendedRegex || extendedRegexFromComment);
    const result = parser.parse();
    // Validate that all branch targets exist
    if (!result.error && result.commands.length > 0) {
        const labelError = validateLabels(result.commands);
        if (labelError) {
            return {
                commands: [],
                error: labelError,
                silentMode,
                extendedRegexMode: extendedRegexFromComment,
            };
        }
    }
    return {
        ...result,
        silentMode,
        extendedRegexMode: extendedRegexFromComment,
    };
}
/**
 * Validate that all branch targets reference existing labels.
 * Returns an error message if validation fails, undefined otherwise.
 */
function validateLabels(commands) {
    // Collect all defined labels
    const definedLabels = new Set();
    collectLabels(commands, definedLabels);
    // Check all branch commands
    const undefinedLabel = findUndefinedLabel(commands, definedLabels);
    if (undefinedLabel) {
        return `undefined label '${undefinedLabel}'`;
    }
    return undefined;
}
function collectLabels(commands, labels) {
    for (const cmd of commands) {
        if (cmd.type === "label") {
            labels.add(cmd.name);
        }
        else if (cmd.type === "group") {
            collectLabels(cmd.commands, labels);
        }
    }
}
function findUndefinedLabel(commands, definedLabels) {
    for (const cmd of commands) {
        if ((cmd.type === "branch" ||
            cmd.type === "branchOnSubst" ||
            cmd.type === "branchOnNoSubst") &&
            cmd.label &&
            !definedLabels.has(cmd.label)) {
            return cmd.label;
        }
        if (cmd.type === "group") {
            const result = findUndefinedLabel(cmd.commands, definedLabels);
            if (result)
                return result;
        }
    }
    return undefined;
}
