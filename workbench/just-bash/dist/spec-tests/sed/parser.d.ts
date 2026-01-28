/**
 * Parser for sed test formats
 *
 * Supports two formats:
 * 1. BusyBox format: testing "description" "commands" "result" "infile" "stdin"
 * 2. PythonSed .suite format:
 *    ---
 *    description
 *    ---
 *    sed script
 *    ---
 *    input
 *    ---
 *    expected output
 *    ---
 */
import { type BusyBoxTestCase, type ParsedBusyBoxTestFile } from "../../test-utils/busybox-test-parser.js";
export type SedTestCase = BusyBoxTestCase;
export type ParsedSedTestFile = ParsedBusyBoxTestFile;
/**
 * Parse a sed test file (auto-detects format)
 */
export declare function parseSedTestFile(content: string, filePath: string): ParsedSedTestFile;
