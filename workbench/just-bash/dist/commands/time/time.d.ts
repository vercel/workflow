import type { Command } from "../../types.js";
/**
 * time - time command execution
 *
 * Usage: time [-f FORMAT] [-o FILE] [-a] [-v] [-p] command [arguments...]
 *
 * Times the execution of a command and outputs timing statistics.
 *
 * Options:
 *   -f FORMAT    Use FORMAT for output (GNU time format specifiers)
 *   -o FILE      Write timing output to FILE
 *   -a           Append to output file (with -o)
 *   -v           Verbose output
 *   -p           POSIX portable output format
 *
 * Format specifiers:
 *   %e    Elapsed real time in seconds
 *   %M    Maximum resident set size (KB)
 *   %S    System CPU time (seconds)
 *   %U    User CPU time (seconds)
 *
 * Note: In this JavaScript implementation, user/system CPU time and memory
 * metrics are not available, so %M, %S, %U output 0.
 */
export declare const timeCommand: Command;
