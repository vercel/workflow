/**
 * Generates a TypeScript file containing all type declarations from
 * workspace packages, for use with Monaco editor's `addExtraLib()` API.
 *
 * This reads the built `.d.ts` files from workspace packages and outputs
 * a map of virtual file paths to declaration content that Monaco's TypeScript
 * language service can resolve.
 *
 * Uses `declare module` ambient declarations for reliable module resolution
 * regardless of Monaco's internal URI scheme.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { relative } from 'node:path';

const packagesDir = new URL('../../../packages/', import.meta.url);

// Packages whose types should be available in the Monaco editor.
// Each entry maps a directory name under packages/ to configuration.
// `subExports` lists additional sub-path exports that should get
// their own `declare module` entry (e.g. "workflow/errors").
const PACKAGES = [
  { dir: 'world' },
  { dir: 'utils' },
  { dir: 'serde' },
  { dir: 'errors' },
  { dir: 'core' },
  {
    dir: 'workflow',
    subExports: {
      './api': './dist/api.d.ts',
      './errors': './dist/internal/errors.d.ts',
      './observability': './dist/observability.d.ts',
    },
  },
];

/**
 * Read the package.json for a given package directory name and return
 * the npm package name and path to the dist directory.
 */
function getPackageInfo(dirName) {
  const pkgJsonUrl = new URL(`${dirName}/package.json`, packagesDir);
  if (!existsSync(pkgJsonUrl)) {
    console.warn(`Skipping ${dirName}: no package.json found`);
    return null;
  }
  const pkgJson = JSON.parse(readFileSync(pkgJsonUrl, 'utf-8'));
  const distUrl = new URL(`${dirName}/dist/`, packagesDir);
  if (!existsSync(distUrl)) {
    console.warn(
      `Skipping ${dirName}: no dist/ directory found (run build first)`
    );
    return null;
  }
  return { name: pkgJson.name, pkgJson, distUrl };
}

/**
 * Recursively collect all .d.ts files in a directory, returning
 * an array of { relativePath, content } objects.
 */
function collectDtsFiles(dirUrl, baseUrl = dirUrl) {
  const results = [];
  const entries = readdirSync(dirUrl, { withFileTypes: true });

  for (const entry of entries) {
    const entryUrl = new URL(
      `${entry.name}${entry.isDirectory() ? '/' : ''}`,
      dirUrl
    );
    if (entry.isDirectory()) {
      results.push(...collectDtsFiles(entryUrl, baseUrl));
    } else if (entry.name.endsWith('.d.ts')) {
      const fullPath = entryUrl.pathname;
      const relPath = relative(baseUrl.pathname, fullPath);
      const content = readFileSync(entryUrl, 'utf-8');
      results.push({ relativePath: relPath, content });
    }
  }

  return results;
}

/**
 * Resolve the main types entry point for a package.
 * Checks exports["."].types first, then top-level types field,
 * then falls back to dist/index.d.ts.
 */
function resolveMainTypes(pkgJson) {
  const mainExport = pkgJson.exports?.['.'];
  if (mainExport) {
    if (typeof mainExport === 'object' && mainExport.types) {
      return mainExport.types;
    }
  }
  if (pkgJson.types) return pkgJson.types;
  return './dist/index.d.ts'; // fallback
}

// Build the type definitions map
const typeDefsMap = {};

// Track packages for ambient module declarations
const ambientModules = [];

for (const pkgConfig of PACKAGES) {
  const { dir, subExports } = pkgConfig;
  const info = getPackageInfo(dir);
  if (!info) continue;

  const { name, pkgJson, distUrl } = info;
  console.log(`Processing ${name} (${dir})...`);

  const mainTypes = resolveMainTypes(pkgJson);

  // Collect and register all .d.ts files from dist/
  const dtsFiles = collectDtsFiles(distUrl);
  for (const { relativePath, content } of dtsFiles) {
    const virtualPath = `file:///node_modules/${name}/dist/${relativePath}`;
    typeDefsMap[virtualPath] = content;
  }

  console.log(`  Registered ${dtsFiles.length} .d.ts files for ${name}`);

  // Track the main module for ambient declarations
  // Convert "./dist/index.d.ts" -> "file:///node_modules/<name>/dist/index.d.ts"
  const mainDtsPath = mainTypes.replace(
    /^\.\//,
    `file:///node_modules/${name}/`
  );
  ambientModules.push({ moduleName: name, dtsPath: mainDtsPath });

  // Handle sub-exports (e.g. "workflow/api", "workflow/errors")
  if (subExports) {
    for (const [subPath, subTypes] of Object.entries(subExports)) {
      const subModuleName = `${name}/${subPath.replace(/^\.\//, '')}`;
      const subDtsPath = subTypes.replace(
        /^\.\//,
        `file:///node_modules/${name}/`
      );
      ambientModules.push({ moduleName: subModuleName, dtsPath: subDtsPath });
    }
  }
}

// Generate the ambient module declarations file.
// This tells TypeScript's language service where to find types for
// bare module imports like `import { sleep } from "workflow"`.
// Using `declare module` is the most reliable approach for Monaco
// as it works regardless of module resolution configuration.
const ambientLines = [
  '// Ambient module declarations for Monaco editor.',
  '// Maps bare import specifiers to their type declaration files.',
  '',
];
for (const { moduleName, dtsPath } of ambientModules) {
  ambientLines.push(`declare module "${moduleName}" {`);
  ambientLines.push(`  export * from "${dtsPath}";`);
  ambientLines.push(`}`);
  ambientLines.push('');
}

typeDefsMap['file:///node_modules/@types/workflow-ambient/index.d.ts'] =
  ambientLines.join('\n');

// Register stub types for third-party packages referenced by the .d.ts files.
typeDefsMap['file:///node_modules/ms/index.d.ts'] = `
export type StringValue =
  | \`\${number}ms\`
  | \`\${number}s\`
  | \`\${number}m\`
  | \`\${number}h\`
  | \`\${number}d\`
  | \`\${number}w\`
  | \`\${number}y\`
  | (string & {});
`;

typeDefsMap['file:///node_modules/@standard-schema/spec/index.d.ts'] = `
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardSchemaV1.Props<Input, Output>;
}
export declare namespace StandardSchemaV1 {
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
`;

// Write the output file
const outputUrl = new URL('../lib/generated-types.ts', import.meta.url);
mkdirSync(new URL('.', outputUrl), { recursive: true });

const output = `// Auto-generated by scripts/generate-monaco-types.js — DO NOT EDIT
export const typeDefinitions: Record<string, string> = ${JSON.stringify(typeDefsMap, null, 2)};
`;

writeFileSync(outputUrl, output);

const totalFiles = Object.keys(typeDefsMap).length;
const totalSize = Object.values(typeDefsMap).reduce(
  (acc, v) => acc + v.length,
  0
);
console.log(
  `\nGenerated lib/generated-types.ts (${totalFiles} files, ${(totalSize / 1024).toFixed(1)}KB of type content)`
);

// Show ambient modules registered
console.log(`Ambient module declarations:`);
for (const { moduleName } of ambientModules) {
  console.log(`  "${moduleName}"`);
}
