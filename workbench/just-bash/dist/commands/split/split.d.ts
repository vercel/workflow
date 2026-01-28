/**
 * split - split a file into pieces
 *
 * Usage: split [OPTION]... [FILE [PREFIX]]
 *
 * Output pieces of FILE to PREFIXaa, PREFIXab, ...;
 * default size is 1000 lines, and default PREFIX is 'x'.
 */
import type { Command } from "../../types.js";
export declare const split: Command;
