/**
 * rg - ripgrep-like recursive search
 *
 * Fast recursive search with smart defaults:
 * - Recursive by default (unlike grep)
 * - Respects .gitignore
 * - Skips hidden files by default
 * - Skips binary files by default
 * - Smart case sensitivity (case-insensitive unless pattern has uppercase)
 */
import type { Command } from "../../types.js";
export declare const rgCommand: Command;
