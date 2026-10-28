import { access, readFile, stat } from 'node:fs/promises';
import { builtinModules, createRequire } from 'node:module';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import enhancedResolveOriginal from 'enhanced-resolve';
import { findUp } from 'find-up';
import JSON5 from 'json5';
import { importParents } from './discover-entries-esbuild-plugin.js';
import {
  detectWorkflowPatterns,
  stripCommentsFromSource,
} from './transform-utils.js';

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
/**
 * TypeScript's `.js`-to-`.ts` import rewriting, which the rest of the
 * toolchain already implements (esbuild natively, webpack and Vite through
 * `resolve.extensionAlias`). A `.ts` file following NodeNext module
 * resolution writes `./x.js` for a sibling that only exists as `./x.ts`, and
 * TypeScript itself prescribes that spelling.
 *
 * The original extension stays first in every list so a project shipping both
 * `x.js` and `x.ts` keeps resolving to the file it resolved to before; the
 * aliases are only ever reached on a miss.
 */
const FAST_DISCOVERY_EXTENSION_ALIASES: Record<string, string[]> = {
  '.js': ['.js', '.ts', '.tsx'],
  '.jsx': ['.jsx', '.tsx'],
  '.mjs': ['.mjs', '.mts'],
  '.cjs': ['.cjs', '.cts'],
};
const fastDiscoveryResolve = promisify(
  enhancedResolveOriginal.create({
    extensions: [...FAST_DISCOVERY_SOURCE_EXTENSIONS, '.json', '.node'],
    // Deep package imports are spelled the same way, so a bare specifier like
    // `pkg/sub.js` needs the same rewriting as a relative one.
    extensionAlias: FAST_DISCOVERY_EXTENSION_ALIASES,
    fullySpecified: false,
    conditionNames: ['node', 'import', 'require'],
  })
);
const require = createRequire(import.meta.url);

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
  /**
   * Imports that matched nothing on disk, as written by files that declare
   * workflow code themselves. These are the edges whose loss changes what the
   * build registers: the module behind one was never read, so any
   * `"use workflow"`/`"use step"` function it defines is absent from the
   * bundles and only surfaces as a runtime `WorkflowNotRegisteredError` or
   * `StepNotRegisteredError`. Builders report them so the build says so
   * instead.
   */
  unresolvedDirectiveImports?: UnresolvedDirectiveImport[];
}

/** One import discovery could not follow out of a file declaring workflow code. */
export interface UnresolvedDirectiveImport {
  /** Absolute path of the file that wrote the import. */
  importer: string;
  /** The specifier exactly as written. */
  specifier: string;
}

/**
 * What discovery decided about one import specifier.
 *
 * `filePath === null` has two meanings that must not be conflated: the module
 * is missing, or it resolved to something discovery deliberately does not
 * follow (an installed package without a workflow dependency, a stylesheet,
 * an asset). Only the first is worth reporting, so the distinction is carried
 * rather than recomputed.
 */
interface ImportResolution {
  filePath: string | null;
  missing: boolean;
}

/** An import that resolved to something outside the graph discovery walks. */
const IMPORT_OUTSIDE_GRAPH: ImportResolution = {
  filePath: null,
  missing: false,
};

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

async function resolveTsconfigExtendsPath(
  extendsValue: string,
  tsconfigPath: string
): Promise<string | undefined> {
  const configDir = dirname(tsconfigPath);
  if (extendsValue.startsWith('.') || isAbsolute(extendsValue)) {
    const resolved = isAbsolute(extendsValue)
      ? extendsValue
      : resolve(configDir, extendsValue);
    return findExistingTsconfigPath(resolved);
  }

  try {
    return require.resolve(extendsValue, { paths: [configDir] });
  } catch {}

  try {
    return require.resolve(`${extendsValue}/tsconfig.json`, {
      paths: [configDir],
    });
  } catch {
    return undefined;
  }
}

async function findExistingTsconfigPath(
  candidatePath: string
): Promise<string | undefined> {
  const candidates =
    extname(candidatePath) === ''
      ? [
          `${candidatePath}.json`,
          join(candidatePath, 'tsconfig.json'),
          candidatePath,
        ]
      : [candidatePath];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }

  return undefined;
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
  const resolveCache = new Map<string, Promise<ImportResolution>>();
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
  const unresolvedDirectiveImports: UnresolvedDirectiveImport[] = [];

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
  const pathLikeCandidates = (basePath: string): string[] => {
    const extension = extname(basePath);
    if (FAST_DISCOVERY_SOURCE_EXTENSION_SET.has(extension)) {
      const aliases = FAST_DISCOVERY_EXTENSION_ALIASES[extension];
      if (!aliases) {
        return [basePath];
      }
      // `./x.js` is also how TypeScript spells an import of `./x.ts`. An
      // explicit extension never implies a directory index, so the candidates
      // stay one per alias.
      const withoutExtension = basePath.slice(0, -extension.length);
      return aliases.map((alias) => `${withoutExtension}${alias}`);
    }

    return [
      ...FAST_DISCOVERY_SOURCE_EXTENSIONS.map(
        (candidateExtension) => `${basePath}${candidateExtension}`
      ),
      ...FAST_DISCOVERY_SOURCE_EXTENSIONS.map((candidateExtension) =>
        join(basePath, `index${candidateExtension}`)
      ),
    ];
  };

  /**
   * Record where a module was expected, and report whether anything was
   * actually missing. `false` means every base path pointed at a file that
   * exists but is not something discovery follows, which is not a missing
   * module and must not be reported as one.
   */
  const recordUnresolved = async (basePaths: string[]): Promise<boolean> => {
    let recorded = false;
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
      recorded = true;
    }
    return recorded;
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
  ): Promise<ImportResolution> => {
    const resolved = await resolvePathLikeSpecifier(importer, specifier);
    if (resolved) {
      return { filePath: resolved, missing: false };
    }

    const missing = await recordUnresolved([
      resolveBasePath(importer, specifier),
    ]);
    return { filePath: null, missing };
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
  ): Promise<ImportResolution> => {
    const cacheKey = `${dirname(importer)}\0${specifier}`;
    const cached = resolveCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const resolvedPromise = resolveLimit(
      async (): Promise<ImportResolution> => {
        if (isRelativeOrAbsoluteSpecifier(specifier)) {
          return resolveRelativeImport(importer, specifier);
        }

        const alias = await resolveWithTsconfigPaths(importer, specifier);
        if (alias.resolved) {
          return { filePath: alias.resolved, missing: false };
        }

        // An installed package discovery chooses not to follow is resolved as
        // far as the graph is concerned, even under a catch-all alias like `*`.
        if (!(await shouldResolveBareSpecifier(specifier))) {
          return IMPORT_OUTSIDE_GRAPH;
        }

        const resolved = await resolveBareSpecifier(importer, specifier);
        if (resolved) {
          return { filePath: resolved, missing: false };
        }

        // A bare specifier that matched a tsconfig alias names a path inside
        // the project, so a miss there is a module that should have been
        // there. A bare specifier that matched no alias is a package: an
        // uninstalled one already fails the bundle with esbuild's own error,
        // and a type-only import of an absent optional peer is not a problem
        // at all, so neither is reported as missing here.
        const missing = await recordUnresolved(alias.basePaths);
        return { filePath: null, missing };
      }
    );
    resolveCache.set(cacheKey, resolvedPromise);
    return resolvedPromise;
  };

  /**
   * Keep an import that went nowhere, when the file that wrote it declares
   * workflow code itself. Those imports are what decide the rest of what this
   * build registers, so an edge discovery cannot follow out of one is the
   * shape of a workflow that silently fails to register — worth reporting
   * rather than dropping.
   *
   * An import that merely left the graph (an installed package discovery does
   * not descend into, a stylesheet) is not missing and never recorded.
   */
  const reportUnresolvedImport = ({
    importer,
    specifier,
    missing,
    importerDeclaresWorkflowCode,
  }: UnresolvedDirectiveImport & {
    missing: boolean;
    importerDeclaresWorkflowCode: boolean;
  }): void => {
    if (!missing || !importerDeclaresWorkflowCode) {
      return;
    }
    unresolvedDirectiveImports.push({ importer, specifier });
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

  const processImportSpecifier = async (
    filePath: string,
    specifier: string,
    shouldFollow: boolean,
    importerDeclaresWorkflowCode: boolean
  ): Promise<void> => {
    if (NODE_BUILTIN_SPECIFIERS.has(specifier)) {
      return;
    }
    if (!shouldFollow) {
      return;
    }

    const { filePath: resolved, missing } = await resolveImport(
      filePath,
      specifier
    );
    if (!resolved) {
      reportUnresolvedImport({
        importer: filePath,
        specifier,
        missing,
        importerDeclaresWorkflowCode,
      });
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
    // `enqueueFile` filters these too, but stopping here keeps a non-source
    // import out of the queue entirely.
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

    const specifiers = extractImportSpecifiers(source);
    if (specifiers.length === 0) {
      return;
    }

    await Promise.all(
      specifiers.map((specifier) =>
        processImportSpecifier(
          filePath,
          specifier,
          shouldFollow,
          forceFollowImports
        )
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
  // Sorted so a build log (and a test asserting on one) reads the same way
  // twice: the walk itself is concurrency-ordered.
  state.unresolvedDirectiveImports = unresolvedDirectiveImports.sort(
    (left, right) =>
      left.importer.localeCompare(right.importer) ||
      left.specifier.localeCompare(right.specifier)
  );
}
