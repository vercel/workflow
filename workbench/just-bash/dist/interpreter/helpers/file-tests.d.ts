import type { InterpreterContext } from "../types.js";
/**
 * File test operators supported by bash
 * Unary operators that test file properties
 */
declare const FILE_TEST_OPERATORS: readonly ["-e", "-a", "-f", "-d", "-r", "-w", "-x", "-s", "-L", "-h", "-k", "-g", "-u", "-G", "-O", "-b", "-c", "-p", "-S", "-t", "-N"];
export type FileTestOperator = (typeof FILE_TEST_OPERATORS)[number];
export declare function isFileTestOperator(op: string): op is FileTestOperator;
/**
 * Evaluates a file test operator (-e, -f, -d, etc.) against a path.
 * Returns a boolean result.
 *
 * @param ctx - Interpreter context with filesystem access
 * @param operator - The file test operator (e.g., "-f", "-d", "-e")
 * @param operand - The path to test (will be resolved relative to cwd)
 */
export declare function evaluateFileTest(ctx: InterpreterContext, operator: string, operand: string): Promise<boolean>;
/**
 * Binary file test operators for comparing two files
 */
declare const BINARY_FILE_TEST_OPERATORS: readonly ["-nt", "-ot", "-ef"];
export type BinaryFileTestOperator = (typeof BINARY_FILE_TEST_OPERATORS)[number];
export declare function isBinaryFileTestOperator(op: string): op is BinaryFileTestOperator;
/**
 * Evaluates a binary file test operator (-nt, -ot, -ef) comparing two files.
 *
 * @param ctx - Interpreter context with filesystem access
 * @param operator - The operator (-nt, -ot, -ef)
 * @param left - Left operand (file path)
 * @param right - Right operand (file path)
 */
export declare function evaluateBinaryFileTest(ctx: InterpreterContext, operator: string, left: string, right: string): Promise<boolean>;
export {};
