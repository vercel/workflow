import { access, readFile, stat } from 'node:fs/promises';
import { builtinModules, createRequire } from 'node:module';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parse as parseWithSwc } from '@swc/core';
import enhancedResolveOriginal from 'enhanced-resolve';
import { findUp } from 'find-up';
import JSON5 from 'json5';
import { importParents } from './discover-entries-esbuild-plugin.js';
import {
  detectWorkflowPatterns,
  stripCommentsFromSource,
} from './transform-utils.js';
import { resolveTsconfigExtendsPath } from './tsconfig-extends.js';

const FAST_DISCOVERY_SOURCE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
];
const FAST_DISCOVERY_SOURCE_EXTENSION_SET = new Set(
  FAST_DISCOVERY_SOURCE_EXTENSIONS
);
const fastDiscoveryResolve = promisify(
  enhancedResolveOriginal.create({
    extensions: [...FAST_DISCOVERY_SOURCE_EXTENSIONS, '.json', '.node'],
    fullySpecified: false,
    conditionNames: ['node', 'import', 'require'],
  })
);
const require = createRequire(import.meta.url);
// What resolving an import returns for a package discovery does not follow.
const UNFOLLOWED_PACKAGE = Symbol('unfollowed package');

const FAST_DISCOVERY_READ_CONCURRENCY = 32;
const FAST_DISCOVERY_RESOLVE_CONCURRENCY = 32;
const FAST_DISCOVERY_FILE_CONCURRENCY = 128;
const PACKAGE_JSON = 'package.json';
const NODE_BUILTIN_SPECIFIERS = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
]);
const IMPORT_SPECIFIER_PATTERNS = [
  /\bfrom\s+['"]([^'"]+)['"]/g,
  /(?:^|[;\n])\s*import\s+['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];
const TYPESCRIPT_SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
// Matches `import type`, `export type`, inline `{ type X` specifiers, and
// `import(` (which is also how a `typeof import('x')` type reference starts).
const POSSIBLE_TYPE_ONLY_IMPORT_PATTERN =
  /\b(?:import|export)\s+type\b|[{,]\s*type\s+[\w$]|\bimport\s*\(/;

export interface DiscoveredEntries {
  discoveredSteps: Set<string>;
  discoveredWorkflows: Set<string>;
  discoveredSerdeFiles: Set<string>;
  /**
   * All JS/TS files visited while walking the workflow import graph.
   * Watch-mode integrations use this to distinguish relevant HMR changes from
   * unrelated application file edits.
   */
  discoveredFiles?: Set<string>;
  /**
   * Paths an import in the graph would resolve to if the file existed, for
   * relative and tsconfig-alias imports that did not resolve. An import can be
   * written before its target is created, or outlive a target that was deleted:
   * either way the graph stops at the importer, and only the appearance of one
   * of these paths can extend it again. Watch-mode integrations track them.
   */
  unresolvedImportCandidates?: Set<string>;
}

interface FastDiscoverEntriesOptions {
  entryPoints: string[];
  state: DiscoveredEntries;
  defaultTsconfigPath: string | undefined;
  workingDir: string;
  /**
   * Whether workflow discovery descends into `node_modules`. When `false`,
   * imports from application code that resolve into `node_modules` are not
   * followed, so no dependency file is read, scanned, or registered: third
   * party workflow/step/serde code is neither transformed nor bundled. Imports
   * *within* `node_modules` are still followed, so the SDK's own seeded runtime
   * serde entry keeps discovering its transitive classes. Defaults to `true`.
   */
  discoverWorkflowsInNodeModules?: boolean;
}

interface PackageInfo {
  root: string;
  hasWorkflowDependency: boolean;
}

interface TsconfigPathAlias {
  pattern: string;
  patternParts: string[];
  targets: Array<{
    template: string;
    parts: string[];
  }>;
}

interface TsconfigPathAliasLoadResult {
  aliases: TsconfigPathAlias[];
  baseUrl: string | undefined;
}

function createLimiter(concurrency: number) {
  let activeCount = 0;
  const queue: Array<() => void> = [];

  const acquire = async () => {
    await new Promise<void>((resolve) => {
      const run = () => {
        activeCount++;
        resolve();
      };

      if (activeCount < concurrency) {
        run();
      } else {
        queue.push(run);
      }
    });
  };

  const release = () => {
    activeCount--;
    const next = queue.shift();
    if (next) {
      next();
    }
  };

  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function isJsTsFile(filePath: string): boolean {
  return FAST_DISCOVERY_SOURCE_EXTENSION_SET.has(extname(filePath));
}

function isRelativeOrAbsoluteSpecifier(specifier: string): boolean {
  return specifier.startsWith('.') || isAbsolute(specifier);
}

function getPackageNameFromSpecifier(specifier: string): string | null {
  const strippedSpecifier = stripImportSpecifierQuery(specifier);
  if (isRelativeOrAbsoluteSpecifier(strippedSpecifier)) {
    return null;
  }

  if (strippedSpecifier.startsWith('@')) {
    const [scope, name] = strippedSpecifier.split('/');
    return scope && name ? `${scope}/${name}` : null;
  }

  return strippedSpecifier.split('/')[0] || null;
}

function stripImportSpecifierQuery(specifier: string): string {
  const queryIndex = specifier.indexOf('?');
  const hashIndex = specifier.indexOf('#');
  const endIndex =
    queryIndex === -1
      ? hashIndex
      : hashIndex === -1
        ? queryIndex
        : Math.min(queryIndex, hashIndex);
  return endIndex === -1 ? specifier : specifier.slice(0, endIndex);
}

function matchTsconfigPathAlias(
  specifier: string,
  alias: TsconfigPathAlias
): string[] | null {
  if (alias.patternParts.length === 1) {
    return specifier === alias.pattern ? [] : null;
  }

  const captures: string[] = [];
  let position = 0;
  const firstPart = alias.patternParts[0];
  if (!specifier.startsWith(firstPart)) {
    return null;
  }
  position = firstPart.length;

  for (let i = 1; i < alias.patternParts.length; i++) {
    const part = alias.patternParts[i];
    if (i === alias.patternParts.length - 1) {
      if (!specifier.endsWith(part)) {
        return null;
      }
      captures.push(specifier.slice(position, specifier.length - part.length));
      return captures;
    }

    const nextIndex = specifier.indexOf(part, position);
    if (nextIndex === -1) {
      return null;
    }
    captures.push(specifier.slice(position, nextIndex));
    position = nextIndex + part.length;
  }

  return captures;
}

function applyTsconfigPathTarget(
  target: TsconfigPathAlias['targets'][number],
  captures: string[]
): string {
  if (target.parts.length === 1) {
    return target.template;
  }

  let resolved = target.parts[0];
  for (let i = 1; i < target.parts.length; i++) {
    resolved += (captures[i - 1] ?? '') + target.parts[i];
  }
  return resolved;
}

function isGeneratedBuildArtifactPath(filePath: string): boolean {
  const normalizedPath = normalizePath(filePath);
  return (
    normalizedPath.includes('/.nitro/') ||
    normalizedPath.includes('/.output/') ||
    normalizedPath.includes('/.next/') ||
    normalizedPath.includes('/.nuxt/') ||
    normalizedPath.includes('/.svelte-kit/') ||
    normalizedPath.includes('/.vercel/') ||
    normalizedPath.includes('/.well-known/workflow/')
  );
}

function isNodeModulesPath(filePath: string): boolean {
  const normalizedPath = normalizePath(filePath);
  return (
    normalizedPath.includes('/node_modules/') ||
    normalizedPath.includes('/.pnpm/')
  );
}

function addImportParent(parent: string, child: string): void {
  const normalizedParent = normalizePath(parent);
  const normalizedChild = normalizePath(child);
  let children = importParents.get(normalizedParent);
  if (!children) {
    children = new Set<string>();
    importParents.set(normalizedParent, children);
  }
  children.add(normalizedChild);
}

function extractImportSpecifiers(source: string): string[] {
  const sourceWithoutComments = stripCommentsFromSource(source);
  if (
    !sourceWithoutComments.includes('import') &&
    !sourceWithoutComments.includes('require') &&
    !sourceWithoutComments.includes('from')
  ) {
    return [];
  }

  const specifiers = new Set<string>();

  for (const importPattern of IMPORT_SPECIFIER_PATTERNS) {
    for (const match of sourceWithoutComments.matchAll(importPattern)) {
      const specifier = match[1];
      if (specifier) {
        specifiers.add(specifier);
      }
    }
  }

  return Array.from(specifiers);
}

type AstNode = { type?: unknown; [key: string]: unknown };

function stringLiteralValue(node: unknown): string | undefined {
  const literal = node as AstNode | null | undefined;
  return literal?.type === 'StringLiteral' && typeof literal.value === 'string'
    ? literal.value
    : undefined;
}

function hasValueSpecifier(specifiers: unknown): boolean {
  if (!Array.isArray(specifiers) || specifiers.length === 0) {
    return true;
  }
  return specifiers.some((specifier) => !specifier?.isTypeOnly);
}

interface AstNodeVisit {
  /** A module specifier this node loads at runtime. */
  specifier?: string;
  /** Whether the walk continues into this node's children. */
  descend: boolean;
}

const SKIP_NODE: AstNodeVisit = { descend: false };

function visitStaticImport(node: AstNode): AstNodeVisit {
  const source = stringLiteralValue(node.source);
  if (source === undefined) {
    // `export { x }` without `from` can only reference local bindings.
    return { descend: true };
  }
  const isRuntime = !node.typeOnly && hasValueSpecifier(node.specifiers);
  return { specifier: isRuntime ? source : undefined, descend: false };
}

function visitExportAll(node: AstNode): AstNodeVisit {
  const source = stringLiteralValue(node.source);
  return { specifier: node.typeOnly ? undefined : source, descend: false };
}

function visitImportEquals(node: AstNode): AstNodeVisit {
  const moduleRef = node.moduleRef as AstNode | undefined;
  if (node.isTypeOnly || moduleRef?.type !== 'TsExternalModuleReference') {
    return SKIP_NODE;
  }
  return {
    specifier: stringLiteralValue(moduleRef.expression),
    descend: false,
  };
}

function visitModuleDeclaration(node: AstNode): AstNodeVisit {
  return { descend: !node.declare };
}

function isRequireCallee(callee: AstNode | undefined): boolean {
  if (callee?.type === 'Identifier') {
    return callee.value === 'require';
  }
  if (callee?.type === 'MemberExpression') {
    // `<expr>.require(...)`, e.g. `module.require`; SWC marks `<expr>['require']` as `Computed`.
    const property = callee.property as AstNode | undefined;
    return property?.type === 'Identifier' && property.value === 'require';
  }
  return false;
}

function visitCall(node: AstNode): AstNodeVisit {
  const callee = node.callee as AstNode | undefined;
  const isImportOrRequire =
    callee?.type === 'Import' || isRequireCallee(callee);
  if (!isImportOrRequire || !Array.isArray(node.arguments)) {
    return { descend: true };
  }
  const firstArgument = node.arguments[0] as AstNode | undefined;
  return {
    specifier: stringLiteralValue(firstArgument?.expression),
    descend: true,
  };
}

const AST_NODE_VISITORS: Record<string, (node: AstNode) => AstNodeVisit> = {
  ImportDeclaration: visitStaticImport,
  ExportNamedDeclaration: visitStaticImport,
  ExportAllDeclaration: visitExportAll,
  TsImportEqualsDeclaration: visitImportEquals,
  TsModuleDeclaration: visitModuleDeclaration,
  CallExpression: visitCall,
  // Type positions: nothing below these nodes is evaluated at runtime.
  TsImportType: () => SKIP_NODE,
  TsTypeAnnotation: () => SKIP_NODE,
  TsTypeAliasDeclaration: () => SKIP_NODE,
  TsInterfaceDeclaration: () => SKIP_NODE,
};

/**
 * Collects the import specifiers of a parsed TypeScript module that survive
 * type erasure: static imports and re-exports with at least one value
 * binding (or none, for side-effect imports), `import x = require()`, and
 * string-literal `import()` / `require()` calls. Type-only imports and
 * re-exports, `typeof import()` and `import()` types, and imports inside
 * ambient `declare module` blocks are skipped.
 */
function collectRuntimeImportSpecifiers(
  node: unknown,
  specifiers: Set<string>
): void {
  if (Array.isArray(node)) {
    for (const child of node) {
      collectRuntimeImportSpecifiers(child, specifiers);
    }
    return;
  }
  if (!node || typeof node !== 'object') {
    return;
  }

  const astNode = node as AstNode;
  const visitor =
    typeof astNode.type === 'string'
      ? AST_NODE_VISITORS[astNode.type]
      : undefined;
  if (visitor) {
    const visit = visitor(astNode);
    if (visit.specifier !== undefined) {
      specifiers.add(visit.specifier);
    }
    if (!visit.descend) {
      return;
    }
  }

  for (const key in astNode) {
    if (key !== 'span' && key !== 'type') {
      collectRuntimeImportSpecifiers(astNode[key], specifiers);
    }
  }
}

/**
 * Returns the import specifiers a file needs at runtime. The regex scan is
 * used as is, except for TypeScript files whose source may contain type-only
 * import syntax: those are parsed with SWC so that type-only references are
 * left out. If parsing fails, the regex scan result is returned.
 */
async function extractRuntimeImportSpecifiers(
  filePath: string,
  source: string
): Promise<string[]> {
  const specifiers = extractImportSpecifiers(source);
  const extension = extname(filePath).toLowerCase();
  if (
    specifiers.length === 0 ||
    !TYPESCRIPT_SOURCE_EXTENSIONS.has(extension) ||
    !POSSIBLE_TYPE_ONLY_IMPORT_PATTERN.test(stripCommentsFromSource(source))
  ) {
    return specifiers;
  }

  try {
    const program = await parseWithSwc(source, {
      syntax: 'typescript',
      tsx: extension === '.tsx',
      target: 'es2022',
    });
    const runtimeSpecifiers = new Set<string>();
    collectRuntimeImportSpecifiers(program.body, runtimeSpecifiers);
    return Array.from(runtimeSpecifiers);
  } catch {
    return specifiers;
  }
}

function hasWorkflowDependency(dependencies: unknown): boolean {
  if (
    typeof dependencies !== 'object' ||
    dependencies === null ||
    Array.isArray(dependencies)
  ) {
    return false;
  }

  return Object.keys(dependencies).some(
    (dependency) =>
      dependency === 'workflow' || dependency.startsWith('@workflow/')
  );
}

// Matched against source with quoted strings masked, so the symbol name is
// blank here and is checked against the original source at the same offsets.
const MASKED_SYMBOL_FOR_SERDE_METHOD =
  /static\s+\[\s*Symbol\.for\s*\(\s*(['"])\s*\1\s*\)\s*\]\s*\(/g;
const SYMBOL_FOR_SERDE_METHOD =
  /^static\s+\[\s*Symbol\.for\s*\(\s*['"]workflow-(?:serialize|deserialize)['"]\s*\)\s*\]\s*\($/;

function hasLikelySerdeClass(source: string): boolean {
  if (!source.includes('static') || !source.includes('[')) {
    return false;
  }

  // Class shapes are matched against code only, never string contents. The
  // scanner output has the same length as the source, so offsets line up.
  const codeOnlySource = stripCommentsFromSource(source, true, true);
  if (
    /static\s+\[\s*WORKFLOW_(?:SERIALIZE|DESERIALIZE)\s*\]\s*\(/.test(
      codeOnlySource
    )
  ) {
    return true;
  }
  for (const match of codeOnlySource.matchAll(MASKED_SYMBOL_FOR_SERDE_METHOD)) {
    const original = source.slice(match.index, match.index + match[0].length);
    if (SYMBOL_FOR_SERDE_METHOD.test(original)) {
      return true;
    }
  }

  if (
    !/from\s+['"]@workflow\/serde['"]|require\s*\(\s*['"]@workflow\/serde['"]\s*\)/.test(
      stripCommentsFromSource(source)
    )
  ) {
    return false;
  }

  return /static\s+\[\s*[$A-Z_a-z][$\w]*\s*\]\s*\(/.test(codeOnlySource);
}

async function loadTsconfigPathAliases(
  tsconfigPath: string | undefined,
  seen = new Set<string>()
): Promise<TsconfigPathAlias[]> {
  if (!tsconfigPath) {
    return [];
  }

  return (await loadTsconfigPathAliasConfig(tsconfigPath, seen)).aliases;
}

async function loadTsconfigPathAliasConfig(
  tsconfigPath: string,
  seen: Set<string>
): Promise<TsconfigPathAliasLoadResult> {
  const normalizedTsconfigPath = resolve(tsconfigPath);
  if (seen.has(normalizedTsconfigPath)) {
    return { aliases: [], baseUrl: undefined };
  }

  seen.add(normalizedTsconfigPath);

  try {
    const source = await readFile(normalizedTsconfigPath, 'utf8');
    const parsed = JSON5.parse(source) as {
      extends?: unknown;
      compilerOptions?: {
        baseUrl?: unknown;
        paths?: unknown;
      };
    };
    const compilerOptions = parsed.compilerOptions;

    let baseConfig: TsconfigPathAliasLoadResult = {
      aliases: [],
      baseUrl: undefined,
    };
    if (typeof parsed.extends === 'string') {
      const baseTsconfigPath = await resolveTsconfigExtendsPath(
        parsed.extends,
        normalizedTsconfigPath
      );
      if (baseTsconfigPath) {
        baseConfig = await loadTsconfigPathAliasConfig(baseTsconfigPath, seen);
      }
    }

    const baseUrl =
      typeof compilerOptions?.baseUrl === 'string'
        ? resolve(dirname(normalizedTsconfigPath), compilerOptions.baseUrl)
        : baseConfig.baseUrl;

    if (
      !compilerOptions ||
      typeof compilerOptions.paths !== 'object' ||
      compilerOptions.paths === null ||
      Array.isArray(compilerOptions.paths)
    ) {
      return {
        aliases: baseConfig.aliases,
        baseUrl,
      };
    }

    const baseDir = baseUrl ?? dirname(normalizedTsconfigPath);
    const aliases: TsconfigPathAlias[] = [];

    for (const [pattern, rawTargets] of Object.entries(compilerOptions.paths)) {
      if (!Array.isArray(rawTargets)) {
        continue;
      }

      const targets = rawTargets
        .filter((target): target is string => typeof target === 'string')
        .map((target) => {
          const template = resolve(baseDir, target);
          return {
            template,
            parts: template.split('*'),
          };
        });
      if (targets.length === 0) {
        continue;
      }

      aliases.push({
        pattern,
        patternParts: pattern.split('*'),
        targets,
      });
    }

    return { aliases, baseUrl };
  } catch {
    return { aliases: [], baseUrl: undefined };
  } finally {
    seen.delete(normalizedTsconfigPath);
  }
}

async function findPackageInfo(
  filePath: string,
  packageInfoCache: Map<string, Promise<PackageInfo | null>>
): Promise<PackageInfo | null> {
  let currentDir = dirname(filePath);

  while (currentDir && currentDir !== dirname(currentDir)) {
    const cached = packageInfoCache.get(currentDir);
    if (cached) {
      const cachedInfo = await cached;
      if (cachedInfo) {
        return cachedInfo;
      }
      currentDir = dirname(currentDir);
      continue;
    }

    const packageJsonPath = join(currentDir, PACKAGE_JSON);
    const packageInfoPromise = readFile(packageJsonPath, 'utf8')
      .then((source): PackageInfo => {
        const parsed = JSON.parse(source) as {
          name?: unknown;
          dependencies?: unknown;
          peerDependencies?: unknown;
          optionalDependencies?: unknown;
          devDependencies?: unknown;
        };
        const packageName = typeof parsed.name === 'string' ? parsed.name : '';
        return {
          root: normalizePath(currentDir),
          hasWorkflowDependency:
            packageName === 'workflow' ||
            packageName.startsWith('@workflow/') ||
            hasWorkflowDependency(parsed.dependencies) ||
            hasWorkflowDependency(parsed.peerDependencies) ||
            hasWorkflowDependency(parsed.optionalDependencies) ||
            hasWorkflowDependency(parsed.devDependencies),
        };
      })
      .catch(() => null);

    packageInfoCache.set(currentDir, packageInfoPromise);
    const packageInfo = await packageInfoPromise;
    if (packageInfo) {
      return packageInfo;
    }

    currentDir = dirname(currentDir);
  }

  return null;
}

export async function fastDiscoverEntries({
  entryPoints,
  state,
  defaultTsconfigPath,
  workingDir,
  discoverWorkflowsInNodeModules = true,
}: FastDiscoverEntriesOptions): Promise<void> {
  const readLimit = createLimiter(FAST_DISCOVERY_READ_CONCURRENCY);
  const resolveLimit = createLimiter(FAST_DISCOVERY_RESOLVE_CONCURRENCY);
  const resolveCache = new Map<
    string,
    Promise<string | typeof UNFOLLOWED_PACKAGE | null>
  >();
  const unfollowedPackageSerdeChecks = new Map<string, Promise<void>>();
  const checkedUnfollowedPackageFiles = new Set<string>();
  const fileExistsCache = new Map<string, Promise<boolean>>();
  const tsconfigPathByDirCache = new Map<string, Promise<string | undefined>>();
  const tsconfigAliasesCache = new Map<string, Promise<TsconfigPathAlias[]>>();
  const packageInfoCache = new Map<string, Promise<PackageInfo | null>>();
  const packageSpecifierInfoCache = new Map<
    string,
    Promise<PackageInfo | null>
  >();
  const queuedFiles = new Set<string>();
  const processedFiles = new Set<string>();
  const queue: string[] = [];
  const enqueueFile = (filePath: string | undefined | null): void => {
    if (!filePath) return;
    const normalizedPath = normalizePath(filePath);
    if (
      queuedFiles.has(normalizedPath) ||
      processedFiles.has(normalizedPath) ||
      !isJsTsFile(normalizedPath) ||
      isGeneratedBuildArtifactPath(normalizedPath)
    ) {
      return;
    }
    queuedFiles.add(normalizedPath);
    queue.push(normalizedPath);
  };

  const unresolvedImportCandidates = new Set<string>();

  const readSource = async (filePath: string): Promise<string | null> => {
    return await readLimit(async () => {
      try {
        return await readFile(filePath, 'utf8');
      } catch {
        return null;
      }
    });
  };

  const fileExists = (filePath: string): Promise<boolean> => {
    const cached = fileExistsCache.get(filePath);
    if (cached) {
      return cached;
    }

    const promise = readLimit(async () => {
      try {
        await access(filePath);
        return true;
      } catch {
        return false;
      }
    });
    fileExistsCache.set(filePath, promise);
    return promise;
  };

  const isExistingFile = (filePath: string): Promise<boolean> =>
    readLimit(async () => {
      try {
        return (await stat(filePath)).isFile();
      } catch {
        return false;
      }
    });

  const resolveBasePath = (importer: string, specifier: string) => {
    const strippedSpecifier = stripImportSpecifierQuery(specifier);
    return isAbsolute(strippedSpecifier)
      ? strippedSpecifier
      : resolve(dirname(importer), strippedSpecifier);
  };

  /** Every source path `resolvePathLikeSpecifier` would accept for `basePath`. */
  const pathLikeCandidates = (basePath: string): string[] =>
    FAST_DISCOVERY_SOURCE_EXTENSION_SET.has(extname(basePath))
      ? [basePath]
      : [
          ...FAST_DISCOVERY_SOURCE_EXTENSIONS.map(
            (candidateExtension) => `${basePath}${candidateExtension}`
          ),
          ...FAST_DISCOVERY_SOURCE_EXTENSIONS.map((candidateExtension) =>
            join(basePath, `index${candidateExtension}`)
          ),
        ];

  const recordUnresolved = async (basePaths: string[]): Promise<void> => {
    for (const basePath of basePaths) {
      // An existing non-source file (a stylesheet, an image) is an import that
      // resolved to something discovery does not follow, not a missing module.
      if (
        !FAST_DISCOVERY_SOURCE_EXTENSION_SET.has(extname(basePath)) &&
        (await isExistingFile(basePath))
      ) {
        continue;
      }
      for (const candidate of pathLikeCandidates(basePath)) {
        unresolvedImportCandidates.add(normalizePath(candidate));
      }
    }
  };

  const findTsconfigPathForImporter = (
    importer: string
  ): Promise<string | undefined> => {
    if (isNodeModulesPath(importer)) {
      return Promise.resolve(defaultTsconfigPath);
    }

    const importerDir = dirname(importer);
    const cached = tsconfigPathByDirCache.get(importerDir);
    if (cached) {
      return cached;
    }

    const promise = findUp(['tsconfig.json', 'jsconfig.json'], {
      cwd: importerDir,
    }).then((found) => found ?? defaultTsconfigPath);
    tsconfigPathByDirCache.set(importerDir, promise);
    return promise;
  };

  const loadAliasesForTsconfig = (
    configPath: string | undefined
  ): Promise<TsconfigPathAlias[]> => {
    if (!configPath) {
      return Promise.resolve([]);
    }

    const cached = tsconfigAliasesCache.get(configPath);
    if (cached) {
      return cached;
    }

    const promise = loadTsconfigPathAliases(configPath);
    tsconfigAliasesCache.set(configPath, promise);
    return promise;
  };

  const resolvePathLikeSpecifier = async (
    importer: string,
    specifier: string
  ): Promise<string | null> => {
    for (const candidate of pathLikeCandidates(
      resolveBasePath(importer, specifier)
    )) {
      if (await fileExists(candidate)) {
        return normalizePath(candidate);
      }
    }

    return null;
  };

  /**
   * Resolve through the importer's tsconfig `paths`. `basePaths` lists every
   * alias target that matched, so a caller that ends up with no resolution
   * knows where the module was expected to be.
   */
  const resolveWithTsconfigPaths = async (
    importer: string,
    specifier: string
  ): Promise<{ resolved: string | null; basePaths: string[] }> => {
    const basePaths: string[] = [];
    if (specifier.startsWith('.') || isAbsolute(specifier)) {
      return { resolved: null, basePaths };
    }

    const tsconfigPath = await findTsconfigPathForImporter(importer);
    const tsconfigPathAliases = await loadAliasesForTsconfig(tsconfigPath);
    if (tsconfigPathAliases.length === 0) {
      return { resolved: null, basePaths };
    }

    for (const alias of tsconfigPathAliases) {
      const captures = matchTsconfigPathAlias(specifier, alias);
      if (!captures) {
        continue;
      }

      for (const target of alias.targets) {
        const targetPath = applyTsconfigPathTarget(target, captures);
        basePaths.push(resolveBasePath(importer, targetPath));
        try {
          const resolved = await resolvePathLikeSpecifier(importer, targetPath);
          if (resolved) {
            return { resolved, basePaths };
          }
        } catch {}
      }
    }

    return { resolved: null, basePaths };
  };

  const findPackageInfoBySpecifier = (
    packageName: string
  ): Promise<PackageInfo | null> => {
    const cached = packageSpecifierInfoCache.get(packageName);
    if (cached) {
      return cached;
    }

    const packageInfoPromise = (async () => {
      let packageJsonPath: string;
      try {
        packageJsonPath = require.resolve(`${packageName}/package.json`, {
          paths: [workingDir],
        });
      } catch {
        return null;
      }

      try {
        const source = await readLimit(() => readFile(packageJsonPath, 'utf8'));
        const parsed = JSON.parse(source) as {
          name?: unknown;
          dependencies?: unknown;
          peerDependencies?: unknown;
          optionalDependencies?: unknown;
          devDependencies?: unknown;
        };
        const parsedPackageName =
          typeof parsed.name === 'string' ? parsed.name : packageName;
        return {
          root: normalizePath(dirname(packageJsonPath)),
          hasWorkflowDependency:
            parsedPackageName === 'workflow' ||
            parsedPackageName.startsWith('@workflow/') ||
            hasWorkflowDependency(parsed.dependencies) ||
            hasWorkflowDependency(parsed.peerDependencies) ||
            hasWorkflowDependency(parsed.optionalDependencies) ||
            hasWorkflowDependency(parsed.devDependencies),
        };
      } catch {
        return null;
      }
    })();
    packageSpecifierInfoCache.set(packageName, packageInfoPromise);
    return packageInfoPromise;
  };

  const shouldResolveBareSpecifier = async (
    specifier: string
  ): Promise<boolean> => {
    const packageName = getPackageNameFromSpecifier(specifier);
    if (!packageName) {
      return true;
    }
    if (packageName === 'workflow' || packageName.startsWith('@workflow/')) {
      return true;
    }

    const packageInfo = await findPackageInfoBySpecifier(packageName);
    if (!packageInfo) {
      return true;
    }
    if (packageInfo.hasWorkflowDependency) {
      return true;
    }

    return false;
  };

  const resolveRelativeImport = async (
    importer: string,
    specifier: string
  ): Promise<string | null> => {
    const resolved = await resolvePathLikeSpecifier(importer, specifier);
    if (!resolved) {
      await recordUnresolved([resolveBasePath(importer, specifier)]);
    }
    return resolved;
  };

  const resolveBareSpecifier = async (
    importer: string,
    specifier: string
  ): Promise<string | null> => {
    try {
      const resolved = await fastDiscoveryResolve(dirname(importer), specifier);
      return typeof resolved === 'string' ? normalizePath(resolved) : null;
    } catch {
      return null;
    }
  };

  const resolveImport = (
    importer: string,
    specifier: string
  ): Promise<string | typeof UNFOLLOWED_PACKAGE | null> => {
    const cacheKey = `${dirname(importer)}\0${specifier}`;
    const cached = resolveCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const resolvedPromise = resolveLimit(async () => {
      if (isRelativeOrAbsoluteSpecifier(specifier)) {
        return resolveRelativeImport(importer, specifier);
      }

      const alias = await resolveWithTsconfigPaths(importer, specifier);
      if (alias.resolved) {
        return alias.resolved;
      }

      // An installed package discovery chooses not to follow is resolved as
      // far as the graph is concerned, even under a catch-all alias like `*`.
      if (!(await shouldResolveBareSpecifier(specifier))) {
        return UNFOLLOWED_PACKAGE;
      }

      const resolved = await resolveBareSpecifier(importer, specifier);
      if (!resolved) {
        await recordUnresolved(alias.basePaths);
      }
      return resolved;
    });
    resolveCache.set(cacheKey, resolvedPromise);
    return resolvedPromise;
  };

  const shouldFollowImportsFromFile = async (
    importer: string,
    forceFollow: boolean
  ): Promise<boolean> => {
    if (forceFollow) {
      return true;
    }
    if (!isNodeModulesPath(importer)) {
      return true;
    }

    const packageInfo = await findPackageInfo(importer, packageInfoCache);
    return packageInfo?.hasWorkflowDependency === true;
  };

  /**
   * Discovery does not walk packages with no `workflow` dependency, but such a
   * package can still define serde classes. AI SDK providers mark their models
   * with `static [WORKFLOW_SERIALIZE]` using symbols from
   * `@ai-sdk/provider-utils`, and depend on nothing from workflow.
   *
   * Those classes must be registered in the step bundle too. A model created
   * inside a `"use workflow"` body reaches a step as a serialized argument,
   * but the step-mode transform drops imports only the workflow body used, so
   * nothing in the step bundle imports the provider unless it is a serde file.
   *
   * So the one file the import resolves to is read, and recorded as a serde
   * file when it defines a serde class. Its own imports are not followed.
   */
  const discoverSerdeInUnfollowedPackage = (
    importer: string,
    specifier: string
  ): Promise<void> => {
    // Same opt-out as processImportSpecifier: application code reads nothing
    // from installed packages when descent into node_modules is disabled.
    if (!discoverWorkflowsInNodeModules && !isNodeModulesPath(importer)) {
      return Promise.resolve();
    }

    // The same specifier can resolve to different installed package versions
    // depending on the importer. Deduplicate reads by resolved path below.
    const cacheKey = `${dirname(importer)}\0${specifier}`;
    const cached = unfollowedPackageSerdeChecks.get(cacheKey);
    if (cached) {
      return cached;
    }

    const checkPromise = (async () => {
      const resolved = await resolveLimit(() =>
        resolveBareSpecifier(importer, specifier)
      );
      if (
        !resolved ||
        !isJsTsFile(resolved) ||
        isGeneratedBuildArtifactPath(resolved) ||
        checkedUnfollowedPackageFiles.has(resolved)
      ) {
        return;
      }
      checkedUnfollowedPackageFiles.add(resolved);

      const source = await readSource(resolved);
      if (source === null) {
        return;
      }
      if (
        detectWorkflowPatterns(source).hasSerde &&
        hasLikelySerdeClass(source)
      ) {
        state.discoveredSerdeFiles.add(resolved);
      }
    })();
    unfollowedPackageSerdeChecks.set(cacheKey, checkPromise);
    return checkPromise;
  };

  const processImportSpecifier = async (
    filePath: string,
    specifier: string,
    shouldFollow: boolean
  ): Promise<void> => {
    if (NODE_BUILTIN_SPECIFIERS.has(specifier)) {
      return;
    }
    if (!shouldFollow) {
      return;
    }

    const resolved = await resolveImport(filePath, specifier);
    if (resolved === UNFOLLOWED_PACKAGE) {
      await discoverSerdeInUnfollowedPackage(filePath, specifier);
      return;
    }
    if (!resolved) {
      return;
    }

    // Opt-out: don't descend into node_modules from application code. This
    // stops workflow discovery from reading, scanning, or following any
    // third-party dependency's file graph. Imports *within* node_modules are
    // still followed (importer already under node_modules), so the SDK's own
    // seeded runtime serde entry point keeps discovering its transitive
    // classes (e.g. `Run`) even though it lives under node_modules.
    if (
      !discoverWorkflowsInNodeModules &&
      isNodeModulesPath(resolved) &&
      !isNodeModulesPath(filePath)
    ) {
      return;
    }

    addImportParent(filePath, resolved);
    if (!isJsTsFile(resolved) || isGeneratedBuildArtifactPath(resolved)) {
      return;
    }

    enqueueFile(resolved);
  };

  const processFile = async (filePath: string): Promise<void> => {
    queuedFiles.delete(filePath);
    if (processedFiles.has(filePath)) {
      return;
    }
    processedFiles.add(filePath);
    const source = await readSource(filePath);
    if (source === null) {
      return;
    }

    const patterns = detectWorkflowPatterns(source);
    if (patterns.hasUseWorkflow) {
      state.discoveredWorkflows.add(filePath);
    }
    if (patterns.hasUseStep) {
      state.discoveredSteps.add(filePath);
    }
    if (patterns.hasSerde && hasLikelySerdeClass(source)) {
      state.discoveredSerdeFiles.add(filePath);
    }

    const forceFollowImports = patterns.hasDirective || patterns.hasSerde;
    const shouldFollow = await shouldFollowImportsFromFile(
      filePath,
      forceFollowImports
    );
    if (!shouldFollow) {
      return;
    }

    const specifiers = await extractRuntimeImportSpecifiers(filePath, source);
    if (specifiers.length === 0) {
      return;
    }

    await Promise.all(
      specifiers.map((specifier) =>
        processImportSpecifier(filePath, specifier, shouldFollow)
      )
    );
  };

  for (const entryPoint of entryPoints) {
    enqueueFile(entryPoint);
  }

  const inFlight = new Set<Promise<void>>();
  const scheduleFiles = () => {
    while (
      queue.length > 0 &&
      inFlight.size < FAST_DISCOVERY_FILE_CONCURRENCY
    ) {
      const filePath = queue.shift();
      if (!filePath) {
        continue;
      }

      const promise = processFile(filePath).finally(() => {
        inFlight.delete(promise);
      });
      inFlight.add(promise);
    }
  };

  scheduleFiles();
  while (inFlight.size > 0) {
    await Promise.race(inFlight);
    scheduleFiles();
  }

  state.discoveredFiles = processedFiles;
  state.unresolvedImportCandidates = unresolvedImportCandidates;
}
