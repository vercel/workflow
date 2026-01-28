/**
 * sqlite3 - SQLite database CLI
 *
 * Wraps sql.js (WASM) to provide SQLite database access through the virtual filesystem.
 * Databases are loaded from buffers and written back after modifications.
 *
 * Queries run in a worker thread with a timeout to prevent runaway queries
 * (e.g., infinite recursive CTEs) from blocking execution.
 *
 * Security: sql.js is fully sandboxed - it cannot access the real filesystem,
 * making ATTACH DATABASE and VACUUM INTO safe (they only operate on virtual buffers).
 */
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import initSqlJs from "sql.js";
import { hasHelpFlag, showHelp } from "../help.js";
import { formatOutput, } from "./formatters.js";
/** Default query timeout in milliseconds (5 seconds) */
const DEFAULT_QUERY_TIMEOUT_MS = 5000;
const sqlite3Help = {
    name: "sqlite3",
    summary: "SQLite database CLI",
    usage: "sqlite3 [OPTIONS] DATABASE [SQL]",
    options: [
        "-list           output in list mode (default)",
        "-csv            output in CSV mode",
        "-json           output in JSON mode",
        "-line           output in line mode",
        "-column         output in column mode",
        "-table          output as ASCII table",
        "-markdown       output as markdown table",
        "-tabs           output in tab-separated mode",
        "-box            output in Unicode box mode",
        "-quote          output in SQL quote mode",
        "-html           output as HTML table",
        "-ascii          output in ASCII mode (control chars)",
        "-header         show column headers",
        "-noheader       hide column headers",
        "-separator SEP  field separator for list mode (default: |)",
        "-newline SEP    row separator (default: \\n)",
        "-nullvalue TEXT text for NULL values (default: empty)",
        "-readonly       open database read-only (no writeback)",
        "-bail           stop on first error",
        "-echo           print SQL before execution",
        "-cmd COMMAND    run SQL command before main SQL",
        "-version        show SQLite version",
        "--              end of options",
        "--help          show this help",
    ],
    examples: [
        'sqlite3 :memory: "CREATE TABLE t(x); INSERT INTO t VALUES(1); SELECT * FROM t"',
        'sqlite3 -json data.db "SELECT * FROM users"',
        'sqlite3 -csv -header data.db "SELECT id, name FROM products"',
        'sqlite3 -box data.db "SELECT * FROM users"',
    ],
};
function parseArgs(args) {
    const options = {
        mode: "list",
        header: false,
        separator: "|",
        newline: "\n",
        nullValue: "",
        readonly: false,
        bail: false,
        echo: false,
        cmd: null,
    };
    let database = null;
    let sql = null;
    let showVersion = false;
    let endOfOptions = false;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        // After --, treat everything as positional arguments
        if (endOfOptions) {
            if (database === null) {
                database = arg;
            }
            else if (sql === null) {
                sql = arg;
            }
            continue;
        }
        if (arg === "--") {
            endOfOptions = true;
        }
        else if (arg === "-version") {
            showVersion = true;
        }
        else if (arg === "-list")
            options.mode = "list";
        else if (arg === "-csv")
            options.mode = "csv";
        else if (arg === "-json")
            options.mode = "json";
        else if (arg === "-line")
            options.mode = "line";
        else if (arg === "-column")
            options.mode = "column";
        else if (arg === "-table")
            options.mode = "table";
        else if (arg === "-markdown")
            options.mode = "markdown";
        else if (arg === "-tabs")
            options.mode = "tabs";
        else if (arg === "-box")
            options.mode = "box";
        else if (arg === "-quote")
            options.mode = "quote";
        else if (arg === "-html")
            options.mode = "html";
        else if (arg === "-ascii")
            options.mode = "ascii";
        else if (arg === "-header")
            options.header = true;
        else if (arg === "-noheader")
            options.header = false;
        else if (arg === "-readonly")
            options.readonly = true;
        else if (arg === "-bail")
            options.bail = true;
        else if (arg === "-echo")
            options.echo = true;
        else if (arg === "-separator") {
            if (i + 1 >= args.length) {
                return {
                    stdout: "",
                    stderr: "sqlite3: Error: missing argument to -separator\n",
                    exitCode: 1,
                };
            }
            options.separator = args[++i];
        }
        else if (arg === "-newline") {
            if (i + 1 >= args.length) {
                return {
                    stdout: "",
                    stderr: "sqlite3: Error: missing argument to -newline\n",
                    exitCode: 1,
                };
            }
            options.newline = args[++i];
        }
        else if (arg === "-nullvalue") {
            if (i + 1 >= args.length) {
                return {
                    stdout: "",
                    stderr: "sqlite3: Error: missing argument to -nullvalue\n",
                    exitCode: 1,
                };
            }
            options.nullValue = args[++i];
        }
        else if (arg === "-cmd") {
            if (i + 1 >= args.length) {
                return {
                    stdout: "",
                    stderr: "sqlite3: Error: missing argument to -cmd\n",
                    exitCode: 1,
                };
            }
            options.cmd = args[++i];
        }
        else if (arg.startsWith("-")) {
            // Real sqlite3 treats --xyz as -xyz and says "unknown option: -xyz"
            const optName = arg.startsWith("--") ? arg.slice(1) : arg;
            return {
                stdout: "",
                stderr: `sqlite3: Error: unknown option: ${optName}\nUse -help for a list of options.\n`,
                exitCode: 1,
            };
        }
        else if (database === null) {
            database = arg;
        }
        else if (sql === null) {
            sql = arg;
        }
    }
    return { options, database, sql, showVersion };
}
// Get SQLite version from sql.js
async function getSqliteVersion() {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    try {
        const result = db.exec("SELECT sqlite_version()");
        if (result.length > 0 && result[0].values.length > 0) {
            return String(result[0].values[0][0]);
        }
        return "unknown";
    }
    finally {
        db.close();
    }
}
function isWriteStatement(sql) {
    const trimmed = sql.trim().toUpperCase();
    return (trimmed.startsWith("INSERT") ||
        trimmed.startsWith("UPDATE") ||
        trimmed.startsWith("DELETE") ||
        trimmed.startsWith("CREATE") ||
        trimmed.startsWith("DROP") ||
        trimmed.startsWith("ALTER") ||
        trimmed.startsWith("REPLACE") ||
        trimmed.startsWith("VACUUM"));
}
function splitStatements(sql) {
    const statements = [];
    let current = "";
    let inString = false;
    let stringChar = "";
    for (let i = 0; i < sql.length; i++) {
        const char = sql[i];
        if (inString) {
            current += char;
            if (char === stringChar) {
                if (sql[i + 1] === stringChar) {
                    current += sql[++i];
                }
                else {
                    inString = false;
                }
            }
        }
        else if (char === "'" || char === '"') {
            current += char;
            inString = true;
            stringChar = char;
        }
        else if (char === ";") {
            const stmt = current.trim();
            if (stmt)
                statements.push(stmt);
            current = "";
        }
        else {
            current += char;
        }
    }
    const stmt = current.trim();
    if (stmt)
        statements.push(stmt);
    return statements;
}
/**
 * Execute SQL directly (no timeout protection).
 * Used as fallback when worker threads aren't available.
 */
async function executeDirectly(input) {
    let db;
    try {
        const SQL = await initSqlJs();
        if (input.dbBuffer) {
            db = new SQL.Database(input.dbBuffer);
        }
        else {
            db = new SQL.Database();
        }
    }
    catch (e) {
        return { success: false, error: e.message };
    }
    const results = [];
    let hasModifications = false;
    try {
        const statements = splitStatements(input.sql);
        for (const stmt of statements) {
            try {
                if (isWriteStatement(stmt)) {
                    db.run(stmt);
                    hasModifications = true;
                    results.push({ type: "data", columns: [], rows: [] });
                }
                else {
                    // Use prepared statement to get column names even for empty result sets
                    const prepared = db.prepare(stmt);
                    const columns = prepared.getColumnNames();
                    const rows = [];
                    while (prepared.step()) {
                        rows.push(prepared.get());
                    }
                    prepared.free();
                    results.push({ type: "data", columns, rows });
                }
            }
            catch (e) {
                const error = e.message;
                results.push({ type: "error", error });
                if (input.options.bail) {
                    break;
                }
            }
        }
        let resultBuffer = null;
        if (hasModifications) {
            resultBuffer = db.export();
        }
        db.close();
        return { success: true, results, hasModifications, dbBuffer: resultBuffer };
    }
    catch (e) {
        db.close();
        return { success: false, error: e.message };
    }
}
/**
 * Execute SQL in a worker thread with timeout protection.
 * Falls back to direct execution if worker fails to load.
 */
async function executeInWorker(input, timeoutMs) {
    // Try to use worker thread for timeout protection
    try {
        const workerPath = fileURLToPath(new URL("./worker.js", import.meta.url));
        return await new Promise((resolve, reject) => {
            const worker = new Worker(workerPath, {
                workerData: input,
            });
            const timeout = setTimeout(() => {
                worker.terminate();
                resolve({
                    success: false,
                    error: `Query timeout: execution exceeded ${timeoutMs}ms limit`,
                });
            }, timeoutMs);
            worker.on("message", (result) => {
                clearTimeout(timeout);
                resolve(result);
            });
            worker.on("error", (err) => {
                clearTimeout(timeout);
                reject(err);
            });
            worker.on("exit", (code) => {
                clearTimeout(timeout);
                if (code !== 0) {
                    resolve({
                        success: false,
                        error: `Worker exited with code ${code}`,
                    });
                }
            });
        });
    }
    catch {
        // Worker failed to load (e.g., in test environment with TypeScript)
        // Fall back to direct execution (no timeout protection)
        return executeDirectly(input);
    }
}
export const sqlite3Command = {
    name: "sqlite3",
    async execute(args, ctx) {
        // Real sqlite3 accepts both -help and --help
        if (hasHelpFlag(args) || args.includes("-help"))
            return showHelp(sqlite3Help);
        const parsed = parseArgs(args);
        if ("exitCode" in parsed)
            return parsed;
        const { options, database, sql: sqlArg, showVersion } = parsed;
        // Handle -version
        if (showVersion) {
            const version = await getSqliteVersion();
            return {
                stdout: `${version}\n`,
                stderr: "",
                exitCode: 0,
            };
        }
        if (!database) {
            return {
                stdout: "",
                stderr: "sqlite3: missing database argument\n",
                exitCode: 1,
            };
        }
        // Get SQL from argument or stdin, prepend -cmd if provided
        let sql = sqlArg || ctx.stdin.trim();
        if (options.cmd) {
            sql = options.cmd + (sql ? `; ${sql}` : "");
        }
        if (!sql) {
            return {
                stdout: "",
                stderr: "sqlite3: no SQL provided\n",
                exitCode: 1,
            };
        }
        // Load database buffer
        const isMemory = database === ":memory:";
        let dbPath = "";
        let dbBuffer = null;
        try {
            if (!isMemory) {
                dbPath = ctx.fs.resolvePath(ctx.cwd, database);
                if (await ctx.fs.exists(dbPath)) {
                    dbBuffer = await ctx.fs.readFileBuffer(dbPath);
                }
            }
        }
        catch (e) {
            return {
                stdout: "",
                stderr: `sqlite3: unable to open database "${database}": ${e.message}\n`,
                exitCode: 1,
            };
        }
        // Get timeout from execution limits or use default
        const timeoutMs = ctx.limits?.maxSqliteTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
        // Execute in worker with timeout
        const workerInput = {
            dbBuffer,
            sql,
            options: {
                bail: options.bail,
                echo: options.echo,
            },
        };
        let result;
        try {
            result = await executeInWorker(workerInput, timeoutMs);
        }
        catch (e) {
            return {
                stdout: "",
                stderr: `sqlite3: worker error: ${e.message}\n`,
                exitCode: 1,
            };
        }
        if (!result.success) {
            return {
                stdout: "",
                stderr: `sqlite3: ${result.error}\n`,
                exitCode: 1,
            };
        }
        // Format output
        const formatOptions = {
            mode: options.mode,
            header: options.header,
            separator: options.separator,
            newline: options.newline,
            nullValue: options.nullValue,
        };
        let stdout = "";
        // Echo SQL if requested
        if (options.echo) {
            stdout += `${sql}\n`;
        }
        // Process results
        let hadError = false;
        for (const stmtResult of result.results) {
            if (stmtResult.type === "error") {
                if (options.bail) {
                    return {
                        stdout,
                        stderr: `Error: ${stmtResult.error}\n`,
                        exitCode: 1,
                    };
                }
                stdout += `Error: ${stmtResult.error}\n`;
                hadError = true;
            }
            else if (stmtResult.columns && stmtResult.rows) {
                if (stmtResult.rows.length > 0 || options.header) {
                    stdout += formatOutput(stmtResult.columns, stmtResult.rows, formatOptions);
                }
            }
        }
        // Write back modifications if needed
        if (result.hasModifications &&
            !options.readonly &&
            !isMemory &&
            dbPath &&
            result.dbBuffer) {
            try {
                await ctx.fs.writeFile(dbPath, result.dbBuffer);
            }
            catch (e) {
                return {
                    stdout,
                    stderr: `sqlite3: failed to write database: ${e.message}\n`,
                    exitCode: 1,
                };
            }
        }
        return { stdout, stderr: "", exitCode: hadError && options.bail ? 1 : 0 };
    },
};
