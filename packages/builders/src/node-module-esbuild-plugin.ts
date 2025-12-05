import { readFile } from 'node:fs/promises';
import { normalize, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { ERROR_SLUGS } from '@workflow/errors';
import builtinModules from 'builtin-modules';
import enhancedResolveOriginal from 'enhanced-resolve';
import type * as esbuild from 'esbuild';

const enhancedResolve = promisify(enhancedResolveOriginal);

// Match exact Node.js built-in module names:
// - "fs", "path", "stream" etc. (exact match)
// - "node:fs", "node:path" etc. (with node: prefix)
// But NOT "some-package/stream" or "eventsource-parser/stream"
const nodeModulesPattern = `(${builtinModules.join('|')})`;

// Match Bun modules:
// - "bun" (exact match)
// - "bun:sqlite", "bun:ffi" etc. (with bun: prefix)
const bunModulesRegex = /^bun(:|$)/;

// Combined regex for both Node.js and Bun modules
const runtimeModulesRegex = new RegExp(
  `^((node:)?${nodeModulesPattern}|bun(:.*)?)$`
);

type PackageViolation = {
  packageName: string;
  importer: string;
  path: string;
  location: Partial<esbuild.Location>;
};

/**
 * Get the package name from a file path.
 * @param filePath - The file path to get the package name from.
 * @returns The package name.
 */
export function getPackageName(filePath: string) {
  const normalized = filePath.replace(/\\/g, '/');
  const marker = '/node_modules/';
  const idx = normalized.lastIndexOf(marker);
  if (idx === -1) return null;

  const after = normalized.slice(idx + marker.length); // e.g. ".pnpm/node-fetch@3.3.2/node_modules/node-fetch/src/index.js"
  const segments = after.split('/');
  if (!segments.length) return null;

  let packageName = segments[0];

  // pnpm nests: ".pnpm/<pkg>@<version>/node_modules/<pkg>/..."
  if (packageName === '.pnpm' && segments.length >= 3) {
    packageName = segments[2];
  } else if (packageName.startsWith('@') && segments.length >= 2) {
    packageName = `${segments[0]}/${segments[1]}`;
  }

  return packageName;
}

/**
 * Escape a regular expression string.
 * @param value - The string to escape.
 * @returns The escaped string.
 */
export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Get the imported identifier from a specifier.
 * @param specifier - The specifier to get the imported identifier from.
 * @returns The imported identifier.
 */
export function getImportedIdentifier(specifier: string) {
  const namespaceMatch = specifier.match(/\*\s+as\s+([A-Za-z0-9_$]+)/);
  if (namespaceMatch) {
    return namespaceMatch[1];
  }

  if (specifier.includes('{')) {
    const inside = specifier.replace(/^[^{]*\{/, '').replace(/\}.*$/, '');
    const firstNamed = inside
      .split(',')
      .map((token) => token.trim())
      .find(Boolean);

    if (firstNamed) {
      const aliasMatch = firstNamed.match(
        /([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)/
      );
      if (aliasMatch) {
        return aliasMatch[2];
      }
      // Validate that firstNamed is a valid identifier (not empty braces or whitespace)
      const identifierMatch = firstNamed.match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
      if (identifierMatch) {
        return identifierMatch[0];
      }
    }
    // Empty braces or no valid identifier found - return undefined
    return undefined;
  }

  const defaultPart = specifier.split(',')[0]?.trim();
  if (defaultPart && defaultPart !== '*') {
    return defaultPart;
  }
}

/**
 * Find the usage of an identifier in a list of lines.
 * @param lines - The list of lines to search in.
 * @param startIndex - The index to start searching from.
 * @param identifier - The identifier to search for.
 * @returns The usage of the identifier.
 */
function findIdentifierUsage(
  lines: string[],
  startIndex: number,
  identifier: string
) {
  const usageRegex = new RegExp(`\\b${escapeRegExp(identifier)}\\b`);

  for (let i = startIndex; i < lines.length; i += 1) {
    const line = lines[i];

    // Skip comments (both // and /* */ style)
    const withoutComments = line
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/, '');

    // Remove (replace with spaces) string literals to avoid matching inside paths
    // Use escaped quote handling to properly match strings with escaped quotes
    const withoutStrings = withoutComments
      .replace(/'(?:[^'\\]|\\.)*'/g, (segment) => ' '.repeat(segment.length))
      .replace(/"(?:[^"\\]|\\.)*"/g, (segment) => ' '.repeat(segment.length))
      .replace(/`(?:[^`\\]|\\.)*`/g, (segment) => ' '.repeat(segment.length));

    const match = withoutStrings.match(usageRegex);
    if (match && match.index !== undefined) {
      return {
        line: i,
        column: match.index,
        lineText: line,
      };
    }
  }
}

/**
 * Get the location of a violation.
 * @param cwd - The current working directory.
 * @param relativePath - The relative path to the file.
 * @param packageName - The name of the package.
 * @returns The location of the violation.
 */
export async function getViolationLocation(
  cwd: string,
  relativePath: string,
  packageName: string
) {
  try {
    const absolutePath = resolve(cwd, relativePath);
    const contents = await readFile(absolutePath, 'utf8');
    const lines = contents.split(/\r?\n/);

    const importRegex = new RegExp(
      `import\\s+(.+?)\\s+from\\s+['"]${escapeRegExp(packageName)}(?:/[^'"]*)?['"]`
    );

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const importMatch = line.match(importRegex);

      if (importMatch && importMatch.index !== undefined) {
        const specifier = importMatch[1].trim();
        const identifier = getImportedIdentifier(specifier);
        if (identifier) {
          const usage = findIdentifierUsage(lines, i + 1, identifier);
          if (usage) {
            return {
              file: relativePath,
              line: usage.line + 1,
              column: usage.column,
              lineText: usage.lineText,
              length: identifier.length,
            };
          }

          // Identifier exists but is never referenced; surface no location
          return undefined;
        }

        // Fallback: if we can't extract identifier, point to package name
        const columnIndex = line.indexOf(packageName);
        if (columnIndex !== -1) {
          return {
            file: relativePath,
            line: i + 1,
            column: columnIndex,
            lineText: line,
            length: packageName.length,
          };
        }
      }
    }
  } catch {
    // ignore file read failures, fallback to no location info
  }
}

/**
 * Get the module type label for error messages.
 * @param modulePath - The module path to check.
 * @returns The module type label.
 */
function getModuleTypeLabel(modulePath: string): string {
  if (bunModulesRegex.test(modulePath)) {
    return 'Bun';
  }
  return 'Node.js';
}

/**
 * Create an esbuild plugin to detect violations of the Node.js module usage rule.
 * This plugin prevents workflow functions from importing Node.js or Bun built-in
 * modules, which are not available in the sandboxed workflow runtime.
 */
export function createNodeModuleErrorPlugin(): esbuild.Plugin {
  return {
    name: 'workflow-node-module-error',
    setup(build) {
      const cwd = process.cwd();
      const importParents = new Map<string, string>();
      const packageViolations: PackageViolation[] = [];
      const seenViolations = new Set<string>();

      // Track ALL import relationships to build the dependency graph.
      // This is necessary to trace transitive dependencies back to user code.
      // Performance impact is minimal as we only store path mappings.
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (!args.importer) return null;

        try {
          const resolvedChild = await enhancedResolve(
            args.resolveDir,
            args.path
          );

          if (resolvedChild) {
            const childKey = normalize(resolvedChild);
            const parentValue = normalize(args.importer);
            importParents.set(childKey, parentValue);
          }
        } catch {
          // For built-in modules that can't be resolved, still track using the import path
          const childKey = args.path;
          const parentValue = normalize(args.importer);
          importParents.set(childKey, parentValue);
        }
        return null;
      });

      // Detect Node.js and Bun module imports
      build.onResolve({ filter: runtimeModulesRegex }, async (args) => {
        const importerPath = resolve(cwd, args.importer);
        let current = importerPath;
        const chain: string[] = [];
        const visited = new Set<string>();
        while (current) {
          if (visited.has(current)) {
            break;
          }
          visited.add(current);
          chain.push(current);
          let next = importParents.get(current);

          // If we can't find the parent and current is in node_modules,
          // try looking up by potential package import strings
          if (!next && current.includes('node_modules')) {
            const packageName = getPackageName(current);
            if (packageName) {
              // Try the package name directly
              next = importParents.get(packageName);
              if (!next) {
                // Try with node: prefix
                next = importParents.get(`node:${packageName}`);
              }
            }
          }

          current = next ?? '';
        }
        const filteredChain = chain.filter(
          (path) => !path.includes('node_modules')
        );

        const workflowFile = filteredChain[0] ?? importerPath;

        if (!workflowFile || workflowFile.includes('node_modules')) {
          return {
            path: args.path,
            external: true,
          };
        }

        const packageName = importerPath.includes('node_modules')
          ? (getPackageName(importerPath) ?? args.path)
          : args.path;

        const relativeWorkflowFile = relative(cwd, workflowFile);
        const violationKey = `${packageName}:${relativeWorkflowFile}`;

        if (!seenViolations.has(violationKey)) {
          seenViolations.add(violationKey);
          const location = await getViolationLocation(
            cwd,
            relativeWorkflowFile,
            packageName
          );
          // Only report violations where we can find the import location.
          // If we can't find it, the package is likely a transitive dependency
          // that the user didn't directly import - we'll report the top-level
          // package they did import instead.
          if (location) {
            packageViolations.push({
              path: args.path,
              importer: relativeWorkflowFile,
              packageName,
              location,
            });
          }
        }

        return {
          path: args.path,
          external: true,
        };
      });

      // Report all violations at the end of the build
      build.onEnd(() => {
        if (packageViolations.length > 0) {
          return {
            errors: packageViolations.map((violation) => {
              const isBuiltinModule = runtimeModulesRegex.test(
                violation.packageName
              );
              const moduleType = getModuleTypeLabel(violation.path);

              // Different messages for built-in modules vs npm packages that use them
              const text = isBuiltinModule
                ? `You are attempting to use "${violation.packageName}" which is a ${moduleType} module. ${moduleType} modules are not available in workflow functions.\n\nLearn more: https://useworkflow.dev/err/${ERROR_SLUGS.NODE_JS_MODULE_IN_WORKFLOW}`
                : `You are attempting to use "${violation.packageName}" which depends on ${moduleType} modules. Packages that depend on ${moduleType} modules are not available in workflow functions.\n\nLearn more: https://useworkflow.dev/err/${ERROR_SLUGS.NODE_JS_MODULE_IN_WORKFLOW}`;

              return {
                text,
                location: violation.location
                  ? {
                      ...violation.location,
                      suggestion: 'Move this function into a step function.',
                    }
                  : undefined,
              };
            }),
          };
        }
      });
    },
  };
}
