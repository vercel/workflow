/**
 * Bash - Bash Shell Environment
 *
 * A complete bash-like shell environment using a proper AST-based architecture:
 *   Input → Parser → AST → Interpreter → Output
 *
 * This class provides the shell environment (filesystem, commands, variables)
 * and delegates execution to the Interpreter.
 */
import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";
import { createLazyCommands, createNetworkCommands, } from "./commands/registry.js";
import { createLazyCustomCommand, isLazyCommand, } from "./custom-commands.js";
import { InMemoryFs } from "./fs/in-memory-fs/in-memory-fs.js";
import { initFilesystem } from "./fs/init.js";
import { ArithmeticError, ExecutionLimitError, ExitError, PosixFatalError, } from "./interpreter/errors.js";
import { buildBashopts, buildShellopts, } from "./interpreter/helpers/shellopts.js";
import { Interpreter, } from "./interpreter/index.js";
import { resolveLimits } from "./limits.js";
import { createSecureFetch, } from "./network/index.js";
import { LexerError } from "./parser/lexer.js";
import { parse } from "./parser/parser.js";
export class Bash {
    fs;
    commands = new Map();
    useDefaultLayout = false;
    limits;
    secureFetch;
    sleepFn;
    traceFn;
    logger;
    // Interpreter state (shared with interpreter instances)
    state;
    constructor(options = {}) {
        const fs = options.fs ?? new InMemoryFs(options.files);
        this.fs = fs;
        this.useDefaultLayout = !options.cwd && !options.files;
        const cwd = options.cwd || (this.useDefaultLayout ? "/home/user" : "/");
        const env = {
            HOME: this.useDefaultLayout ? "/home/user" : "/",
            PATH: "/usr/bin:/bin",
            IFS: " \t\n",
            OSTYPE: "linux-gnu",
            MACHTYPE: "x86_64-pc-linux-gnu",
            HOSTTYPE: "x86_64",
            HOSTNAME: "localhost", // Match hostname command in sandboxed environment
            PWD: cwd,
            OLDPWD: cwd,
            OPTIND: "1", // getopts option index
            ...options.env,
        };
        // Resolve limits: new executionLimits takes precedence, then deprecated individual options
        this.limits = resolveLimits({
            ...options.executionLimits,
            // Support deprecated individual options (they override executionLimits if set)
            ...(options.maxCallDepth !== undefined && {
                maxCallDepth: options.maxCallDepth,
            }),
            ...(options.maxCommandCount !== undefined && {
                maxCommandCount: options.maxCommandCount,
            }),
            ...(options.maxLoopIterations !== undefined && {
                maxLoopIterations: options.maxLoopIterations,
            }),
        });
        // Create secure fetch if network is configured
        if (options.network) {
            this.secureFetch = createSecureFetch(options.network);
        }
        // Store sleep function if provided (for mock clocks in testing)
        this.sleepFn = options.sleep;
        // Store trace callback if provided (for performance profiling)
        this.traceFn = options.trace;
        // Store logger if provided
        this.logger = options.logger;
        // Initialize interpreter state
        this.state = {
            env,
            cwd,
            previousDir: "/home/user",
            functions: new Map(),
            localScopes: [],
            callDepth: 0,
            sourceDepth: 0,
            commandCount: 0,
            lastExitCode: 0,
            lastArg: "", // $_ is initially empty (or could be shell name)
            startTime: Date.now(),
            lastBackgroundPid: 0,
            bashPid: process.pid, // BASHPID starts as the main process PID
            nextVirtualPid: process.pid + 1, // Counter for unique subshell PIDs
            currentLine: 1, // $LINENO starts at 1
            options: {
                errexit: false,
                pipefail: false,
                nounset: false,
                xtrace: false,
                verbose: false,
                posix: false,
                allexport: false,
                noclobber: false,
                noglob: false,
                noexec: false,
                vi: false,
                emacs: false,
            },
            shoptOptions: {
                extglob: false,
                dotglob: false,
                nullglob: false,
                failglob: false,
                globstar: false,
                globskipdots: true, // Default to true in bash >=5.2
                nocaseglob: false,
                nocasematch: false,
                expand_aliases: false,
                lastpipe: false,
                xpg_echo: false,
            },
            inCondition: false,
            loopDepth: 0,
            // Export standard shell variables by default (matches bash behavior)
            // These variables are typically inherited from the parent shell environment
            exportedVars: new Set([
                "HOME",
                "PATH",
                "PWD",
                "OLDPWD",
                // Also export any user-provided environment variables
                ...Object.keys(options.env || {}),
            ]),
            // SHELLOPTS and BASHOPTS are readonly
            readonlyVars: new Set(["SHELLOPTS", "BASHOPTS"]),
            // Hash table for PATH command lookup caching
            hashTable: new Map(),
        };
        // Initialize SHELLOPTS to reflect current shell options (initially empty string since all are false)
        this.state.env.SHELLOPTS = buildShellopts(this.state.options);
        // Initialize BASHOPTS to reflect current shopt options
        this.state.env.BASHOPTS = buildBashopts(this.state.shoptOptions);
        // Initialize filesystem with standard directories and device files
        // Only applies to InMemoryFs - other filesystems use real directories
        initFilesystem(fs, this.useDefaultLayout);
        if (cwd !== "/" && fs instanceof InMemoryFs) {
            try {
                fs.mkdirSync(cwd, { recursive: true });
            }
            catch {
                // Ignore errors
            }
        }
        // Register all commands
        for (const cmd of createLazyCommands(options.commands)) {
            this.registerCommand(cmd);
        }
        // Register network commands only when network is configured
        if (options.network) {
            for (const cmd of createNetworkCommands()) {
                this.registerCommand(cmd);
            }
        }
        // Register custom commands (after built-ins so they can override)
        if (options.customCommands) {
            for (const cmd of options.customCommands) {
                if (isLazyCommand(cmd)) {
                    this.registerCommand(createLazyCustomCommand(cmd));
                }
                else {
                    this.registerCommand(cmd);
                }
            }
        }
    }
    // ===========================================================================
    // Workflow Serde Support
    // ===========================================================================
    /**
     * Serialize Bash instance for Workflow DevKit.
     * Serializes filesystem and interpreter state. Callbacks (logger, trace, sleep,
     * secureFetch) and custom commands are NOT serialized - re-register after deserialize.
     */
    static [WORKFLOW_SERIALIZE](instance) {
        return {
            fs: instance.fs,
            state: instance.state,
            limits: instance.limits,
        };
    }
    /**
     * Deserialize Bash instance for Workflow DevKit.
     * Note: Only works with InMemoryFs. Callbacks must be re-configured after deserialize.
     */
    static [WORKFLOW_DESERIALIZE](serialized) {
        // Create a minimal Bash instance with the deserialized filesystem
        const bash = new Bash({ fs: serialized.fs });
        // Restore state and limits
        bash.state = serialized.state;
        bash.limits = serialized.limits;
        return bash;
    }
    registerCommand(command) {
        this.commands.set(command.name, command);
        // Create command stubs in /bin and /usr/bin for PATH-based resolution
        // Works for both InMemoryFs and OverlayFs (both have writeFileSync)
        // Commands are registered to both locations like real Linux systems
        // (where /bin is often a symlink to /usr/bin on modern systems)
        const fs = this.fs;
        if (typeof fs.writeFileSync === "function") {
            const stub = `#!/bin/bash\n# Built-in command: ${command.name}\n`;
            try {
                fs.writeFileSync(`/bin/${command.name}`, stub);
            }
            catch {
                // Ignore errors
            }
            try {
                fs.writeFileSync(`/usr/bin/${command.name}`, stub);
            }
            catch {
                // Ignore errors
            }
        }
    }
    logResult(result) {
        if (this.logger) {
            if (result.stdout) {
                this.logger.debug("stdout", { output: result.stdout });
            }
            if (result.stderr) {
                this.logger.info("stderr", { output: result.stderr });
            }
            this.logger.info("exit", { exitCode: result.exitCode });
        }
        return result;
    }
    async exec(commandLine, options) {
        if (this.state.callDepth === 0) {
            this.state.commandCount = 0;
        }
        this.state.commandCount++;
        if (this.state.commandCount > this.limits.maxCommandCount) {
            return {
                stdout: "",
                stderr: `bash: maximum command count (${this.limits.maxCommandCount}) exceeded (possible infinite loop). Increase with executionLimits.maxCommandCount option.\n`,
                exitCode: 1,
                env: { ...this.state.env, ...options?.env },
            };
        }
        if (!commandLine.trim()) {
            return {
                stdout: "",
                stderr: "",
                exitCode: 0,
                env: { ...this.state.env, ...options?.env },
            };
        }
        // Log command execution
        this.logger?.info("exec", { command: commandLine });
        // Each exec call gets an isolated state copy - like starting a new shell
        // This ensures exec calls never interfere with each other
        const effectiveCwd = options?.cwd ?? this.state.cwd;
        // Determine PWD and cwd for the new shell context
        // If PWD is in the provided env, use it (inherited from parent)
        // If PWD is NOT in the provided env (was unset), use realpath to get physical path
        // This matches bash behavior: when PWD is unset and a new shell starts,
        // it initializes PWD (and cwd) using realpath (resolving symlinks)
        let newPwd;
        let newCwd = effectiveCwd;
        if (options?.cwd) {
            if (options.env && "PWD" in options.env) {
                // PWD explicitly provided - use it
                newPwd = options.env.PWD;
            }
            else if (options?.env && !("PWD" in options.env)) {
                // PWD not in provided env - use realpath to resolve symlinks
                // This also updates cwd since the shell determines its position from scratch
                try {
                    newPwd = await this.fs.realpath(effectiveCwd);
                    newCwd = newPwd; // Both PWD and cwd should be the physical path
                }
                catch {
                    // Fallback to logical path if realpath fails
                    newPwd = effectiveCwd;
                }
            }
            else {
                // No env provided - use logical cwd
                newPwd = effectiveCwd;
            }
        }
        const execState = {
            ...this.state,
            env: {
                ...this.state.env,
                ...options?.env,
                // Update PWD when cwd option is provided
                ...(newPwd !== undefined ? { PWD: newPwd } : {}),
            },
            cwd: newCwd,
            // Deep copy mutable objects to prevent interference
            functions: new Map(this.state.functions),
            localScopes: [...this.state.localScopes],
            options: { ...this.state.options },
            // Share hashTable reference - it should persist across exec calls
            hashTable: this.state.hashTable,
        };
        // Normalize indented multi-line scripts (unless rawScript is true)
        // This allows writing indented bash scripts in template literals
        // BUT we must preserve whitespace inside heredoc content
        let normalized = commandLine;
        if (!options?.rawScript) {
            normalized = normalizeScript(commandLine);
        }
        try {
            const ast = parse(normalized);
            // Create interpreter with appropriate state
            const interpreterOptions = {
                fs: this.fs,
                commands: this.commands,
                limits: this.limits,
                exec: this.exec.bind(this),
                fetch: this.secureFetch,
                sleep: this.sleepFn,
                trace: this.traceFn,
            };
            const interpreter = new Interpreter(interpreterOptions, execState);
            const result = await interpreter.executeScript(ast);
            // Interpreter always sets env, assert it for type safety
            return this.logResult(result);
        }
        catch (error) {
            // ExitError propagates from 'exit' builtin (including via eval/source)
            if (error instanceof ExitError) {
                return this.logResult({
                    stdout: error.stdout,
                    stderr: error.stderr,
                    exitCode: error.exitCode,
                    env: { ...this.state.env, ...options?.env },
                });
            }
            // PosixFatalError propagates from special builtins in POSIX mode
            if (error instanceof PosixFatalError) {
                return this.logResult({
                    stdout: error.stdout,
                    stderr: error.stderr,
                    exitCode: error.exitCode,
                    env: { ...this.state.env, ...options?.env },
                });
            }
            if (error instanceof ArithmeticError) {
                return this.logResult({
                    stdout: error.stdout,
                    stderr: error.stderr,
                    exitCode: 1,
                    env: { ...this.state.env, ...options?.env },
                });
            }
            // ExecutionLimitError is thrown when our conservative limits are exceeded
            // (command count, recursion depth, loop iterations)
            if (error instanceof ExecutionLimitError) {
                return this.logResult({
                    stdout: error.stdout,
                    stderr: error.stderr,
                    exitCode: ExecutionLimitError.EXIT_CODE,
                    env: { ...this.state.env, ...options?.env },
                });
            }
            if (error.name === "ParseException") {
                return this.logResult({
                    stdout: "",
                    stderr: `bash: syntax error: ${error.message}\n`,
                    exitCode: 2,
                    env: { ...this.state.env, ...options?.env },
                });
            }
            // LexerError is thrown for lexer-level issues like unterminated quotes
            if (error instanceof LexerError) {
                return this.logResult({
                    stdout: "",
                    stderr: `bash: ${error.message}\n`,
                    exitCode: 2,
                    env: { ...this.state.env, ...options?.env },
                });
            }
            // RangeError occurs when JavaScript call stack is exceeded (deep recursion)
            if (error instanceof RangeError) {
                return this.logResult({
                    stdout: "",
                    stderr: `bash: ${error.message}\n`,
                    exitCode: 1,
                    env: { ...this.state.env, ...options?.env },
                });
            }
            throw error;
        }
    }
    // ===========================================================================
    // PUBLIC API
    // ===========================================================================
    async readFile(path) {
        return this.fs.readFile(this.fs.resolvePath(this.state.cwd, path));
    }
    async writeFile(path, content) {
        return this.fs.writeFile(this.fs.resolvePath(this.state.cwd, path), content);
    }
    getCwd() {
        return this.state.cwd;
    }
    getEnv() {
        return { ...this.state.env };
    }
}
/**
 * Normalize a script by stripping leading whitespace from lines,
 * while preserving whitespace inside heredoc content.
 *
 * This allows writing indented bash scripts in template literals:
 * ```
 * await bash.exec(`
 *   if [ -f foo ]; then
 *     echo "yes"
 *   fi
 * `);
 * ```
 *
 * Heredocs are detected by looking for << or <<- operators and their delimiters.
 */
function normalizeScript(script) {
    const lines = script.split("\n");
    const result = [];
    // Stack of pending heredoc delimiters (for nested heredocs)
    const pendingDelimiters = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // If we're inside a heredoc, check if this line ends it
        if (pendingDelimiters.length > 0) {
            const current = pendingDelimiters[pendingDelimiters.length - 1];
            // For <<-, strip leading tabs when checking delimiter
            // For <<, require exact match (no leading whitespace allowed)
            const lineToCheck = current.stripTabs ? line.replace(/^\t+/, "") : line;
            if (lineToCheck === current.delimiter) {
                // End of heredoc - this line can be normalized
                result.push(line.trimStart());
                pendingDelimiters.pop();
                continue;
            }
            // Inside heredoc - preserve the line exactly as-is
            result.push(line);
            continue;
        }
        // Not inside a heredoc - normalize the line and check for heredoc starts
        const normalizedLine = line.trimStart();
        result.push(normalizedLine);
        // Check for heredoc operators in this line
        // Match: <<DELIM, <<-DELIM, << 'DELIM', <<- "DELIM", etc.
        // Multiple heredocs on one line are possible: cmd <<EOF1 <<EOF2
        const heredocPattern = /<<(-?)\s*(['"]?)([\w-]+)\2/g;
        for (const match of normalizedLine.matchAll(heredocPattern)) {
            const stripTabs = match[1] === "-";
            const delimiter = match[3];
            pendingDelimiters.push({ delimiter, stripTabs });
        }
    }
    return result.join("\n");
}
