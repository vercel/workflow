/**
 * Custom Commands API
 *
 * Provides types and utilities for registering user-provided TypeScript commands.
 */
/**
 * Type guard to check if a custom command is lazy-loaded.
 */
export function isLazyCommand(cmd) {
    return "load" in cmd && typeof cmd.load === "function";
}
/**
 * Define a TypeScript command with type inference.
 * Convenience wrapper - you can also just use the Command interface directly.
 *
 * @example
 * ```ts
 * const hello = defineCommand("hello", async (args, ctx) => {
 *   const name = args[0] || "world";
 *   return { stdout: `Hello, ${name}!\n`, stderr: "", exitCode: 0 };
 * });
 *
 * const bash = new Bash({ customCommands: [hello] });
 * await bash.exec("hello Alice"); // "Hello, Alice!\n"
 * ```
 */
export function defineCommand(name, execute) {
    return { name, execute };
}
/**
 * Create a lazy-loaded wrapper for a custom command.
 * The command is only loaded when first executed.
 */
export function createLazyCustomCommand(lazy) {
    let cached = null;
    return {
        name: lazy.name,
        async execute(args, ctx) {
            if (!cached) {
                cached = await lazy.load();
            }
            return cached.execute(args, ctx);
        },
    };
}
