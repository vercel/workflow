import type { Command } from "../../types.js";
/**
 * seq - print a sequence of numbers
 *
 * Usage:
 *   seq LAST           - print numbers from 1 to LAST
 *   seq FIRST LAST     - print numbers from FIRST to LAST
 *   seq FIRST INCR LAST - print numbers from FIRST to LAST by INCR
 *
 * Options:
 *   -s STRING  use STRING to separate numbers (default: newline)
 *   -w         equalize width by padding with leading zeros
 */
export declare const seqCommand: Command;
