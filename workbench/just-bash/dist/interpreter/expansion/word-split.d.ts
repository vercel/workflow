/**
 * Word Splitting
 *
 * IFS-based word splitting for unquoted expansions.
 */
import type { WordPart } from "../../ast/types.js";
import type { InterpreterContext } from "../types.js";
/**
 * Type for the expandPart function that will be injected
 */
export type ExpandPartFn = (ctx: InterpreterContext, part: WordPart) => Promise<string>;
/**
 * Smart word splitting for words containing expansions.
 *
 * In bash, word splitting respects quoted parts. When you have:
 * - $a"$b" where a="1 2" and b="3 4"
 * - The unquoted $a gets split by IFS: "1 2" -> ["1", "2"]
 * - The quoted "$b" does NOT get split, it joins with the last field from $a
 * - Result: ["1", "23 4"] (the "2" joins with "3 4")
 *
 * This differs from pure literal words which are never IFS-split.
 *
 * @param ctx - Interpreter context
 * @param wordParts - Word parts to expand and split
 * @param ifsChars - IFS characters for proper whitespace/non-whitespace handling
 * @param ifsPattern - Regex-escaped IFS pattern for checking if splitting is needed
 * @param expandPartFn - Function to expand individual parts (injected to avoid circular deps)
 */
export declare function smartWordSplit(ctx: InterpreterContext, wordParts: WordPart[], ifsChars: string, _ifsPattern: string, expandPartFn: ExpandPartFn): Promise<string[]>;
