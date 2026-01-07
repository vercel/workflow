import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import type {
  ProcessedCodeSample,
  TypeCheckDiagnostic,
  TypeCheckResult,
} from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Find repo root
const repoRoot = path.resolve(__dirname, '../../../..');

// Globals declaration file path
const docsGlobalsPath = path.join(__dirname, 'docs-globals.d.ts');
const docsGlobalsContent = fs.readFileSync(docsGlobalsPath, 'utf-8');

/**
 * Error codes to ignore during type checking.
 */
const IGNORED_ERROR_CODES = new Set([
  2307, // Cannot find module 'X' - for app-specific imports like @/...
  6133, // 'X' is declared but its value is never read
  6196, // 'X' is declared but never used
]);

/**
 * Shared compiler options for all type checking
 */
const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  moduleDetection: ts.ModuleDetectionKind.Force,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.asynciterable.d.ts'],
  strict: false,
  noImplicitAny: false,
  strictNullChecks: false,
  skipLibCheck: true,
  noEmit: true,
  esModuleInterop: true,
  allowSyntheticDefaultImports: true,
  jsx: ts.JsxEmit.ReactJSX,
  jsxImportSource: 'react',
  types: ['node'],
  typeRoots: [
    path.join(__dirname, '../node_modules/@types'),
    path.join(repoRoot, 'node_modules/@types'),
  ],
  baseUrl: repoRoot,
  paths: {
    'react/jsx-runtime': [
      path.join(__dirname, '../node_modules/react/jsx-runtime'),
    ],
    react: [path.join(__dirname, '../node_modules/react')],
  },
};

/**
 * Creates a TypeScript program for type checking multiple code samples at once
 */
function createBatchProgram(samples: ProcessedCodeSample[]): {
  program: ts.Program;
  samplePaths: Map<string, ProcessedCodeSample>;
} {
  const globalsPath = path.join(repoRoot, '__docs_globals__.d.ts');

  // Create virtual file paths for each sample
  const samplePaths = new Map<string, ProcessedCodeSample>();
  const virtualFiles = new Map<string, string>();

  virtualFiles.set(globalsPath, docsGlobalsContent);

  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    const virtualPath = path.join(repoRoot, `__docs_sample_${i}__.tsx`);
    samplePaths.set(virtualPath, sample);
    virtualFiles.set(virtualPath, sample.processedSource);
  }

  const defaultHost = ts.createCompilerHost(compilerOptions);

  const host: ts.CompilerHost = {
    ...defaultHost,
    getSourceFile: (fileName: string, languageVersion: ts.ScriptTarget) => {
      const content = virtualFiles.get(fileName);
      if (content !== undefined) {
        return ts.createSourceFile(fileName, content, languageVersion, true);
      }
      return defaultHost.getSourceFile(fileName, languageVersion);
    },
    fileExists: (fileName: string) => {
      if (virtualFiles.has(fileName)) {
        return true;
      }
      return defaultHost.fileExists(fileName);
    },
    readFile: (fileName: string) => {
      const content = virtualFiles.get(fileName);
      if (content !== undefined) {
        return content;
      }
      return defaultHost.readFile(fileName);
    },
    getCurrentDirectory: () => repoRoot,
  };

  const program = ts.createProgram(
    [globalsPath, ...samplePaths.keys()],
    compilerOptions,
    host
  );

  return { program, samplePaths };
}

/**
 * Type-checks multiple code samples in a single TypeScript program.
 * Much more efficient than checking each sample individually.
 */
export function typeCheckBatch(
  samples: ProcessedCodeSample[]
): Map<ProcessedCodeSample, TypeCheckResult> {
  const results = new Map<ProcessedCodeSample, TypeCheckResult>();

  if (samples.length === 0) {
    return results;
  }

  const { program, samplePaths } = createBatchProgram(samples);

  for (const [virtualPath, sample] of samplePaths) {
    const sourceFile = program.getSourceFile(virtualPath);
    const importLineCount =
      sample.addedImports.length > 0 ? sample.addedImports.length + 1 : 0;

    if (!sourceFile) {
      results.set(sample, {
        success: false,
        diagnostics: [
          {
            message: 'Failed to create source file',
            line: 1,
            column: 1,
            code: -1,
          },
        ],
        sample,
      });
      continue;
    }

    const semanticDiagnostics = program.getSemanticDiagnostics(sourceFile);
    const syntacticDiagnostics = program.getSyntacticDiagnostics(sourceFile);
    const allDiagnostics = [...syntacticDiagnostics, ...semanticDiagnostics];

    const expectedErrorSet = new Set(sample.expectedErrors);
    const relevantDiagnostics = allDiagnostics.filter(
      (d) => !IGNORED_ERROR_CODES.has(d.code) && !expectedErrorSet.has(d.code)
    );

    const diagnostics = relevantDiagnostics.map((d) =>
      convertDiagnostic(d, importLineCount)
    );

    results.set(sample, {
      success: diagnostics.length === 0,
      diagnostics,
      sample,
    });
  }

  return results;
}

/**
 * Creates a TypeScript program for type checking a single code sample
 * @deprecated Use typeCheckBatch for better performance
 */
function createProgram(source: string): ts.Program {
  const samplePath = path.join(repoRoot, '__docs_sample__.tsx');
  const globalsPath = path.join(repoRoot, '__docs_globals__.d.ts');

  const defaultHost = ts.createCompilerHost(compilerOptions);

  const host: ts.CompilerHost = {
    ...defaultHost,
    getSourceFile: (fileName: string, languageVersion: ts.ScriptTarget) => {
      if (fileName === samplePath || fileName.endsWith('__docs_sample__.tsx')) {
        return ts.createSourceFile(fileName, source, languageVersion, true);
      }
      if (
        fileName === globalsPath ||
        fileName.endsWith('__docs_globals__.d.ts')
      ) {
        return ts.createSourceFile(
          fileName,
          docsGlobalsContent,
          languageVersion,
          true
        );
      }
      return defaultHost.getSourceFile(fileName, languageVersion);
    },
    fileExists: (fileName: string) => {
      if (fileName === samplePath || fileName.endsWith('__docs_sample__.tsx')) {
        return true;
      }
      if (
        fileName === globalsPath ||
        fileName.endsWith('__docs_globals__.d.ts')
      ) {
        return true;
      }
      return defaultHost.fileExists(fileName);
    },
    readFile: (fileName: string) => {
      if (fileName === samplePath || fileName.endsWith('__docs_sample__.tsx')) {
        return source;
      }
      if (
        fileName === globalsPath ||
        fileName.endsWith('__docs_globals__.d.ts')
      ) {
        return docsGlobalsContent;
      }
      return defaultHost.readFile(fileName);
    },
    getCurrentDirectory: () => repoRoot,
  };

  const program = ts.createProgram(
    [globalsPath, samplePath],
    compilerOptions,
    host
  );
  return program;
}

/**
 * Converts a TypeScript diagnostic to our format
 */
function convertDiagnostic(
  diagnostic: ts.Diagnostic,
  offset: number
): TypeCheckDiagnostic {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');

  let line = 1;
  let column = 1;

  if (diagnostic.file && diagnostic.start !== undefined) {
    const pos = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    // Adjust line number for added imports
    line = Math.max(1, pos.line + 1 - offset);
    column = pos.character + 1;
  }

  return {
    message,
    line,
    column,
    code: diagnostic.code,
  };
}

/**
 * Type-checks a processed code sample
 */
export function typeCheck(sample: ProcessedCodeSample): TypeCheckResult {
  const { processedSource, addedImports } = sample;

  // Calculate line offset from added imports
  const importLineCount = addedImports.length > 0 ? addedImports.length + 1 : 0;

  try {
    const program = createProgram(processedSource);
    const samplePath = path.join(repoRoot, '__docs_sample__.tsx');
    const sourceFile = program.getSourceFile(samplePath);
    // Offset only accounts for imports now (globals are in a separate file)
    const totalOffset = importLineCount;

    if (!sourceFile) {
      return {
        success: false,
        diagnostics: [
          {
            message: 'Failed to create source file',
            line: 1,
            column: 1,
            code: -1,
          },
        ],
        sample,
      };
    }

    // Get semantic diagnostics (type errors)
    const semanticDiagnostics = program.getSemanticDiagnostics(sourceFile);

    // Get syntactic diagnostics (parse errors)
    const syntacticDiagnostics = program.getSyntacticDiagnostics(sourceFile);

    const allDiagnostics = [...syntacticDiagnostics, ...semanticDiagnostics];

    // Filter out ignored errors (global + per-sample)
    const expectedErrorSet = new Set(sample.expectedErrors);
    const relevantDiagnostics = allDiagnostics.filter(
      (d) => !IGNORED_ERROR_CODES.has(d.code) && !expectedErrorSet.has(d.code)
    );

    const diagnostics = relevantDiagnostics.map((d) =>
      convertDiagnostic(d, totalOffset)
    );

    return {
      success: diagnostics.length === 0,
      diagnostics,
      sample,
    };
  } catch (error) {
    return {
      success: false,
      diagnostics: [
        {
          message: error instanceof Error ? error.message : String(error),
          line: 1,
          column: 1,
          code: -1,
        },
      ],
      sample,
    };
  }
}

/**
 * Formats a type check result for display
 */
export function formatResult(result: TypeCheckResult): string {
  const { sample, diagnostics } = result;

  if (result.success) {
    return `PASS ${sample.filePath} line ${sample.lineNumber}`;
  }

  const lines = [`FAIL ${sample.filePath} line ${sample.lineNumber}`, ''];

  for (const diag of diagnostics) {
    lines.push(`  Line ${diag.line}: ${diag.message} (TS${diag.code})`);
  }

  // Show source with line numbers
  lines.push('');
  lines.push('  Source (with inferred imports):');
  lines.push('');

  const sourceLines = sample.processedSource.split('\n');
  for (let i = 0; i < Math.min(sourceLines.length, 20); i++) {
    const lineNum = String(i + 1).padStart(4, ' ');
    lines.push(`    ${lineNum} | ${sourceLines[i]}`);
  }

  if (sourceLines.length > 20) {
    lines.push(`    ... (${sourceLines.length - 20} more lines)`);
  }

  return lines.join('\n');
}
