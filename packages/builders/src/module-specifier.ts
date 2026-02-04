import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/**
 * Result of resolving a module specifier for a file.
 */
export interface ModuleSpecifierResult {
  /**
   * The module specifier to use for ID generation.
   * - For packages: "{name}@{version}" (e.g., "point@1.0.0", "@myorg/shared@2.0.0")
   * - For local files: undefined (plugin will use default "./relative/path" format)
   */
  moduleSpecifier: string | undefined;
}

/**
 * Cache for package.json lookups to avoid repeated filesystem reads.
 * Maps directory path to parsed package.json or null if not found.
 */
const packageJsonCache = new Map<
  string,
  { name: string; version: string } | null
>();

/**
 * Find and read the nearest package.json for a given file path.
 * Results are cached for performance.
 */
function findPackageJson(
  filePath: string
): { name: string; version: string } | null {
  let dir = dirname(filePath);

  while (dir !== dirname(dir)) {
    // Check cache first
    const cached = packageJsonCache.get(dir);
    if (cached !== undefined) {
      return cached;
    }

    const packageJsonPath = join(dir, 'package.json');
    if (existsSync(packageJsonPath)) {
      try {
        const content = readFileSync(packageJsonPath, 'utf-8');
        const parsed = JSON.parse(content);
        if (parsed.name && parsed.version) {
          const result = { name: parsed.name, version: parsed.version };
          packageJsonCache.set(dir, result);
          return result;
        }
      } catch {
        // Invalid JSON or missing fields, continue searching
      }
    }

    packageJsonCache.set(dir, null);
    dir = dirname(dir);
  }

  return null;
}

/**
 * Check if a file path is inside node_modules.
 */
function isInNodeModules(filePath: string): boolean {
  const normalizedPath = filePath.split(sep).join('/');
  return normalizedPath.includes('/node_modules/');
}

/**
 * Check if a file path is inside a workspace package.
 * This is a heuristic - we check if the file is in a directory with a package.json
 * that has a "name" field, but is NOT in node_modules.
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
  const rootPkgPath = resolve(projectRoot, 'package.json');

  // Walk up to find the package.json directory
  let dir = dirname(filePath);
  while (dir !== dirname(dir)) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      // If this is the root package.json, it's not a workspace package
      // Use resolve() to normalize both paths before comparison
      if (resolve(pkgPath) === rootPkgPath) {
        return false;
      }
      // Found a package.json that's not the root - it's a workspace package
      return true;
    }
    dir = dirname(dir);
  }

  return false;
}

/**
 * Resolve the module specifier for a file.
 *
 * @param filePath - Absolute path to the file being transformed
 * @param projectRoot - Absolute path to the project root (usually process.cwd())
 * @returns The module specifier result
 *
 * @example
 * // File in node_modules
 * resolveModuleSpecifier('/project/node_modules/point/dist/index.js', '/project')
 * // => { moduleSpecifier: 'point@1.0.0' }
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

  // Return the module specifier as "name@version"
  return {
    moduleSpecifier: `${pkg.name}@${pkg.version}`,
  };
}

/**
 * Clear the package.json cache. Useful for testing or when package.json files may have changed.
 */
export function clearModuleSpecifierCache(): void {
  packageJsonCache.clear();
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
      return {
        importPath: pkg.name,
        isPackage: true,
      };
    }
  }

  // Local app file - use relative path
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

  return {
    importPath: relativePath,
    isPackage: false,
  };
}
