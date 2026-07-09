import { access, readFile } from 'node:fs/promises';
import { builtinModules, createRequire } from 'node:module';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import enhancedResolveOriginal from 'enhanced-resolve';
import { findUp } from 'find-up';
import JSON5 from 'json5';
import { importParents } from './discover-entries-esbuild-plugin.js';
import { detectWorkflowPatterns } from './transform-utils.js';

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
}

interface FastDiscoverEntriesOptions {
  entryPoints: string[];
  state: DiscoveredEntries;
  defaultTsconfigPath: string | undefined;
  workingDir: string;
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

function shouldSkipFastDiscoveryImport(specifier: string): boolean {
  if (NODE_BUILTIN_SPECIFIERS.has(specifier)) {
    return true;
  }

  const pathLikeSpecifier = stripImportSpecifierQuery(specifier);
  if (isRelativeOrAbsoluteSpecifier(pathLikeSpecifier)) {
    return false;
  }

  if (!pathLikeSpecifier.includes('/')) {
    return false;
  }

  const extension = extname(pathLikeSpecifier);
  return (
    extension !== '' && !FAST_DISCOVERY_SOURCE_EXTENSION_SET.has(extension)
  );
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

const REGEX_PREFIX_CHARS = new Set([
  '(',
  '{',
  '[',
  '=',
  ':',
  ',',
  ';',
  '!',
  '?',
  '&',
  '|',
  '+',
  '-',
  '*',
  '~',
  '^',
  '<',
  '>',
  '%',
]);
const REGEX_PREFIX_KEYWORDS =
  /\b(?:return|throw|case|delete|void|typeof|instanceof|in|yield|await)$/;

const canStartRegexLiteral = (output: string) => {
  const previous = output.trimEnd();
  if (previous.length === 0) {
    return true;
  }
  const previousChar = previous[previous.length - 1];
  return (
    REGEX_PREFIX_CHARS.has(previousChar) || REGEX_PREFIX_KEYWORDS.test(previous)
  );
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep the string/comment/regex scanner local and allocation-light.
function stripCommentsFromSource(source: string): string {
  let output = '';
  let index = 0;
  let quote: '"' | "'" | '`' | undefined;
  let regex = false;
  let regexCharClass = false;
  let escaped = false;

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (quote || regex) {
      output += char;
      index++;

      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (quote && char === quote) {
        quote = undefined;
      } else if (regex && char === '[') {
        regexCharClass = true;
      } else if (regex && char === ']') {
        regexCharClass = false;
      } else if (regex && char === '/' && !regexCharClass) {
        regex = false;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      output += char;
      index++;
      continue;
    }

    if (
      char === '/' &&
      next !== '/' &&
      next !== '*' &&
      canStartRegexLiteral(output)
    ) {
      regex = true;
      output += char;
      index++;
      continue;
    }

    if (char === '/' && next === '/') {
      output += '  ';
      index += 2;
      while (index < source.length && source[index] !== '\n') {
        output += ' ';
        index++;
      }
      continue;
    }

    if (char === '/' && next === '*') {
      output += '  ';
      index += 2;
      while (index < source.length) {
        const blockChar = source[index];
        const blockNext = source[index + 1];
        if (blockChar === '*' && blockNext === '/') {
          output += '  ';
          index += 2;
          break;
        }
        output += blockChar === '\n' ? '\n' : ' ';
        index++;
      }
      continue;
    }

    output += char;
    index++;
  }

  return output;
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

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function hasLikelySerdeClass(source: string): boolean {
  if (!source.includes('static') || !source.includes('[')) {
    return false;
  }

  const uncommentedSource = stripComments(source);
  if (
    /static\s+\[\s*(?:WORKFLOW_(?:SERIALIZE|DESERIALIZE)|Symbol\.for\s*\(\s*['"]workflow-(?:serialize|deserialize)['"]\s*\))\s*\]\s*\(/.test(
      uncommentedSource
    )
  ) {
    return true;
  }

  if (
    !/from\s+['"]@workflow\/serde['"]|require\s*\(\s*['"]@workflow\/serde['"]\s*\)/.test(
      uncommentedSource
    )
  ) {
    return false;
  }

  return /static\s+\[\s*[$A-Z_a-z][$\w]*\s*\]\s*\(/.test(uncommentedSource);
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
}: FastDiscoverEntriesOptions): Promise<void> {
  const readLimit = createLimiter(FAST_DISCOVERY_READ_CONCURRENCY);
  const resolveLimit = createLimiter(FAST_DISCOVERY_RESOLVE_CONCURRENCY);
  const resolveCache = new Map<string, Promise<string | null>>();
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
    const strippedSpecifier = stripImportSpecifierQuery(specifier);
    const basePath = isAbsolute(strippedSpecifier)
      ? strippedSpecifier
      : resolve(dirname(importer), strippedSpecifier);
    const extension = extname(basePath);
    if (FAST_DISCOVERY_SOURCE_EXTENSION_SET.has(extension)) {
      return (await fileExists(basePath)) ? normalizePath(basePath) : null;
    }

    for (const candidate of [
      ...FAST_DISCOVERY_SOURCE_EXTENSIONS.map(
        (candidateExtension) => `${basePath}${candidateExtension}`
      ),
      ...FAST_DISCOVERY_SOURCE_EXTENSIONS.map((candidateExtension) =>
        join(basePath, `index${candidateExtension}`)
      ),
    ]) {
      if (await fileExists(candidate)) {
        return normalizePath(candidate);
      }
    }

    return null;
  };

  const resolveWithTsconfigPaths = async (
    importer: string,
    specifier: string
  ): Promise<string | null> => {
    if (specifier.startsWith('.') || isAbsolute(specifier)) {
      return null;
    }

    const tsconfigPath = await findTsconfigPathForImporter(importer);
    const tsconfigPathAliases = await loadAliasesForTsconfig(tsconfigPath);
    if (tsconfigPathAliases.length === 0) {
      return null;
    }

    for (const alias of tsconfigPathAliases) {
      const captures = matchTsconfigPathAlias(specifier, alias);
      if (!captures) {
        continue;
      }

      for (const target of alias.targets) {
        const targetPath = applyTsconfigPathTarget(target, captures);
        try {
          const resolved = await resolvePathLikeSpecifier(importer, targetPath);
          if (resolved) {
            return resolved;
          }
        } catch {}
      }
    }

    return null;
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

  const resolveImport = (
    importer: string,
    specifier: string
  ): Promise<string | null> => {
    const cacheKey = `${dirname(importer)}\0${specifier}`;
    const cached = resolveCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const resolvedPromise = resolveLimit(async () => {
      if (isRelativeOrAbsoluteSpecifier(specifier)) {
        return resolvePathLikeSpecifier(importer, specifier);
      }

      const resolvedAlias = await resolveWithTsconfigPaths(importer, specifier);
      if (resolvedAlias) {
        return resolvedAlias;
      }

      if (!(await shouldResolveBareSpecifier(specifier))) {
        return null;
      }

      try {
        const resolved = await fastDiscoveryResolve(
          dirname(importer),
          specifier
        );
        return typeof resolved === 'string' ? normalizePath(resolved) : null;
      } catch {
        return null;
      }
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

  const processImportSpecifier = async (
    filePath: string,
    specifier: string,
    forceFollowImports: boolean
  ): Promise<void> => {
    if (shouldSkipFastDiscoveryImport(specifier)) {
      return;
    }
    if (!(await shouldFollowImportsFromFile(filePath, forceFollowImports))) {
      return;
    }

    const resolved = await resolveImport(filePath, specifier);
    if (!resolved) {
      return;
    }

    addImportParent(filePath, resolved);
    if (!isJsTsFile(resolved) || isGeneratedBuildArtifactPath(resolved)) {
      return;
    }

    if (specifier.startsWith('.')) {
      enqueueFile(resolved);
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
    if (
      !forceFollowImports &&
      !(await shouldFollowImportsFromFile(filePath, false))
    ) {
      return;
    }

    const specifiers = extractImportSpecifiers(source);
    if (specifiers.length === 0) {
      return;
    }

    await Promise.all(
      specifiers.map((specifier) =>
        processImportSpecifier(filePath, specifier, forceFollowImports)
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
}
