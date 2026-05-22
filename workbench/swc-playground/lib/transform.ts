export interface TransformResult {
  workflow: { code: string; error?: string };
  step: { code: string; error?: string };
}

// ── Serde analysis types and helpers ──────────────────────────────────────

export interface SerdeClassAnalysis {
  className: string;
  classId: string;
  detected: boolean;
  registered: boolean;
  nodeImports: string[];
  compliant: boolean;
  issues: string[];
}

export interface SerdeAnalysis {
  hasSerdeClasses: boolean;
  globalNodeImports: string[];
  classes: SerdeClassAnalysis[];
}

// Node.js built-in module base names for client-side detection.
// Generated from `require('module').builtinModules` (Node 22).
// Keep in sync with Node.js releases — sub-paths like 'fs/promises'
// are matched by the regex via the `/[^'"]*` suffix.
const NODE_BUILTINS = [
  'assert',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'domain',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'string_decoder',
  'sys',
  'test',
  'timers',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
];

const nodeBuiltinPattern = NODE_BUILTINS.join('|');
const nodeImportExtractRegex = new RegExp(
  `(?:from\\s+['"](?:node:)?((?:${nodeBuiltinPattern})(?:/[^'"]*)?)['"]` +
    `|require\\s*\\(\\s*['"](?:node:)?((?:${nodeBuiltinPattern})(?:/[^'"]*)?)['"]\\s*\\))`,
  'g'
);

const registrationIifeRegex =
  /Symbol\.for\s*\(\s*["']workflow-class-registry["']\s*\)/;

const manifestRegex = /\/\*\*__internal_workflows({[\s\S]*?})\*\//;

interface ManifestClasses {
  [fileName: string]: {
    [className: string]: { classId: string };
  };
}

function extractNodeImports(code: string): string[] {
  const imports = new Set<string>();
  nodeImportExtractRegex.lastIndex = 0;
  for (
    let match = nodeImportExtractRegex.exec(code);
    match !== null;
    match = nodeImportExtractRegex.exec(code)
  ) {
    const moduleName = match[1] || match[2];
    if (moduleName) {
      imports.add(moduleName.split('/')[0]);
    }
  }
  return [...imports].sort();
}

/**
 * Analyze the workflow-mode transform output for serde compliance.
 * Runs entirely client-side with no Node.js dependencies.
 */
export function analyzeSerdeFromTransformOutput(
  sourceCode: string,
  workflowCode: string
): SerdeAnalysis | null {
  const manifestMatch = workflowCode.match(manifestRegex);
  const manifest = manifestMatch
    ? (JSON.parse(manifestMatch[1]) as { classes?: ManifestClasses })
    : { classes: undefined };

  const globalNodeImports = extractNodeImports(workflowCode);
  const hasRegistration = registrationIifeRegex.test(workflowCode);

  const classEntries: Array<{ className: string; classId: string }> = [];
  if (manifest.classes) {
    for (const classes of Object.values(manifest.classes)) {
      for (const [className, { classId }] of Object.entries(classes)) {
        classEntries.push({ className, classId });
      }
    }
  }

  const classes: SerdeClassAnalysis[] = classEntries.map((entry) => {
    const issues: string[] = [];
    if (globalNodeImports.length > 0) {
      issues.push(
        `Workflow bundle contains Node.js built-in imports: ${globalNodeImports.join(', ')}. ` +
          `Add "use step" to methods that depend on Node.js APIs.`
      );
    }
    if (!hasRegistration) {
      issues.push(
        `No class registration IIFE was generated. ` +
          `Ensure WORKFLOW_SERIALIZE and WORKFLOW_DESERIALIZE are defined as static methods ` +
          `inside the class body using computed property syntax.`
      );
    }
    return {
      className: entry.className,
      classId: entry.classId,
      detected: true,
      registered: hasRegistration,
      nodeImports: globalNodeImports,
      compliant: globalNodeImports.length === 0 && hasRegistration,
      issues,
    };
  });

  // Detect serde patterns in source not picked up by SWC
  const sourceHasSerdePatterns =
    /\[\s*WORKFLOW_(?:SERIALIZE|DESERIALIZE)\s*\]/.test(sourceCode) ||
    /Symbol\.for\s*\(\s*['"]workflow-(?:serialize|deserialize)['"]\s*\)/.test(
      sourceCode
    );

  if (sourceHasSerdePatterns && classEntries.length === 0) {
    classes.push({
      className: '<unknown>',
      classId: '',
      detected: false,
      registered: false,
      nodeImports: globalNodeImports,
      compliant: false,
      issues: [
        `Source code contains WORKFLOW_SERIALIZE/WORKFLOW_DESERIALIZE patterns but ` +
          `the SWC plugin did not detect any serde-enabled classes. ` +
          `Ensure the symbols are defined as static methods INSIDE the class body.`,
      ],
    });
  }

  const hasSerdeClasses = classes.length > 0;
  if (!hasSerdeClasses) return null;

  return { hasSerdeClasses, globalNodeImports, classes };
}

let wasmExports: {
  transform: (source: string, config_json: string) => string;
  transformAll: (source: string, config_json: string) => string;
} | null = null;

let initPromise: Promise<void> | null = null;

/**
 * Initialize the WASM module. Safe to call multiple times —
 * subsequent calls are no-ops.
 */
export async function initWasm(): Promise<void> {
  if (wasmExports) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    // Dynamically import the wasm-bindgen glue code.
    // The `/* webpackIgnore: true */` comment prevents the bundler
    // from statically analyzing the import and trying to resolve
    // the .wasm file reference inside the glue code.
    const glue = await import(
      /* webpackIgnore: true */
      '/wasm/swc_playground_wasm.js'
    );
    await glue.default({
      module_or_path: '/wasm/swc_playground_wasm_bg.wasm',
    });
    wasmExports = {
      transform: glue.transform,
      transformAll: glue.transformAll,
    };
  })();

  return initPromise;
}

/**
 * Transform source code using the workflow SWC plugin (runs in WASM).
 *
 * Automatically initializes the WASM module on first call.
 */
export async function transformCode(
  sourceCode: string,
  moduleSpecifier?: string
): Promise<TransformResult> {
  await initWasm();

  const config = JSON.stringify({
    moduleSpecifier,
    filename: 'input.ts',
  });

  const resultJson = wasmExports!.transformAll(sourceCode, config);
  return JSON.parse(resultJson) as TransformResult;
}
