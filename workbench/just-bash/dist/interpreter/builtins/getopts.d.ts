/**
 * getopts - Parse positional parameters as options
 *
 * getopts optstring name [arg...]
 *
 * Parses options from positional parameters (or provided args).
 * - optstring: string of valid option characters
 * - If a character is followed by ':', it requires an argument
 * - If optstring starts with ':', silent error reporting mode
 * - name: variable to store the current option
 * - OPTARG: set to the option argument (if any)
 * - OPTIND: index of next argument to process (starts at 1)
 *
 * Returns 0 if option found, 1 if end of options or error.
 */
import type { ExecResult } from "../../types.js";
import type { InterpreterContext } from "../types.js";
export declare function handleGetopts(ctx: InterpreterContext, args: string[]): ExecResult;
