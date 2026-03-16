import ts from 'typescript';
import type { CodeSample, ProcessedCodeSample } from './types.js';

interface ImportMapping {
  module: string;
  isType?: boolean;
  /** If set, import this name and alias it to the symbol name */
  importAs?: string;
}

/**
 * Mapping of known symbols to their source modules
 */
const SYMBOL_IMPORTS: Record<string, ImportMapping> = {
  // From 'workflow' (re-exports from @workflow/core)
  FatalError: { module: 'workflow' },
  RetryableError: { module: 'workflow' },
  createHook: { module: 'workflow' },
  createWebhook: { module: 'workflow' },
  defineHook: { module: 'workflow' },
  sleep: { module: 'workflow' },
  getStepMetadata: { module: 'workflow' },
  getWorkflowMetadata: { module: 'workflow' },
  getWritable: { module: 'workflow' },
  fetch: { module: 'workflow' },

  // Types from 'workflow'
  Hook: { module: 'workflow', isType: true },
  HookOptions: { module: 'workflow', isType: true },
  RequestWithResponse: { module: 'workflow', isType: true },
  Webhook: { module: 'workflow', isType: true },
  WebhookOptions: { module: 'workflow', isType: true },
  StepMetadata: { module: 'workflow', isType: true },
  WorkflowMetadata: { module: 'workflow', isType: true },
  TypedHook: { module: 'workflow', isType: true },
  WorkflowWritableStreamOptions: { module: 'workflow', isType: true },
  RetryableErrorOptions: { module: 'workflow', isType: true },

  // From 'workflow/api'
  start: { module: 'workflow/api' },
  getRun: { module: 'workflow/api' },
  runStep: { module: 'workflow/api' },
  resumeHook: { module: 'workflow/api' },
  resumeWebhook: { module: 'workflow/api' },
  getHookByToken: { module: 'workflow/api' },
  Run: { module: 'workflow/api' },

  // Types from 'workflow/api'
  Event: { module: 'workflow/api', isType: true },
  StartOptions: { module: 'workflow/api', isType: true },
  WorkflowRun: { module: 'workflow/api', isType: true },
  WorkflowReadableStreamOptions: { module: 'workflow/api', isType: true },

  // From '@workflow/next'
  withWorkflow: { module: '@workflow/next' },

  // From '@workflow/ai'
  createDurableAgent: { module: '@workflow/ai' },
  DurableAgent: { module: '@workflow/ai' }, // Class (both type and value)

  // Third-party
  z: { module: 'zod' },

  // AI SDK exports
  Output: { module: 'ai' },
  Agent: { module: 'ai', importAs: 'Experimental_Agent' }, // AI SDK exports as Experimental_Agent
  tool: { module: 'ai' },
  streamText: { module: 'ai' },
  generateText: { module: 'ai' },
  streamObject: { module: 'ai' },
  generateObject: { module: 'ai' },
  generateId: { module: 'ai' },
  convertToModelMessages: { module: 'ai' },
  createUIMessageStreamResponse: { module: 'ai' },
  UIMessage: { module: 'ai', isType: true },
  UIMessageChunk: { module: 'ai', isType: true },
  ModelMessage: { module: 'ai', isType: true },
};

/**
 * Finds all identifiers used in the source code
 */
function findUsedIdentifiers(sourceCode: string): Set<string> {
  const identifiers = new Set<string>();

  try {
    const sourceFile = ts.createSourceFile(
      'sample.ts',
      sourceCode,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );

    function visit(node: ts.Node) {
      if (ts.isIdentifier(node)) {
        identifiers.add(node.text);
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  } catch {
    // If parsing fails, fall back to regex-based extraction
    const identifierRegex = /\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g;
    let match;
    while ((match = identifierRegex.exec(sourceCode)) !== null) {
      identifiers.add(match[1]);
    }
  }

  return identifiers;
}

/**
 * Finds identifiers that are declared locally in the source
 */
function findLocalDeclarations(sourceCode: string): Set<string> {
  const locals = new Set<string>();

  try {
    const sourceFile = ts.createSourceFile(
      'sample.ts',
      sourceCode,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );

    function visit(node: ts.Node) {
      // Variable declarations: const x = ..., let y = ...
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        locals.add(node.name.text);
      }

      // Function declarations: function foo() {}
      if (ts.isFunctionDeclaration(node) && node.name) {
        locals.add(node.name.text);
      }

      // Class declarations: class Foo {}
      if (ts.isClassDeclaration(node) && node.name) {
        locals.add(node.name.text);
      }

      // Parameters: (x, y) => ...
      if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
        locals.add(node.name.text);
      }

      // Type aliases: type Foo = ...
      if (ts.isTypeAliasDeclaration(node)) {
        locals.add(node.name.text);
      }

      // Interface declarations: interface Foo {}
      if (ts.isInterfaceDeclaration(node)) {
        locals.add(node.name.text);
      }

      // Enum declarations: enum Foo {}
      if (ts.isEnumDeclaration(node)) {
        locals.add(node.name.text);
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  } catch {
    // Ignore parse errors for incomplete snippets
  }

  return locals;
}

/**
 * Extracts existing imports from the source code
 */
function findExistingImports(sourceCode: string): Set<string> {
  const imported = new Set<string>();

  try {
    const sourceFile = ts.createSourceFile(
      'sample.ts',
      sourceCode,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );

    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause;
        if (clause) {
          // Default import
          if (clause.name) {
            imported.add(clause.name.text);
          }
          // Named imports
          if (clause.namedBindings) {
            if (ts.isNamedImports(clause.namedBindings)) {
              for (const element of clause.namedBindings.elements) {
                imported.add(element.name.text);
              }
            } else if (ts.isNamespaceImport(clause.namedBindings)) {
              imported.add(clause.namedBindings.name.text);
            }
          }
        }
      }
    }
  } catch {
    // Ignore parse errors
  }

  return imported;
}

/**
 * Generates import statements for missing symbols
 */
function generateImports(missingSymbols: Map<string, ImportMapping>): string[] {
  // Group by module, tracking aliases separately
  const byModule = new Map<
    string,
    {
      values: string[];
      types: string[];
      aliases: Array<{ from: string; to: string }>;
    }
  >();

  for (const [symbol, mapping] of missingSymbols) {
    const existing = byModule.get(mapping.module) || {
      values: [],
      types: [],
      aliases: [],
    };

    if (mapping.importAs) {
      // This symbol needs to be imported with an alias
      existing.aliases.push({ from: mapping.importAs, to: symbol });
    } else if (mapping.isType) {
      existing.types.push(symbol);
    } else {
      existing.values.push(symbol);
    }
    byModule.set(mapping.module, existing);
  }

  // Generate import statements
  const imports: string[] = [];

  for (const [module, { values, types, aliases }] of byModule) {
    const allSymbols: string[] = [];

    // Add value imports
    allSymbols.push(...values.sort());

    // Add aliased imports (e.g., "Experimental_Agent as Agent")
    for (const { from, to } of aliases) {
      allSymbols.push(`${from} as ${to}`);
    }

    // Add type imports with 'type' prefix
    for (const t of types.sort()) {
      allSymbols.push(`type ${t}`);
    }

    if (allSymbols.length > 0) {
      imports.push(`import { ${allSymbols.join(', ')} } from '${module}';`);
    }
  }

  return imports.sort();
}

/**
 * Processes a code sample to add inferred imports
 */
export function addInferredImports(sample: CodeSample): ProcessedCodeSample {
  const { source } = sample;

  // Find all identifiers used
  const usedIdentifiers = findUsedIdentifiers(source);

  // Find locally declared identifiers
  const localDeclarations = findLocalDeclarations(source);

  // Find existing imports
  const existingImports = findExistingImports(source);

  // Determine which symbols need to be imported
  const missingSymbols = new Map<string, ImportMapping>();

  for (const identifier of usedIdentifiers) {
    // Skip if locally declared
    if (localDeclarations.has(identifier)) continue;

    // Skip if already imported
    if (existingImports.has(identifier)) continue;

    // Skip common globals/keywords
    if (isBuiltinOrKeyword(identifier)) continue;

    // Check if we have a mapping for this symbol
    const mapping = SYMBOL_IMPORTS[identifier];
    if (mapping) {
      missingSymbols.set(identifier, mapping);
    }
  }

  // Generate import statements
  const addedImports = generateImports(missingSymbols);

  // Prepend imports to source
  const processedSource =
    addedImports.length > 0
      ? addedImports.join('\n') + '\n\n' + source
      : source;

  return {
    ...sample,
    processedSource,
    addedImports,
  };
}

/**
 * Checks if an identifier is a built-in or keyword
 */
function isBuiltinOrKeyword(identifier: string): boolean {
  const builtins = new Set([
    // JavaScript keywords
    'abstract',
    'arguments',
    'await',
    'boolean',
    'break',
    'byte',
    'case',
    'catch',
    'char',
    'class',
    'const',
    'continue',
    'debugger',
    'default',
    'delete',
    'do',
    'double',
    'else',
    'enum',
    'eval',
    'export',
    'extends',
    'false',
    'final',
    'finally',
    'float',
    'for',
    'function',
    'goto',
    'if',
    'implements',
    'import',
    'in',
    'instanceof',
    'int',
    'interface',
    'let',
    'long',
    'native',
    'new',
    'null',
    'package',
    'private',
    'protected',
    'public',
    'return',
    'short',
    'static',
    'super',
    'switch',
    'synchronized',
    'this',
    'throw',
    'throws',
    'transient',
    'true',
    'try',
    'typeof',
    'undefined',
    'var',
    'void',
    'volatile',
    'while',
    'with',
    'yield',

    // TypeScript keywords
    'any',
    'as',
    'asserts',
    'async',
    'bigint',
    'declare',
    'from',
    'get',
    'infer',
    'is',
    'keyof',
    'module',
    'namespace',
    'never',
    'of',
    'readonly',
    'require',
    'set',
    'string',
    'number',
    'symbol',
    'type',
    'unique',
    'unknown',

    // Common globals
    'console',
    'process',
    'global',
    'globalThis',
    'window',
    'document',
    'JSON',
    'Math',
    'Date',
    'Array',
    'Object',
    'String',
    'Number',
    'Boolean',
    'Symbol',
    'BigInt',
    'Map',
    'Set',
    'WeakMap',
    'WeakSet',
    'Promise',
    'Proxy',
    'Reflect',
    'Error',
    'TypeError',
    'ReferenceError',
    'SyntaxError',
    'RangeError',
    'URIError',
    'EvalError',
    'RegExp',
    'Function',
    'Uint8Array',
    'Int8Array',
    'Uint16Array',
    'Int16Array',
    'Uint32Array',
    'Int32Array',
    'Float32Array',
    'Float64Array',
    'ArrayBuffer',
    'DataView',
    'Buffer',
    'setTimeout',
    'setInterval',
    'clearTimeout',
    'clearInterval',
    'setImmediate',
    'clearImmediate',
    'queueMicrotask',

    // Web APIs
    'Request',
    'Response',
    'Headers',
    'URL',
    'URLSearchParams',
    'FormData',
    'Blob',
    'File',
    'ReadableStream',
    'WritableStream',
    'TransformStream',
    'TextEncoder',
    'TextDecoder',
    'AbortController',
    'AbortSignal',
    'crypto',
    'performance',
    'navigator',
    'location',
    'history',
    'localStorage',
    'sessionStorage',
    'indexedDB',
    'WebSocket',
    'EventSource',
    'Worker',
    'SharedWorker',
    'ServiceWorker',
    'Notification',
    'Intl',
    'atob',
    'btoa',

    // Common type names that don't need imports
    'Partial',
    'Required',
    'Readonly',
    'Record',
    'Pick',
    'Omit',
    'Exclude',
    'Extract',
    'NonNullable',
    'Parameters',
    'ConstructorParameters',
    'ReturnType',
    'InstanceType',
    'ThisParameterType',
    'OmitThisParameter',
    'ThisType',
    'Awaited',
    'Uppercase',
    'Lowercase',
    'Capitalize',
    'Uncapitalize',
  ]);

  return builtins.has(identifier);
}
