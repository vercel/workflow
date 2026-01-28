/**
 * Shell Constants
 *
 * Constants for shell builtins, keywords, and POSIX special builtins.
 */
/**
 * POSIX special built-in commands.
 * In POSIX mode, these have special behaviors:
 * - Prefix assignments persist after the command
 * - Cannot be redefined as functions
 * - Errors may be fatal
 */
export declare const POSIX_SPECIAL_BUILTINS: Set<string>;
/**
 * Check if a command name is a POSIX special built-in
 */
export declare function isPosixSpecialBuiltin(name: string): boolean;
/**
 * Shell keywords (for type, command -v, etc.)
 */
export declare const SHELL_KEYWORDS: Set<string>;
/**
 * Shell builtins (for type, command -v, builtin, etc.)
 */
export declare const SHELL_BUILTINS: Set<string>;
