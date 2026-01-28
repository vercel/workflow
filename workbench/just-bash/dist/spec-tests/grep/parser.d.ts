/**
 * Parser for grep test formats
 *
 * Supports:
 * - BusyBox format: testing "description" "commands" "result" "infile" "stdin"
 * - GNU grep format: exit_code@pattern@test_string[@note]
 */
import { type BusyBoxTestCase, type ParsedBusyBoxTestFile } from "../../test-utils/busybox-test-parser.js";
export type GrepTestCase = BusyBoxTestCase;
export type ParsedGrepTestFile = ParsedBusyBoxTestFile;
/**
 * Parse a grep test file (auto-detects format)
 */
export declare function parseGrepTestFile(content: string, filePath: string): ParsedGrepTestFile;
