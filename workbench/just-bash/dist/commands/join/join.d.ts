/**
 * join - join lines of two files on a common field
 *
 * Usage: join [OPTION]... FILE1 FILE2
 *
 * For each pair of input lines with identical join fields, write a line to
 * standard output. The default join field is the first, delimited by blanks.
 */
import type { Command } from "../../types.js";
export declare const join: Command;
