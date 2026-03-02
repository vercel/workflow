import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/**
 * Result of resolving a module specifier for a file.
 */
export interface ModuleSpecifierResult {
  /**
   * The module specifier to use for ID generation.
   * - For packages: "{name}@{version}" or "{name}/{subpath}@{version}"
   *   (e.g., "point@1.0.0", "@myorg/shared@2.0.0", "workflow/internal/builtins@4.0.0")
   * - For local files: undefined (plugin will use default "./relative/path" format)
   */
  moduleSpecifier: string | undefined;
}

/**
 * Parsed package.json data with directory information.
 */
interface PackageInfo {
  name: string;
  version: string;
  dir: string;
  exports?: Record<string, unknown>;
  main?: string;
  module?: string;
}

/**
 * Cache for package.json lookups to avoid repeated filesystem reads.
 * Maps directory path to parsed package.json info or null if not found.
 */
const packageJsonCache = new Map<string, PackageInfo | null>();

/**
 * Find and read the nearest package.json for a given file path.
 * Results are cached for performance.
 */
function findPackageJson(filePath: string): PackageInfo | null {
  let dir = dirname(filePath);

  // Track directories we've visited so we can back-fill the cache
  const visitedDirs: string[] = [];

  // Walk up the directory tree until we hit the root
  while (dir !== dirname(dir)) {
    // Check cache first
    const cached = packageJsonCache.get(dir);
    if (cached !== undefined) {
      // Back-fill cache for all visited directories with the same result
      for (const visitedDir of visitedDirs) {
        packageJsonCache.set(visitedDir, cached);
      }
      return cached;
    }

    visitedDirs.push(dir);

    const packageJsonPath = join(dir, 'package.json');
    if (existsSync(packageJsonPath)) {
      try {
        const content = readFileSync(packageJsonPath, 'utf-8');
        const parsed = JSON.parse(content);
        if (parsed.name && parsed.version) {
          const result: PackageInfo = {
            name: parsed.name,
            version: parsed.version,
            dir,
            exports: parsed.exports,
            main: parsed.main,
            module: parsed.module,
          };
          // Cache the result for this directory and all visited directories
          packageJsonCache.set(dir, result);
          for (const visitedDir of visitedDirs) {
            packageJsonCache.set(visitedDir, result);
          }
          return result;
        }
      } catch {
        // Invalid JSON or missing fields, continue searching
      }
    }

    dir = dirname(dir);
  }

  // No package.json found - cache null for all visited directories
  for (const visitedDir of visitedDirs) {
    packageJsonCache.set(visitedDir, null);
  }

  return null;
}

/**
 * Resolve the export subpath for a file within a package.
 * Looks up the package.json exports field to find which subpath maps to the file.
 *
 * @param filePath - Absolute path to the file
 * @param pkg - Package info from findPackageJson
 * @returns The subpath (e.g., "/internal/builtins") or empty string for root export
 */
function resolveExportSubpath(filePath: string, pkg: PackageInfo): string {
  if (!pkg.exports || typeof pkg.exports !== 'object') {
    return '';
  }

  // Get the relative path from package root to the file
  const normalizedFilePath = filePath.replace(/\\/g, '/');
  const normalizedPkgDir = pkg.dir.replace(/\\/g, '/');
  const relativePath = normalizedFilePath.startsWith(normalizedPkgDir + '/')
    ? './' + normalizedFilePath.substring(normalizedPkgDir.length + 1)
    : null;

  if (!relativePath) {
    return '';
  }

  // Search through exports to find a matching subpath
  for (const [subpath, target] of Object.entries(pkg.exports)) {
    const resolvedTarget = resolveExportTarget(target);
    if (
      resolvedTarget &&
      normalizeExportPath(resolvedTarget) === relativePath
    ) {
      // Found a match - return the subpath without the leading "."
      // e.g., "./internal/builtins" -> "/internal/builtins"
      return subpath === '.' ? '' : subpath.substring(1);
    }
  }

  return '';
}

/**
 * Resolve an export target to a file path, handling conditional exports and arrays.
 */
function resolveExportTarget(target: unknown): string | null {
  if (typeof target === 'string') {
    return target;
  }

  // Handle array exports (fallback chains)
  if (Array.isArray(target)) {
    for (const item of target) {
      const resolved = resolveExportTarget(item);
      if (resolved) return resolved;
    }
    return null;
  }

  if (target && typeof target === 'object') {
    // Conditional export - try common conditions in order of preference
    const conditions = ['workflow', 'default', 'require', 'import', 'node'];
    for (const condition of conditions) {
      const value = (target as Record<string, unknown>)[condition];
      if (typeof value === 'string') {
        return value;
      }
      // Handle nested conditionals or arrays
      if (value && typeof value === 'object') {
        const nested = resolveExportTarget(value);
        if (nested) return nested;
      }
    }
  }

  return null;
}

/**
 * Normalize an export path for comparison.
 */
function normalizeExportPath(path: string): string {
  // Ensure it starts with ./
  if (!path.startsWith('./')) {
    return './' + path;
  }
  return path;
}

/**
 * Check if a file path is inside node_modules.
 */
function isInNodeModules(filePath: string): boolean {
  const normalizedPath = filePath.split(sep).join('/');
  return normalizedPath.includes('/node_modules/');
}

/**
 * Cache for project dependencies to avoid repeated filesystem reads.
 * Maps project root to set of dependency package names.
 */
const projectDepsCache = new Map<string, Set<string>>();

/**
 * Get all dependencies (including devDependencies) for a project.
 */
function getProjectDependencies(projectRoot: string): Set<string> {
  const cached = projectDepsCache.get(projectRoot);
  if (cached) {
    return cached;
  }

  const deps = new Set<string>();
  const pkgPath = join(projectRoot, 'package.json');

  if (existsSync(pkgPath)) {
    try {
      const content = readFileSync(pkgPath, 'utf-8');
      const parsed = JSON.parse(content);

      // Collect all dependency types
      for (const depType of [
        'dependencies',
        'devDependencies',
        'peerDependencies',
        'optionalDependencies',
      ]) {
        const depObj = parsed[depType];
        if (depObj && typeof depObj === 'object') {
          for (const name of Object.keys(depObj)) {
            deps.add(name);
          }
        }
      }
    } catch {
      // Invalid JSON or file not readable
    }
  }

  projectDepsCache.set(projectRoot, deps);
  return deps;
}

/**
 * Check if a file path is inside a workspace package that is a dependency of the project.
 * This is a heuristic - we check if the file is in a directory with a package.json
 * that has a "name" field, is NOT in node_modules, and is listed as a dependency
 * of the project.
 */
function isWorkspacePackage(filePath: string, projectRoot: string): boolean {
  if (isInNodeModules(filePath)) {
    return false;
  }

  const pkg = findPackageJson(filePath);
  if (!pkg) {
    return false;
  }

  // Check if the package.json is not the root package.json
  // Use resolve() to normalize paths for cross-platform comparison
  const rootPkgDir = resolve(projectRoot);
  const pkgDir = resolve(pkg.dir);

  // If the package directory is the project root, it's not a workspace package
  if (pkgDir === rootPkgDir) {
    return false;
  }

  // Found a package.json that's not the root.
  // Only treat it as a workspace package if it's actually a dependency
  // of the current project. This prevents sibling apps in a monorepo
  // from being incorrectly treated as importable packages.
  const projectDeps = getProjectDependencies(projectRoot);
  return projectDeps.has(pkg.name);
}

/**
 * Resolve the module specifier for a file.
 *
 * @param filePath - Absolute path to the file being transformed
 * @param projectRoot - Absolute path to the project root (usually process.cwd())
 * @returns The module specifier result
 *
 * @example
 * // File in node_modules (root export)
 * resolveModuleSpecifier('/project/node_modules/point/dist/index.js', '/project')
 * // => { moduleSpecifier: 'point@1.0.0' }
 *
 * @example
 * // File in node_modules (subpath export)
 * resolveModuleSpecifier('/project/node_modules/workflow/dist/internal/builtins.js', '/project')
 * // => { moduleSpecifier: 'workflow/internal/builtins@4.0.0' }
 *
 * @example
 * // File in workspace package
 * resolveModuleSpecifier('/project/packages/shared/src/utils.ts', '/project')
 * // => { moduleSpecifier: '@myorg/shared@0.0.0' }
 *
 * @example
 * // Local app file
 * resolveModuleSpecifier('/project/src/workflows/order.ts', '/project')
 * // => { moduleSpecifier: undefined }
 */
export function resolveModuleSpecifier(
  filePath: string,
  projectRoot: string
): ModuleSpecifierResult {
  // Check if file is in node_modules or a workspace package
  const inNodeModules = isInNodeModules(filePath);
  const inWorkspace =
    !inNodeModules && isWorkspacePackage(filePath, projectRoot);

  if (!inNodeModules && !inWorkspace) {
    // Local app file - use default relative path format
    return { moduleSpecifier: undefined };
  }

  // Find the package.json for this file
  const pkg = findPackageJson(filePath);
  if (!pkg) {
    // Couldn't find package.json - fall back to default
    return { moduleSpecifier: undefined };
  }

  // Resolve the export subpath (e.g., "/internal/builtins" for "workflow/internal/builtins")
  const subpath = resolveExportSubpath(filePath, pkg);

  // Return the module specifier as "name/subpath@version" or "name@version"
  const specifier = subpath
    ? `${pkg.name}${subpath}@${pkg.version}`
    : `${pkg.name}@${pkg.version}`;

  return {
    moduleSpecifier: specifier,
  };
}

/**
 * Clear the package.json cache. Useful for testing or when package.json files may have changed.
 */
export function clearModuleSpecifierCache(): void {
  packageJsonCache.clear();
  projectDepsCache.clear();
}

/**
 * Convert a file path to a relative import path from project root.
 */
function toRelativeImportPath(filePath: string, projectRoot: string): string {
  const normalizedProjectRoot = projectRoot.replace(/\\/g, '/');
  const normalizedFilePath = filePath.replace(/\\/g, '/');

  let relativePath: string;
  if (normalizedFilePath.startsWith(normalizedProjectRoot + '/')) {
    relativePath = normalizedFilePath.substring(
      normalizedProjectRoot.length + 1
    );
  } else {
    // File is outside project root, use the full path segments after common ancestor
    relativePath = relative(projectRoot, filePath).replace(/\\/g, '/');
  }

  // Ensure relative paths start with ./
  if (!relativePath.startsWith('.')) {
    relativePath = `./${relativePath}`;
  }

  return relativePath;
}

/**
 * Returns true when package exports include a root entry (".").
 * String/array/conditional object exports are all considered root exports.
 */
function hasRootExport(exportsField: unknown): boolean {
  if (typeof exportsField === 'string' || Array.isArray(exportsField)) {
    return true;
  }

  if (!exportsField || typeof exportsField !== 'object') {
    return false;
  }

  const keys = Object.keys(exportsField as Record<string, unknown>);
  // Conditional exports object (e.g. { "import": "...", "default": "..." })
  // represents the root export.
  if (keys.length > 0 && keys.every((key) => !key.startsWith('.'))) {
    return true;
  }

  return '.' in (exportsField as Record<string, unknown>);
}

/**
 * Normalize a package target path to a comparable package-relative path.
 * Returns null for invalid/unsupported paths.
 */
function normalizePackageTargetPath(path: string): string | null {
  const normalized = path.replace(/\\/g, '/');
  if (normalized.startsWith('./')) {
    return normalized.substring(2);
  }
  if (normalized.startsWith('/')) {
    return normalized.substring(1);
  }
  return normalized;
}

/**
 * Returns true if filePath is the package root entrypoint.
 * This checks root exports first, then main/module/index fallbacks when exports are absent.
 */
function isRootEntrypointFile(filePath: string, pkg: PackageInfo): boolean {
  const normalizedFilePath = filePath.replace(/\\/g, '/');
  const normalizedPkgDir = pkg.dir.replace(/\\/g, '/');

  if (!normalizedFilePath.startsWith(normalizedPkgDir + '/')) {
    return false;
  }

  const relativeFilePath = normalizedFilePath.substring(
    normalizedPkgDir.length + 1
  );

  if (pkg.exports) {
    let rootTarget: unknown;

    if (
      typeof pkg.exports === 'object' &&
      !Array.isArray(pkg.exports) &&
      '.' in pkg.exports
    ) {
      rootTarget = (pkg.exports as Record<string, unknown>)['.'];
    } else if (hasRootExport(pkg.exports)) {
      rootTarget = pkg.exports;
    } else {
      return false;
    }

    const resolvedTarget = resolveExportTarget(rootTarget);
    if (!resolvedTarget) {
      return false;
    }

    const normalizedTarget = normalizePackageTargetPath(resolvedTarget);
    return normalizedTarget === relativeFilePath;
  }

  const rootCandidates = [
    pkg.module,
    pkg.main,
    'index.js',
    'index.mjs',
    'index.cjs',
    'index.ts',
    'index.mts',
    'index.cts',
  ]
    .filter((candidate): candidate is string => typeof candidate === 'string')
    .map((candidate) => normalizePackageTargetPath(candidate))
    .filter((candidate): candidate is string => candidate !== null);

  return rootCandidates.includes(relativeFilePath);
}

/**
 * Result of resolving an import path for a file.
 */
export interface ImportPathResult {
  /**
   * The import path to use.
   * - For workspace packages: the package name (e.g., "@myorg/shared")
   * - For node_modules packages: the package name
   * - For local files: a relative path (e.g., "./src/workflows/order.ts")
   */
  importPath: string;

  /**
   * Whether this file is from a package (workspace or node_modules).
   * When true, the import should go through package resolution which respects export conditions.
   */
  isPackage: boolean;
}

/**
 * Get the import path to use for a file in a bundle's virtual entry.
 *
 * For workspace packages and node_modules packages, returns the package name
 * so that bundler resolution will respect package.json exports and conditions.
 *
 * For local app files, returns a relative path.
 *
 * @param filePath - Absolute path to the file
 * @param projectRoot - Absolute path to the project root
 * @returns The import path and whether it's a package
 *
 * @example
 * // Workspace package
 * getImportPath('/project/packages/shared/src/index.ts', '/project')
 * // => { importPath: '@myorg/shared', isPackage: true }
 *
 * @example
 * // Local app file
 * getImportPath('/project/src/workflows/order.ts', '/project')
 * // => { importPath: './src/workflows/order.ts', isPackage: false }
 */
export function getImportPath(
  filePath: string,
  projectRoot: string
): ImportPathResult {
  // Check if file is in node_modules or a workspace package
  const inNodeModules = isInNodeModules(filePath);
  const inWorkspace =
    !inNodeModules && isWorkspacePackage(filePath, projectRoot);

  if (inNodeModules || inWorkspace) {
    // Find the package.json for this file
    const pkg = findPackageJson(filePath);
    if (pkg) {
      // Prefer a package subpath import when this file maps to an export.
      // This preserves the exact module being bundled while still respecting
      // package export conditions.
      // Note: resolveExportSubpath returns "" for both root "." matches and
      // no match; root entrypoints are intentionally handled below via
      // isRootEntrypointFile().
      const subpath = resolveExportSubpath(filePath, pkg);
      if (subpath) {
        return {
          importPath: `${pkg.name}${subpath}`,
          isPackage: true,
        };
      }

      // Only import package root when this file is the root entrypoint.
      // For deep/internal files, fall back to direct relative imports so we
      // don't accidentally import a non-existent or different module.
      if (!isRootEntrypointFile(filePath, pkg)) {
        return {
          importPath: toRelativeImportPath(filePath, projectRoot),
          isPackage: false,
        };
      }

      return {
        importPath: pkg.name,
        isPackage: true,
      };
    }
  }

  // Local app file - use relative path
  return {
    importPath: toRelativeImportPath(filePath, projectRoot),
    isPackage: false,
  };
}
