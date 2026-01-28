/**
 * SHELLOPTS and BASHOPTS variable helpers.
 *
 * SHELLOPTS is a colon-separated list of enabled shell options from `set -o`.
 * BASHOPTS is a colon-separated list of enabled bash-specific options from `shopt`.
 */
import type { InterpreterContext, ShellOptions, ShoptOptions } from "../types.js";
/**
 * Build the SHELLOPTS string from current shell options.
 * Returns a colon-separated list of enabled options (alphabetically sorted).
 * Includes always-on options like braceexpand, hashall, interactive-comments.
 */
export declare function buildShellopts(options: ShellOptions): string;
/**
 * Update the SHELLOPTS environment variable to reflect current shell options.
 * Should be called whenever shell options change (via set -o or shopt -o).
 */
export declare function updateShellopts(ctx: InterpreterContext): void;
/**
 * Build the BASHOPTS string from current shopt options.
 * Returns a colon-separated list of enabled options (alphabetically sorted).
 */
export declare function buildBashopts(shoptOptions: ShoptOptions): string;
/**
 * Update the BASHOPTS environment variable to reflect current shopt options.
 * Should be called whenever shopt options change.
 */
export declare function updateBashopts(ctx: InterpreterContext): void;
