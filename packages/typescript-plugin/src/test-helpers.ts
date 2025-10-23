import ts from 'typescript/lib/tsserverlibrary';

/**
 * Creates a TypeScript program from source code for testing
 */
export function createTestProgram(
  sourceCode: string,
  fileName = 'test.ts'
): { program: ts.Program; sourceFile: ts.SourceFile } {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    lib: ['lib.es2020.d.ts'],
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
  };

  // Create a virtual file system
  const files = new Map<string, string>();
  files.set(fileName, sourceCode);

  // Create compiler host
  const host: ts.CompilerHost = {
    getSourceFile: (name) => {
      const content = files.get(name);
      if (content !== undefined) {
        return ts.createSourceFile(name, content, ts.ScriptTarget.ES2020, true);
      }
      // Return undefined for library files - they won't be available in tests
      return undefined;
    },
    writeFile: () => {},
    getCurrentDirectory: () => '/',
    getDirectories: () => [],
    fileExists: (name) => files.has(name),
    readFile: (name) => files.get(name),
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    getDefaultLibFileName: () => 'lib.d.ts',
  };

  // Create program
  const program = ts.createProgram([fileName], compilerOptions, host);
  const sourceFile = program.getSourceFile(fileName);

  if (!sourceFile) {
    throw new Error(`Failed to create source file for ${fileName}`);
  }

  return { program, sourceFile };
}

/**
 * Helper to assert a diagnostic with specific properties exists
 */
export function expectDiagnostic(
  diagnostics: ts.Diagnostic[],
  expected: {
    code: number;
    messageIncludes?: string;
  }
) {
  const diagnostic = diagnostics.find((d) => d.code === expected.code);

  if (!diagnostic) {
    const codes = diagnostics.map((d) => d.code).join(', ');
    throw new Error(
      `Expected diagnostic with code ${expected.code} but found codes: ${codes}`
    );
  }

  if (expected.messageIncludes) {
    const message =
      typeof diagnostic.messageText === 'string'
        ? diagnostic.messageText
        : diagnostic.messageText.messageText;

    if (!message.includes(expected.messageIncludes)) {
      throw new Error(
        `Expected diagnostic message to include "${expected.messageIncludes}" but got: "${message}"`
      );
    }
  }

  return diagnostic;
}

/**
 * Helper to check if a diagnostic with given code does NOT exist
 */
export function expectNoDiagnostic(diagnostics: ts.Diagnostic[], code: number) {
  const diagnostic = diagnostics.find((d) => d.code === code);

  if (diagnostic) {
    const message =
      typeof diagnostic.messageText === 'string'
        ? diagnostic.messageText
        : diagnostic.messageText.messageText;
    throw new Error(
      `Expected no diagnostic with code ${code} but found: "${message}"`
    );
  }
}
