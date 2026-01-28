/**
 * Worker thread for sqlite3 query execution.
 *
 * This isolates potentially long-running queries so they can be
 * terminated if they exceed the timeout.
 *
 * Uses sql.js (WASM-based SQLite) which is fully sandboxed and cannot
 * access the real filesystem.
 */
import { parentPort, workerData } from "node:worker_threads";
import initSqlJs from "sql.js";
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
async function executeQuery(data) {
    let db;
    try {
        const SQL = await initSqlJs();
        if (data.dbBuffer) {
            db = new SQL.Database(data.dbBuffer);
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
        const statements = splitStatements(data.sql);
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
                if (data.options.bail) {
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
// Execute when run as worker
if (parentPort && workerData) {
    executeQuery(workerData).then((result) => {
        parentPort?.postMessage(result);
    });
}
