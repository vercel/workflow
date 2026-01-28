/**
 * whoami - print effective user name
 *
 * Usage: whoami
 *
 * In sandboxed environment, always returns "user".
 */
async function whoamiExecute(_args, _ctx) {
    // In sandboxed environment, always return "user"
    return { stdout: "user\n", stderr: "", exitCode: 0 };
}
export const whoami = {
    name: "whoami",
    execute: whoamiExecute,
};
