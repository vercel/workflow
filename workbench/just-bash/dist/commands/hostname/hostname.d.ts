/**
 * hostname - show or set the system's host name
 *
 * Usage: hostname [NAME]
 *
 * In sandboxed environment, always returns "localhost".
 */
import type { Command } from "../../types.js";
export declare const hostname: Command;
