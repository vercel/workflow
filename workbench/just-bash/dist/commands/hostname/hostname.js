/**
 * hostname - show or set the system's host name
 *
 * Usage: hostname [NAME]
 *
 * In sandboxed environment, always returns "localhost".
 */
async function hostnameExecute(_args, _ctx) {
    // In sandboxed environment, always return "localhost"
    return { stdout: "localhost\n", stderr: "", exitCode: 0 };
}
export const hostname = {
    name: "hostname",
    execute: hostnameExecute,
};
