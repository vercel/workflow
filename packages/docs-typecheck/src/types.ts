export interface CodeSample {
  /** Raw code content */
  source: string;
  /** Language identifier from the code block */
  language: 'ts' | 'typescript' | 'js' | 'javascript';
  /** Source MDX/MD file path */
  filePath: string;
  /** Starting line number in the MDX file (1-indexed) */
  lineNumber: number;
  /** Whether to skip type checking (via <!-- @skip-typecheck --> comment) */
  skipTypeCheck: boolean;
  /** Error codes to ignore for this specific sample (via <!-- @expect-error:2304,2307 -->) */
  expectedErrors: number[];
  /** Whether the code sample contains ellipsis (...) indicating incomplete/partial code */
  isIncomplete: boolean;
}

export interface ProcessedCodeSample extends CodeSample {
  /** Code with inferred imports prepended */
  processedSource: string;
  /** Imports that were added */
  addedImports: string[];
}

export interface TypeCheckDiagnostic {
  message: string;
  line: number;
  column: number;
  code: number;
}

export interface TypeCheckResult {
  success: boolean;
  diagnostics: TypeCheckDiagnostic[];
  sample: ProcessedCodeSample;
}
