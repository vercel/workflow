import type { CodeSample } from './types.js';

const CODE_BLOCK_REGEX =
  /```(typescript|ts|javascript|js)(?:\s+[^\n]*)?\n([\s\S]*?)```/g;
const EXPECT_ERROR_REGEX = /<!--\s*@expect-error:([0-9,\s]+)\s*-->/;
// Match entire line comments with [!code ...] including any trailing text
const HIGHLIGHT_COMMENT_REGEX = /\s*\/\/\s*\[!code[^\]]*\].*$/gm;
// Match ellipsis patterns indicating incomplete code: standalone "...", "// ...", or "/* ... */"
const INCOMPLETE_CODE_REGEX =
  /(?:^\s*\.{3}\s*$|\/\/\s*\.{3}|\/\*\s*\.{3}\s*\*\/)/m;

/**
 * Normalizes the language identifier
 */
function normalizeLanguage(
  lang: string
): 'ts' | 'typescript' | 'js' | 'javascript' {
  const normalized = lang.toLowerCase();
  if (normalized === 'ts' || normalized === 'typescript') {
    return 'typescript';
  }
  if (normalized === 'js' || normalized === 'javascript') {
    return 'javascript';
  }
  return normalized as 'ts' | 'typescript' | 'js' | 'javascript';
}

/**
 * Strips special highlight comments from code
 */
function stripHighlightComments(code: string): string {
  return code.replace(HIGHLIGHT_COMMENT_REGEX, '');
}

/**
 * Gets the line number where a match occurs in content
 */
function getLineNumber(content: string, index: number): number {
  const beforeMatch = content.substring(0, index);
  return beforeMatch.split('\n').length;
}

/**
 * Checks for markers before the given index and returns skip status and expected errors
 */
function getMarkersBeforeBlock(
  content: string,
  index: number
): { skipTypeCheck: boolean; expectedErrors: number[] } {
  // Look for markers in the preceding ~200 characters
  const lookbackStart = Math.max(0, index - 200);
  const lookbackText = content.substring(lookbackStart, index);

  let skipTypeCheck = false;
  let expectedErrors: number[] = [];

  // Check for skip marker (HTML comment or MDX comment)
  // HTML: <!-- @skip-typecheck ... -->
  // MDX:  {/* @skip-typecheck ... */}
  const skipMatch = lookbackText.match(
    /(?:<!--\s*@skip-typecheck[^>]*-->|\{\/\*\s*@skip-typecheck[^*]*\*\/\})/g
  );
  if (skipMatch) {
    const lastSkipIndex = lookbackText.lastIndexOf(skipMatch.at(-1)!);
    const textBetween = lookbackText.substring(lastSkipIndex);
    // Only apply if no other code block between marker and this block
    if (!textBetween.includes('```')) {
      skipTypeCheck = true;
    }
  }

  // Check for expect-error marker
  const expectMatch = lookbackText.match(EXPECT_ERROR_REGEX);
  if (expectMatch) {
    const lastIndex = lookbackText.lastIndexOf(expectMatch[0]);
    const textBetween = lookbackText.substring(lastIndex);
    // Only apply if no other code block between marker and this block
    if (!textBetween.includes('```')) {
      expectedErrors = expectMatch[1]
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n));
    }
  }

  return { skipTypeCheck, expectedErrors };
}

/**
 * Extracts code samples from MDX/MD content
 */
export function extractCodeSamples(
  filePath: string,
  content: string
): CodeSample[] {
  const samples: CodeSample[] = [];
  let match: RegExpExecArray | null;

  // Reset regex state
  CODE_BLOCK_REGEX.lastIndex = 0;

  while ((match = CODE_BLOCK_REGEX.exec(content)) !== null) {
    const [, language, rawCode] = match;
    const matchIndex = match.index;

    // Normalize language and skip non-TS/JS
    const normalizedLang = normalizeLanguage(language);
    if (
      normalizedLang !== 'typescript' &&
      normalizedLang !== 'javascript' &&
      normalizedLang !== 'ts' &&
      normalizedLang !== 'js'
    ) {
      continue;
    }

    // Process the code
    const processedCode = stripHighlightComments(rawCode);

    // Get markers (skip and expected errors)
    const { skipTypeCheck, expectedErrors } = getMarkersBeforeBlock(
      content,
      matchIndex
    );

    // Calculate line number (1-indexed, pointing to first line of code)
    const lineNumber = getLineNumber(content, matchIndex) + 1;

    // Check if code contains ellipsis patterns indicating incomplete code
    const isIncomplete = INCOMPLETE_CODE_REGEX.test(processedCode);

    samples.push({
      source: processedCode,
      language: normalizedLang,
      filePath,
      lineNumber,
      skipTypeCheck,
      expectedErrors,
      isIncomplete,
    });
  }

  return samples;
}

/**
 * Extracts code samples from a file path
 */
export async function extractCodeSamplesFromFile(
  filePath: string
): Promise<CodeSample[]> {
  const fs = await import('node:fs/promises');
  const content = await fs.readFile(filePath, 'utf-8');
  return extractCodeSamples(filePath, content);
}
