import { h as hasHelpFlag, s as showHelp } from "./chunk-HAN5425M.mjs";
import { _ as __name } from "../index.mjs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { i as initSqlJs } from "./_libs/sql.js.mjs";
import "./_libs/@vercel/functions.mjs";
import "../_libs/srvx.mjs";
import "node:http";
import "node:stream";
import "node:https";
import "node:http2";
import "../_libs/h3.mjs";
import "../_libs/rou3.mjs";
import "../_libs/ms.mjs";
import "./_libs/@mongodb-js/zstd.mjs";
import "util";
import "util/types";
import "../_libs/ulid.mjs";
import "node:crypto";
import "node:module";
import "node:path";
import "node:child_process";
import "node:fs/promises";
import "node:util";
import "node:timers/promises";
import "./_libs/@vercel/queue.mjs";
import "../_libs/mixpart.mjs";
import "./_libs/@vercel/oidc.mjs";
import "path";
import "fs";
import "os";
import "./_libs/async-sema.mjs";
import "events";
import "./_libs/undici.mjs";
import "node:assert";
import "node:net";
import "node:buffer";
import "node:querystring";
import "node:events";
import "node:diagnostics_channel";
import "node:tls";
import "node:zlib";
import "node:perf_hooks";
import "node:util/types";
import "node:async_hooks";
import "node:console";
import "node:dns";
import "string_decoder";
import "../_libs/zod.mjs";
import "node:fs";
import "node:os";
import "../_libs/cbor-x.mjs";
import "../_libs/devalue.mjs";
import "./_libs/debug.mjs";
import "tty";
import "../_libs/supports-color.mjs";
import "../_libs/has-flag.mjs";
import "./_libs/@jridgewell/trace-mapping.mjs";
import "./_libs/@jridgewell/sourcemap-codec.mjs";
import "./_libs/@jridgewell/resolve-uri.mjs";
import "node:vm";
import "../_libs/nanoid.mjs";
import "../_libs/seedrandom.mjs";
import "../_libs/ufo.mjs";
import "crypto";
function formatOutput(columns, rows, options) {
  switch (options.mode) {
    case "list":
      return formatList(columns, rows, options);
    case "csv":
      return formatCsv(columns, rows, options);
    case "json":
      return formatJson(columns, rows);
    case "line":
      return formatLine(columns, rows, options);
    case "column":
      return formatColumn(columns, rows, options);
    case "table":
      return formatTable(columns, rows, options);
    case "markdown":
      return formatMarkdown(columns, rows, options);
    case "tabs":
      return formatTabs(columns, rows, options);
    case "box":
      return formatBox(columns, rows, options);
    case "quote":
      return formatQuote(columns, rows, options);
    case "html":
      return formatHtml(columns, rows, options);
    case "ascii":
      return formatAscii(columns, rows, options);
  }
}
__name(formatOutput, "formatOutput");
function valueToString(value, nullValue) {
  if (value === null || value === void 0)
    return nullValue;
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return Buffer.from(value).toString("utf8");
  }
  if (typeof value === "number" && !Number.isInteger(value)) {
    return value.toPrecision(17).replace(/\.?0+$/, "");
  }
  return String(value);
}
__name(valueToString, "valueToString");
function formatList(columns, rows, options) {
  const lines = [];
  if (options.header && columns.length > 0) {
    lines.push(columns.join(options.separator));
  }
  for (const row of rows) {
    lines.push(row.map((v) => valueToString(v, options.nullValue)).join(options.separator));
  }
  return lines.length > 0 ? `${lines.join(options.newline)}${options.newline}` : "";
}
__name(formatList, "formatList");
function formatCsv(columns, rows, options) {
  const lines = [];
  if (options.header && columns.length > 0) {
    lines.push(columns.map(escapeCsvField).join(","));
  }
  for (const row of rows) {
    lines.push(row.map((v) => escapeCsvField(valueToString(v, options.nullValue))).join(","));
  }
  return lines.length > 0 ? `${lines.join("\n")}
` : "";
}
__name(formatCsv, "formatCsv");
function escapeCsvField(value) {
  if (value.includes(",") || value.includes('"') || value.includes("'") || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
__name(escapeCsvField, "escapeCsvField");
function floatToFullPrecision(value) {
  return value.toPrecision(17).replace(/\.?0+$/, "");
}
__name(floatToFullPrecision, "floatToFullPrecision");
function valueToJson(value) {
  if (value === null)
    return "null";
  if (typeof value === "number") {
    if (Number.isInteger(value))
      return String(value);
    return floatToFullPrecision(value);
  }
  if (typeof value === "string")
    return JSON.stringify(value);
  return JSON.stringify(value);
}
__name(valueToJson, "valueToJson");
function formatJson(columns, rows) {
  if (rows.length === 0)
    return "";
  const objects = rows.map((row) => {
    const pairs = columns.map((col, i) => `${JSON.stringify(col)}:${valueToJson(row[i])}`);
    return `{${pairs.join(",")}}`;
  });
  return `[${objects.join(",\n")}]
`;
}
__name(formatJson, "formatJson");
function formatLine(columns, rows, options) {
  if (columns.length === 0 || rows.length === 0)
    return "";
  const maxColLen = Math.max(5, ...columns.map((c) => c.length));
  const lines = [];
  for (const row of rows) {
    for (let i = 0; i < columns.length; i++) {
      const paddedCol = columns[i].padStart(maxColLen);
      lines.push(`${paddedCol} = ${valueToString(row[i], options.nullValue)}`);
    }
  }
  return `${lines.join("\n")}
`;
}
__name(formatLine, "formatLine");
function formatColumn(columns, rows, options) {
  if (columns.length === 0)
    return "";
  const widths = columns.map((c) => c.length);
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      const len = valueToString(row[i], options.nullValue).length;
      if (len > widths[i])
        widths[i] = len;
    }
  }
  const lines = [];
  if (options.header) {
    lines.push(columns.map((c, i) => c.padEnd(widths[i])).join("  "));
    lines.push(widths.map((w) => "-".repeat(w)).join("  "));
  }
  for (const row of rows) {
    lines.push(row.map((v, i) => valueToString(v, options.nullValue).padEnd(widths[i])).join("  "));
  }
  return lines.length > 0 ? `${lines.join("\n")}
` : "";
}
__name(formatColumn, "formatColumn");
function formatTable(columns, rows, options) {
  if (columns.length === 0)
    return "";
  const widths = columns.map((c) => c.length);
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      const len = valueToString(row[i], options.nullValue).length;
      if (len > widths[i])
        widths[i] = len;
    }
  }
  const lines = [];
  const border = `+${widths.map((w) => "-".repeat(w + 2)).join("+")}+`;
  lines.push(border);
  if (options.header) {
    lines.push(`| ${columns.map((c, i) => c.padEnd(widths[i])).join(" | ")} |`);
    lines.push(border);
  }
  for (const row of rows) {
    lines.push(`| ${row.map((v, i) => valueToString(v, options.nullValue).padEnd(widths[i])).join(" | ")} |`);
  }
  lines.push(border);
  return `${lines.join("\n")}
`;
}
__name(formatTable, "formatTable");
function formatMarkdown(columns, rows, options) {
  if (columns.length === 0)
    return "";
  const lines = [];
  if (options.header) {
    lines.push(`| ${columns.join(" | ")} |`);
    lines.push(`|${columns.map(() => "---").join("|")}|`);
  }
  for (const row of rows) {
    lines.push(`| ${row.map((v) => valueToString(v, options.nullValue)).join(" | ")} |`);
  }
  return lines.length > 0 ? `${lines.join("\n")}
` : "";
}
__name(formatMarkdown, "formatMarkdown");
function formatTabs(columns, rows, options) {
  const lines = [];
  if (options.header && columns.length > 0) {
    lines.push(columns.join("	"));
  }
  for (const row of rows) {
    lines.push(row.map((v) => valueToString(v, options.nullValue)).join("	"));
  }
  return lines.length > 0 ? `${lines.join(options.newline)}${options.newline}` : "";
}
__name(formatTabs, "formatTabs");
function formatBox(columns, rows, options) {
  if (columns.length === 0)
    return "";
  const widths = columns.map((c) => c.length);
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      const len = valueToString(row[i], options.nullValue).length;
      if (len > widths[i])
        widths[i] = len;
    }
  }
  const lines = [];
  lines.push(`┌${widths.map((w) => "─".repeat(w + 2)).join("┬")}┐`);
  lines.push(`│ ${columns.map((c, i) => c.padEnd(widths[i])).join(" │ ")} │`);
  lines.push(`├${widths.map((w) => "─".repeat(w + 2)).join("┼")}┤`);
  for (const row of rows) {
    lines.push(`│ ${row.map((v, i) => valueToString(v, options.nullValue).padEnd(widths[i])).join(" │ ")} │`);
  }
  lines.push(`└${widths.map((w) => "─".repeat(w + 2)).join("┴")}┘`);
  return `${lines.join("\n")}
`;
}
__name(formatBox, "formatBox");
function formatQuote(columns, rows, options) {
  const lines = [];
  if (options.header && columns.length > 0) {
    lines.push(columns.map((c) => `'${c}'`).join(","));
  }
  for (const row of rows) {
    lines.push(row.map((v) => {
      if (v === null || v === void 0)
        return "NULL";
      if (typeof v === "number") {
        if (Number.isInteger(v))
          return String(v);
        return floatToFullPrecision(v);
      }
      return `'${String(v)}'`;
    }).join(","));
  }
  return lines.length > 0 ? `${lines.join(options.newline)}${options.newline}` : "";
}
__name(formatQuote, "formatQuote");
function formatHtml(columns, rows, options) {
  const lines = [];
  if (options.header && columns.length > 0) {
    lines.push(`<TR>${columns.map((c) => `<TH>${escapeHtml(c)}</TH>`).join("")}`);
    lines.push("</TR>");
  }
  for (const row of rows) {
    lines.push(`<TR>${row.map((v) => `<TD>${escapeHtml(valueToString(v, options.nullValue))}</TD>`).join("")}`);
    lines.push("</TR>");
  }
  return lines.length > 0 ? `${lines.join("\n")}
` : "";
}
__name(formatHtml, "formatHtml");
function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
__name(escapeHtml, "escapeHtml");
function formatAscii(columns, rows, options) {
  const colSep = String.fromCharCode(31);
  const rowSep = String.fromCharCode(30);
  const lines = [];
  if (options.header && columns.length > 0) {
    lines.push(columns.join(colSep));
  }
  for (const row of rows) {
    lines.push(row.map((v) => valueToString(v, options.nullValue)).join(colSep));
  }
  return lines.length > 0 ? lines.join(rowSep) + rowSep : "";
}
__name(formatAscii, "formatAscii");
var DEFAULT_QUERY_TIMEOUT_MS = 5e3;
var sqlite3Help = {
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
    "--help          show this help"
  ],
  examples: [
    'sqlite3 :memory: "CREATE TABLE t(x); INSERT INTO t VALUES(1); SELECT * FROM t"',
    'sqlite3 -json data.db "SELECT * FROM users"',
    'sqlite3 -csv -header data.db "SELECT id, name FROM products"',
    'sqlite3 -box data.db "SELECT * FROM users"'
  ]
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
    cmd: null
  };
  let database = null;
  let sql = null;
  let showVersion = false;
  let endOfOptions = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (endOfOptions) {
      if (database === null) {
        database = arg;
      } else if (sql === null) {
        sql = arg;
      }
      continue;
    }
    if (arg === "--") {
      endOfOptions = true;
    } else if (arg === "-version") {
      showVersion = true;
    } else if (arg === "-list")
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
          exitCode: 1
        };
      }
      options.separator = args[++i];
    } else if (arg === "-newline") {
      if (i + 1 >= args.length) {
        return {
          stdout: "",
          stderr: "sqlite3: Error: missing argument to -newline\n",
          exitCode: 1
        };
      }
      options.newline = args[++i];
    } else if (arg === "-nullvalue") {
      if (i + 1 >= args.length) {
        return {
          stdout: "",
          stderr: "sqlite3: Error: missing argument to -nullvalue\n",
          exitCode: 1
        };
      }
      options.nullValue = args[++i];
    } else if (arg === "-cmd") {
      if (i + 1 >= args.length) {
        return {
          stdout: "",
          stderr: "sqlite3: Error: missing argument to -cmd\n",
          exitCode: 1
        };
      }
      options.cmd = args[++i];
    } else if (arg.startsWith("-")) {
      const optName = arg.startsWith("--") ? arg.slice(1) : arg;
      return {
        stdout: "",
        stderr: `sqlite3: Error: unknown option: ${optName}
Use -help for a list of options.
`,
        exitCode: 1
      };
    } else if (database === null) {
      database = arg;
    } else if (sql === null) {
      sql = arg;
    }
  }
  return { options, database, sql, showVersion };
}
__name(parseArgs, "parseArgs");
async function getSqliteVersion() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  try {
    const result = db.exec("SELECT sqlite_version()");
    if (result.length > 0 && result[0].values.length > 0) {
      return String(result[0].values[0][0]);
    }
    return "unknown";
  } finally {
    db.close();
  }
}
__name(getSqliteVersion, "getSqliteVersion");
function isWriteStatement(sql) {
  const trimmed = sql.trim().toUpperCase();
  return trimmed.startsWith("INSERT") || trimmed.startsWith("UPDATE") || trimmed.startsWith("DELETE") || trimmed.startsWith("CREATE") || trimmed.startsWith("DROP") || trimmed.startsWith("ALTER") || trimmed.startsWith("REPLACE") || trimmed.startsWith("VACUUM");
}
__name(isWriteStatement, "isWriteStatement");
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
        } else {
          inString = false;
        }
      }
    } else if (char === "'" || char === '"') {
      current += char;
      inString = true;
      stringChar = char;
    } else if (char === ";") {
      const stmt2 = current.trim();
      if (stmt2)
        statements.push(stmt2);
      current = "";
    } else {
      current += char;
    }
  }
  const stmt = current.trim();
  if (stmt)
    statements.push(stmt);
  return statements;
}
__name(splitStatements, "splitStatements");
async function executeDirectly(input) {
  let db;
  try {
    const SQL = await initSqlJs();
    if (input.dbBuffer) {
      db = new SQL.Database(input.dbBuffer);
    } else {
      db = new SQL.Database();
    }
  } catch (e) {
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
        } else {
          const prepared = db.prepare(stmt);
          const columns = prepared.getColumnNames();
          const rows = [];
          while (prepared.step()) {
            rows.push(prepared.get());
          }
          prepared.free();
          results.push({ type: "data", columns, rows });
        }
      } catch (e) {
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
  } catch (e) {
    db.close();
    return { success: false, error: e.message };
  }
}
__name(executeDirectly, "executeDirectly");
async function executeInWorker(input, timeoutMs) {
  try {
    const workerPath = fileURLToPath(new URL("./worker.js", import.meta.url));
    return await new Promise((resolve, reject) => {
      const worker = new Worker(workerPath, {
        workerData: input
      });
      const timeout = setTimeout(() => {
        worker.terminate();
        resolve({
          success: false,
          error: `Query timeout: execution exceeded ${timeoutMs}ms limit`
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
            error: `Worker exited with code ${code}`
          });
        }
      });
    });
  } catch {
    return executeDirectly(input);
  }
}
__name(executeInWorker, "executeInWorker");
var sqlite3Command = {
  name: "sqlite3",
  async execute(args, ctx) {
    if (hasHelpFlag(args) || args.includes("-help"))
      return showHelp(sqlite3Help);
    const parsed = parseArgs(args);
    if ("exitCode" in parsed)
      return parsed;
    const { options, database, sql: sqlArg, showVersion } = parsed;
    if (showVersion) {
      const version = await getSqliteVersion();
      return {
        stdout: `${version}
`,
        stderr: "",
        exitCode: 0
      };
    }
    if (!database) {
      return {
        stdout: "",
        stderr: "sqlite3: missing database argument\n",
        exitCode: 1
      };
    }
    let sql = sqlArg || ctx.stdin.trim();
    if (options.cmd) {
      sql = options.cmd + (sql ? `; ${sql}` : "");
    }
    if (!sql) {
      return {
        stdout: "",
        stderr: "sqlite3: no SQL provided\n",
        exitCode: 1
      };
    }
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
    } catch (e) {
      return {
        stdout: "",
        stderr: `sqlite3: unable to open database "${database}": ${e.message}
`,
        exitCode: 1
      };
    }
    const timeoutMs = ctx.limits?.maxSqliteTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
    const workerInput = {
      dbBuffer,
      sql,
      options: {
        bail: options.bail,
        echo: options.echo
      }
    };
    let result;
    try {
      result = await executeInWorker(workerInput, timeoutMs);
    } catch (e) {
      return {
        stdout: "",
        stderr: `sqlite3: worker error: ${e.message}
`,
        exitCode: 1
      };
    }
    if (!result.success) {
      return {
        stdout: "",
        stderr: `sqlite3: ${result.error}
`,
        exitCode: 1
      };
    }
    const formatOptions = {
      mode: options.mode,
      header: options.header,
      separator: options.separator,
      newline: options.newline,
      nullValue: options.nullValue
    };
    let stdout = "";
    if (options.echo) {
      stdout += `${sql}
`;
    }
    let hadError = false;
    for (const stmtResult of result.results) {
      if (stmtResult.type === "error") {
        if (options.bail) {
          return {
            stdout,
            stderr: `Error: ${stmtResult.error}
`,
            exitCode: 1
          };
        }
        stdout += `Error: ${stmtResult.error}
`;
        hadError = true;
      } else if (stmtResult.columns && stmtResult.rows) {
        if (stmtResult.rows.length > 0 || options.header) {
          stdout += formatOutput(stmtResult.columns, stmtResult.rows, formatOptions);
        }
      }
    }
    if (result.hasModifications && !options.readonly && !isMemory && dbPath && result.dbBuffer) {
      try {
        await ctx.fs.writeFile(dbPath, result.dbBuffer);
      } catch (e) {
        return {
          stdout,
          stderr: `sqlite3: failed to write database: ${e.message}
`,
          exitCode: 1
        };
      }
    }
    return { stdout, stderr: "", exitCode: hadError && options.bail ? 1 : 0 };
  }
};
export {
  sqlite3Command
};
