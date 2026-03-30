/**
 * Generates a TypeScript file containing ambient module declarations from
 * workspace packages, for use with Monaco editor's `addExtraLib()` API.
 *
 * Reads the built `.d.ts` files from workspace packages and generates
 * `declare module` blocks with inlined type content. This is the most
 * reliable approach for Monaco as it works regardless of module resolution
 * configuration.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';

const packagesDir = new URL('../../../packages/', import.meta.url);

// Each entry defines a module name and the .d.ts file that provides its types.
// `dir` is the directory name under packages/.
// `modules` maps module specifiers to .d.ts paths relative to the package root.
const PACKAGES = [
  {
    dir: 'world',
    modules: { '@workflow/world': './dist/index.d.ts' },
  },
  {
    dir: 'utils',
    modules: { '@workflow/utils': './dist/index.d.ts' },
  },
  {
    dir: 'serde',
    modules: { '@workflow/serde': './dist/index.d.ts' },
  },
  {
    dir: 'errors',
    modules: { '@workflow/errors': './dist/index.d.ts' },
  },
  {
    dir: 'core',
    modules: { '@workflow/core': './dist/index.d.ts' },
  },
  {
    dir: 'workflow',
    modules: {
      workflow: './dist/index.d.ts',
      'workflow/api': './dist/api.d.ts',
      'workflow/errors': './dist/internal/errors.d.ts',
      'workflow/observability': './dist/observability.d.ts',
    },
  },
];

/**
 * Read a .d.ts file and transform it for use inside a `declare module` block.
 *
 * - Strips `export {};` lines
 * - Strips `//# sourceMappingURL=` lines
 * - Converts `export { X, Y } from './foo.js'` re-exports by reading
 *   the referenced file and inlining the exported declarations
 * - Converts `export * from '@workflow/core'` into `export * from "@workflow/core"`
 *   (these work because the referenced module also has a declare module block)
 * - Converts `import type { X } from './foo.js'` to inline the referenced types
 * - Strips `import type` statements for external packages (they'll resolve
 *   via other declare module blocks)
 */
function readDtsForModule(pkgDir, dtsRelPath, visited = new Set()) {
  const dtsUrl = new URL(dtsRelPath.replace(/^\.\//, ''), pkgDir);
  const key = dtsUrl.href;
  if (visited.has(key)) return ''; // prevent cycles
  visited.add(key);

  if (!existsSync(dtsUrl)) {
    console.warn(`  Warning: ${dtsUrl} not found`);
    return '';
  }

  let content = readFileSync(dtsUrl, 'utf-8');

  // Strip source map references
  content = content.replace(/\/\/# sourceMappingURL=.*$/gm, '');

  // Strip bare `export {};`
  content = content.replace(/^export \{\s*\};\s*$/gm, '');

  // Process `export * from './relative.js'` — inline from local files
  content = content.replace(
    /^export \* from ['"](\.[^'"]+)['"]\s*;?\s*$/gm,
    (_match, relPath) => {
      const resolvedPath = resolveRelativeDts(dtsRelPath, relPath);
      return readDtsForModule(pkgDir, resolvedPath, visited);
    }
  );

  // Process `export { X, Y, ... } from './relative.js'` — inline from local files
  content = content.replace(
    /^export \{([^}]+)\} from ['"](\.[^'"]+)['"]\s*;?\s*$/gm,
    (_match, exports, relPath) => {
      const resolvedPath = resolveRelativeDts(dtsRelPath, relPath);
      const sourceContent = readDtsForModule(pkgDir, resolvedPath, visited);
      // Return the full source — TypeScript will use what it needs.
      // This is simpler than trying to cherry-pick individual declarations.
      return sourceContent;
    }
  );

  // Convert `import type { X } from './relative.js'` to inline
  // We need these types available, so read and inline the source
  content = content.replace(
    /^import type \{([^}]+)\} from ['"](\.[^'"]+)['"]\s*;?\s*$/gm,
    (_match, _imports, relPath) => {
      const resolvedPath = resolveRelativeDts(dtsRelPath, relPath);
      return readDtsForModule(pkgDir, resolvedPath, visited);
    }
  );

  // Convert `import { type X } from './relative.js'` (mixed imports)
  content = content.replace(
    /^import \{([^}]+)\} from ['"](\.[^'"]+)['"]\s*;?\s*$/gm,
    (_match, _imports, relPath) => {
      const resolvedPath = resolveRelativeDts(dtsRelPath, relPath);
      return readDtsForModule(pkgDir, resolvedPath, visited);
    }
  );

  // Strip remaining import statements for external packages
  // (they resolve via other declare module blocks)
  content = content.replace(
    /^import\s+(?:type\s+)?\{[^}]*\}\s+from\s+['"][^.][^'"]*['"]\s*;?\s*$/gm,
    ''
  );

  // Strip `export type { X } from '...'` for external packages
  // (the types are available from the other declare module blocks)
  // But keep `export * from '@...'` as those re-export from declared modules

  // Remove `declare` keyword — it's redundant inside `declare module`
  content = content.replace(/^export declare /gm, 'export ');

  // Clean up multiple blank lines
  content = content.replace(/\n{3,}/g, '\n\n');

  return content.trim();
}

/**
 * Resolve a relative .d.ts import path against the importing file's path.
 * Handles .js -> .d.ts extension mapping.
 */
function resolveRelativeDts(fromPath, relativePath) {
  // Convert .js extension to .d.ts
  let resolved = relativePath.replace(/\.js$/, '.d.ts');

  // Resolve relative to the importing file's directory
  const fromDir = fromPath.replace(/\/[^/]+$/, '/');
  if (resolved.startsWith('./')) {
    resolved = fromDir + resolved.slice(2);
  } else if (resolved.startsWith('../')) {
    // Handle ../ by going up from fromDir
    const parts = fromDir.split('/').filter(Boolean);
    const relParts = resolved.split('/');
    for (const part of relParts) {
      if (part === '..') {
        parts.pop();
      } else if (part !== '.') {
        parts.push(part);
      }
    }
    resolved = './' + parts.join('/');
  }

  return resolved;
}

// Build the output
const declareModules = [];
let totalFiles = 0;

for (const pkgConfig of PACKAGES) {
  const { dir, modules } = pkgConfig;
  const pkgDir = new URL(`${dir}/`, packagesDir);

  if (!existsSync(pkgDir)) {
    console.warn(`Skipping ${dir}: directory not found`);
    continue;
  }

  console.log(`Processing ${dir}...`);

  for (const [moduleName, dtsPath] of Object.entries(modules)) {
    const content = readDtsForModule(pkgDir, dtsPath);
    if (content) {
      declareModules.push({ moduleName, content });
      totalFiles++;
      console.log(`  "${moduleName}" -> ${dtsPath}`);
    }
  }
}

// Build the final declarations string
let declarations = '// Auto-generated by scripts/generate-monaco-types.js\n\n';

// Add third-party type stubs
declarations += `
declare module "ms" {
  export type StringValue =
    | \`\${number}ms\`
    | \`\${number}s\`
    | \`\${number}m\`
    | \`\${number}h\`
    | \`\${number}d\`
    | \`\${number}w\`
    | \`\${number}y\`
    | (string & {});
}

declare module "@standard-schema/spec" {
  export interface StandardSchemaV1<Input = unknown, Output = Input> {
    readonly "~standard": StandardSchemaV1.Props<Input, Output>;
  }
  export namespace StandardSchemaV1 {
    interface Props<Input = unknown, Output = Input> {
      readonly version: 1;
      readonly vendor: string;
      readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>;
      readonly types?: Types<Input, Output>;
    }
    interface Types<Input = unknown, Output = Input> {
      readonly input: Input;
      readonly output: Output;
    }
    type Result<Output> = SuccessResult<Output> | FailureResult;
    interface SuccessResult<Output> { readonly value: Output; readonly issues?: undefined; }
    interface FailureResult { readonly issues: readonly Issue[]; }
    interface Issue { readonly message: string; readonly path?: readonly (string | number | symbol)[]; }
  }
}

`;

// Add workspace package declarations
for (const { moduleName, content } of declareModules) {
  declarations += `declare module "${moduleName}" {\n`;
  // Indent the content
  const indented = content
    .split('\n')
    .map((line) => (line.trim() ? `  ${line}` : ''))
    .join('\n');
  declarations += indented;
  declarations += `\n}\n\n`;
}

// Collect @types/node declarations (recursively, including subdirectories
// like fs/promises.d.ts, stream/web.d.ts, etc.)
const nodeTypesDir = new URL('../node_modules/@types/node/', import.meta.url);
const nodeTypesFiles = [];

function collectNodeTypes(dirUrl, relativeTo) {
  const entries = readdirSync(dirUrl, { withFileTypes: true });
  for (const entry of entries) {
    const entryUrl = new URL(
      `${entry.name}${entry.isDirectory() ? '/' : ''}`,
      dirUrl
    );
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      collectNodeTypes(entryUrl, relativeTo);
    } else if (entry.name.endsWith('.d.ts')) {
      const content = readFileSync(entryUrl, 'utf-8');
      // Compute path relative to @types/node/
      const relPath = entryUrl.pathname.slice(relativeTo.pathname.length);
      nodeTypesFiles.push({ name: relPath, content });
    }
  }
}

if (existsSync(nodeTypesDir)) {
  console.log('Processing @types/node...');
  collectNodeTypes(nodeTypesDir, nodeTypesDir);
  console.log(`  Collected ${nodeTypesFiles.length} .d.ts files`);
} else {
  console.warn('  @types/node not found, skipping');
}

// Write output
const outputUrl = new URL('../lib/generated-types.ts', import.meta.url);
mkdirSync(new URL('.', outputUrl), { recursive: true });

const nodeTypes = nodeTypesFiles.map((f) => f.content).join('\n');

const output = `// Auto-generated by scripts/generate-monaco-types.js — DO NOT EDIT
export const typeDeclarations: string = ${JSON.stringify(declarations)};
export const nodeTypeDeclarations: Record<string, string> = ${JSON.stringify(
  Object.fromEntries(
    nodeTypesFiles.map((f) => [
      `file:///node_modules/@types/node/${f.name}`,
      f.content,
    ])
  )
)};
`;

writeFileSync(outputUrl, output);

const totalSize = declarations.length + nodeTypes.length;
console.log(
  `\nGenerated lib/generated-types.ts (${totalFiles} modules + @types/node, ${(totalSize / 1024).toFixed(1)}KB)`
);
