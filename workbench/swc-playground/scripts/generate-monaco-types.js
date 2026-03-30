/**
 * Generates a TypeScript file containing all type declarations from
 * workspace packages, for use with Monaco editor's `addExtraLib()` API.
 *
 * This reads the built `.d.ts` files from packages/workflow, packages/core,
 * and packages/errors (and their transitive type dependencies), and outputs
 * a map of virtual file paths to declaration content that Monaco's TypeScript
 * language service can resolve.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';

const packagesDir = new URL('../../../packages/', import.meta.url);

// Packages whose types should be available in the Monaco editor.
// Includes transitive type dependencies so Monaco can resolve
// cross-package type imports.
const PACKAGES = [
  'world', // @workflow/world (types used by @workflow/core and @workflow/errors)
  'utils', // @workflow/utils (types used by @workflow/core)
  'errors', // @workflow/errors
  'core', // @workflow/core
  'workflow', // workflow
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

// Build the type definitions map
const typeDefsMap = {};

for (const dirName of PACKAGES) {
  const info = getPackageInfo(dirName);
  if (!info) continue;

  const { name, pkgJson, distUrl } = info;
  console.log(`Processing ${name} (${dirName})...`);

  // Register a virtual package.json so Monaco's resolver can find the types
  // Use the "types" field from exports["."] if available, otherwise fall back
  // to the top-level "types" field.
  let mainTypes = pkgJson.types;
  const mainExport = pkgJson.exports?.['.'];
  if (mainExport) {
    if (typeof mainExport === 'object' && mainExport.types) {
      mainTypes = mainExport.types;
    }
  }

  // Register a virtual package.json for the package
  if (mainTypes) {
    typeDefsMap[`file:///node_modules/${name}/package.json`] = JSON.stringify({
      name,
      types: mainTypes,
    });
  }

  // Collect and register all .d.ts files from dist/
  const dtsFiles = collectDtsFiles(distUrl);
  for (const { relativePath, content } of dtsFiles) {
    const virtualPath = `file:///node_modules/${name}/dist/${relativePath}`;
    typeDefsMap[virtualPath] = content;
  }

  // Also register the main entry at the root index.d.ts path.
  // Monaco's NodeJs module resolution looks for node_modules/<pkg>/index.d.ts
  // when it can't resolve via package.json exports. This ensures bare
  // imports like `import { sleep } from 'workflow'` resolve correctly.
  if (mainTypes) {
    const mainDtsFile = dtsFiles.find(
      (f) => `./dist/${f.relativePath}` === mainTypes
    );
    if (mainDtsFile) {
      typeDefsMap[`file:///node_modules/${name}/index.d.ts`] =
        mainDtsFile.content;
    }
  }

  console.log(`  Registered ${dtsFiles.length} .d.ts files for ${name}`);
}

// Register stub types for third-party packages referenced by the .d.ts files.
// These are minimal stubs sufficient to suppress unresolved import errors.
// and it would show as an unresolved import in the .d.ts files.
// The `ms` package exports a `StringValue` type that represents duration strings.
typeDefsMap['file:///node_modules/ms/index.d.ts'] = `
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
export = ms;
export as namespace ms;
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
