/**
 * Prompt expansion
 *
 * Handles prompt escape sequences for ${var@P} transformation and PS1/PS2/PS3/PS4.
 */
import type { InterpreterContext } from "../types.js";
/**
 * Expand prompt escape sequences (${var@P} transformation)
 * Interprets backslash escapes used in PS1, PS2, PS3, PS4 prompt strings.
 *
 * Supported escapes:
 * - \a - bell (ASCII 07)
 * - \e - escape (ASCII 033)
 * - \n - newline
 * - \r - carriage return
 * - \\ - literal backslash
 * - \$ - $ for regular user, # for root (always $ here)
 * - \[ and \] - non-printing sequence delimiters (removed)
 * - \u - username
 * - \h - short hostname (up to first .)
 * - \H - full hostname
 * - \w - current working directory
 * - \W - basename of current working directory
 * - \d - date (Weekday Month Day format)
 * - \t - time HH:MM:SS (24-hour)
 * - \T - time HH:MM:SS (12-hour)
 * - \@ - time HH:MM AM/PM (12-hour)
 * - \A - time HH:MM (24-hour)
 * - \D{format} - strftime format
 * - \s - shell name
 * - \v - bash version (major.minor)
 * - \V - bash version (major.minor.patch)
 * - \j - number of jobs
 * - \l - terminal device basename
 * - \# - command number
 * - \! - history number
 * - \NNN - octal character code
 */
export declare function expandPrompt(ctx: InterpreterContext, value: string): string;
