import { readFileSync } from 'node:fs';
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
const nodeModulesRegex = new RegExp(`^(${builtinModules.join('|')})$`);

type PackageViolation = {
  packageName: string;
  importer: string;
  path: string;
  location: Partial<esbuild.Location>;
};

/*
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

/*
 * Escape a regular expression string.
 * @param value - The string to escape.
 * @returns The escaped string.
 */
export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/*
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
      return firstNamed;
    }
  }

  const defaultPart = specifier.split(',')[0]?.trim();
  if (defaultPart && defaultPart !== '*') {
    return defaultPart;
  }
}

/*
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
    const withoutStrings = withoutComments
      .replace(/'[^']*'/g, (segment) => ' '.repeat(segment.length))
      .replace(/"[^"]*"/g, (segment) => ' '.repeat(segment.length))
      .replace(/`[^`]*`/g, (segment) => ' '.repeat(segment.length));

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

/*
 * Get the location of a violation.
 * @param cwd - The current working directory.
 * @param relativePath - The relative path to the file.
 * @param packageName - The name of the package.
 * @returns The location of the violation.
 */
export function getViolationLocation(
  cwd: string,
  relativePath: string,
  packageName: string
) {
  try {
    const absolutePath = resolve(cwd, relativePath);
    const contents = readFileSync(absolutePath, 'utf8');
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

/*
 * Create a plugin to detect violations of the Node.js module usage rule.
 */
export function createNodeModuleErrorPlugin(): esbuild.Plugin {
  return {
    name: 'workflow-node-module-error',
    setup(build) {
      const cwd = process.cwd();
      const importParents = new Map<string, string>();
      const packageViolations: PackageViolation[] = [];
      const seenViolations = new Set<string>();
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (!args.importer || args.importer.includes('node_modules'))
          return null;

        try {
          const resolvedChild = await enhancedResolve(
            args.resolveDir,
            args.path
          );

          if (resolvedChild) {
            importParents.set(
              normalize(resolvedChild),
              normalize(args.importer)
            );
          }
        } catch {
          // ignore
        }
        return null;
      });
      build.onResolve({ filter: nodeModulesRegex }, async (args) => {
        const importerPath = resolve(cwd, args.importer);
        let current = importerPath;
        const chain: string[] = [];
        while (current) {
          chain.push(current);
          current = importParents.get(current) ?? '';
        }
        const filteredChain = chain.filter(
          (path) => !path.includes('node_modules')
        );

        const workflowFile = filteredChain[0] ?? importerPath;

        if (!workflowFile) {
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
          const location = getViolationLocation(
            cwd,
            relativeWorkflowFile,
            packageName
          );
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
      build.onEnd(() => {
        if (packageViolations.length > 0) {
          return {
            errors: packageViolations.map((violation) => {
              return {
                text: `You are attempting to use a function from "${violation.packageName}" which is incompatible with workflow functions since it uses Node.js modules.\n\nLearn more: https://useworkflow.dev/err/${ERROR_SLUGS.NODE_JS_MODULE_IN_WORKFLOW}`,
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
