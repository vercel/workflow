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

/**
 * Whether a specifier names a Node.js or Bun built-in module (with or without
 * the `node:` / `bun:` prefix).
 */
export function isRuntimeBuiltinSpecifier(specifier: string): boolean {
  return runtimeModulesRegex.test(specifier);
}

/**
 * esbuild namespace for the stand-in modules that replace built-ins imported
 * only by dependencies. Shows up in metafile inputs as
 * `workflow-unavailable-builtin:<specifier>`.
 */
export const UNAVAILABLE_BUILTIN_NAMESPACE = 'workflow-unavailable-builtin';

const DOCS_URL = `https://workflow-sdk.dev/err/${ERROR_SLUGS.NODE_JS_MODULE_IN_WORKFLOW}`;

/**
 * Built-ins that print a runtime deprecation warning when loaded. Their export
 * names are not enumerated (see {@link getBuiltinExportNames}), so the build
 * does not print that warning on the user's behalf.
 */
const DEPRECATED_ON_LOAD = /^(node:)?(punycode|sys|_stream_\w+|_tls_\w+)$/;

const builtinExportNamesCache = new Map<string, string[]>();

/**
 * The names a built-in exports in the Node.js running the build, so the
 * stand-in module can offer the same named exports. Bun modules (and anything
 * this Node.js does not have) get none, and their named imports read as
 * `undefined`.
 */
function getBuiltinExportNames(specifier: string): string[] {
  const cached = builtinExportNamesCache.get(specifier);
  if (cached) return cached;
  let names: string[] = [];
  if (!bunModulesRegex.test(specifier) && !DEPRECATED_ON_LOAD.test(specifier)) {
    try {
      const mod = process.getBuiltinModule?.(specifier) as
        | Record<string, unknown>
        | undefined;
      if (mod) {
        names = Object.keys(mod).filter(
          (name) => name !== 'default' && name !== '__esModule'
        );
      }
    } catch {
      // Not a built-in in this Node.js version.
    }
  }
  builtinExportNamesCache.set(specifier, names);
  return names;
}

/**
 * Source of the CommonJS module that stands in for a Node.js / Bun built-in a
 * dependency imports, inside the workflow bundle.
 *
 * The workflow sandbox has no `require`, so leaving the built-in external (a
 * top-level `require("node:crypto")`) would stop the whole bundle from
 * loading, even when no workflow ever reaches the code that needs it. The
 * stand-in loads fine. Each export is a function that throws a descriptive
 * error when it is called or constructed, and so is every property read off
 * one (`Buffer.from`), so only code that really uses the module fails, at the
 * point where it uses it.
 */
export function createUnavailableBuiltinModule(
  specifier: string,
  exportNames: string[]
): string {
  const message = [
    `"${specifier}" is a ${getModuleTypeLabel(specifier)} module, and ${getModuleTypeLabel(specifier)} modules are not available in workflow functions.`,
    'A dependency of this workflow imports it, which is fine as long as workflow code never calls into it.',
    'Move the code that calls it into a "use step" function.',
    '',
    `Learn more: ${DOCS_URL}`,
  ].join('\n');
  return `"use strict";
var specifier = ${JSON.stringify(specifier)};
var message = ${JSON.stringify(message)};
function fail(path) {
  var error = new Error("Cannot use " + path + ": " + message);
  error.name = "NodeJsModuleInWorkflowError";
  throw error;
}
function unavailable(path) {
  var target = function () {};
  return new Proxy(target, {
    apply: function () { return fail(path); },
    construct: function () { return fail(path); },
    get: function (target, key, receiver) {
      // Keep function internals (prototype, name, Symbol.hasInstance, ...)
      // so \`extends\`, \`instanceof\` and \`typeof\` checks still work, and
      // never look thenable.
      if (typeof key !== "string" || key in target) return Reflect.get(target, key, receiver);
      if (key === "then") return undefined;
      return unavailable(path + "." + key);
    },
  });
}
var names = ${JSON.stringify(exportNames)};
for (var i = 0; i < names.length; i++) {
  exports[names[i]] = unavailable(specifier + "." + names[i]);
}
`;
}

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
 * Get the package name from an import specifier.
 * @param specifier - The import specifier to parse.
 * @returns The package name (for bare package imports), otherwise null.
 */
function getPackageNameFromSpecifier(specifier: string) {
  // Not a bare package specifier (relative, absolute, or URL-like)
  if (
    !specifier ||
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(specifier)
  ) {
    return null;
  }

  // Ignore runtime built-ins and URL-like specifiers
  if (
    runtimeModulesRegex.test(specifier) ||
    specifier.includes('://') ||
    specifier.startsWith('#')
  ) {
    return null;
  }

  const normalized = specifier.replace(/\\/g, '/');
  if (normalized.startsWith('@')) {
    const [scope, name] = normalized.split('/');
    if (!scope || !name) {
      return null;
    }
    return `${scope}/${name}`;
  }

  const [name] = normalized.split('/');
  return name ?? null;
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
  let inBlockComment = false;

  for (let i = startIndex; i < lines.length; i += 1) {
    // Strip string literals first so that comment delimiters inside strings
    // (e.g. `const s = "/*";`) don't confuse the comment scanner.
    const stringsStripped = lines[i]
      .replace(/'(?:[^'\\]|\\.)*'/g, (s) => ' '.repeat(s.length))
      .replace(/"(?:[^"\\]|\\.)*"/g, (s) => ' '.repeat(s.length))
      .replace(/`(?:[^`\\]|\\.)*`/g, (s) => ' '.repeat(s.length));

    let line = stringsStripped;

    // Handle multi-line block comments (including JSDoc)
    if (inBlockComment) {
      const endIdx = line.indexOf('*/');
      if (endIdx === -1) {
        continue;
      }
      line = ' '.repeat(endIdx + 2) + line.slice(endIdx + 2);
      inBlockComment = false;
    }

    // Scan for comments, replacing them with spaces
    let processed = '';
    let j = 0;
    while (j < line.length) {
      if (line[j] === '/' && line[j + 1] === '/') {
        processed += ' '.repeat(line.length - j);
        break;
      }
      if (line[j] === '/' && line[j + 1] === '*') {
        const endIdx = line.indexOf('*/', j + 2);
        if (endIdx !== -1) {
          const len = endIdx + 2 - j;
          processed += ' '.repeat(len);
          j = endIdx + 2;
        } else {
          processed += ' '.repeat(line.length - j);
          inBlockComment = true;
          break;
        }
      } else {
        processed += line[j];
        j += 1;
      }
    }

    const match = processed.match(usageRegex);
    if (match && match.index !== undefined) {
      return {
        line: i,
        column: match.index,
        lineText: lines[i],
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

    // Match against the whole file so imports spanning several lines are
    // found. The specifier excludes `;` and quotes so a match can't start at
    // an earlier import statement and run on into this one. The match must
    // also start a statement (line start or after `;`), so the word `import`
    // in a preceding comment can't become the start of the match.
    const importRegex = new RegExp(
      `(?:^|;)[ \\t]*import\\s+([^;'"]+?)\\s+from\\s+['"]${escapeRegExp(packageName)}(?:/[^'"]*)?['"]`,
      'm'
    );
    const importMatch = contents.match(importRegex);

    if (importMatch && importMatch.index !== undefined) {
      const startLine =
        contents.slice(0, importMatch.index).split(/\r?\n/).length - 1;
      const endLine = startLine + importMatch[0].split(/\r?\n/).length - 1;

      const specifier = importMatch[1].trim();
      const identifier = getImportedIdentifier(specifier);
      if (identifier) {
        const usage = findIdentifierUsage(lines, endLine + 1, identifier);
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
      const line = lines[endLine];
      const columnIndex = line.indexOf(packageName);
      if (columnIndex !== -1) {
        return {
          file: relativePath,
          line: endLine + 1,
          column: columnIndex,
          lineText: line,
          length: packageName.length,
        };
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

/** Inputs that contributed code to the output, i.e. survived tree-shaking. */
function getEmittedInputs(metafile: esbuild.Metafile): Set<string> {
  const emitted = new Set<string>();
  for (const output of Object.values(metafile.outputs)) {
    for (const [input, info] of Object.entries(output.inputs)) {
      if (info.bytesInOutput > 0) emitted.add(input);
    }
  }
  return emitted;
}

/** Maps each stand-in built-in in the output to the inputs importing it. */
function getUnavailableBuiltinImporters(
  metafile: esbuild.Metafile
): Map<string, string[]> {
  const prefix = `${UNAVAILABLE_BUILTIN_NAMESPACE}:`;
  const emitted = getEmittedInputs(metafile);
  const importersBySpecifier = new Map<string, string[]>();
  for (const [input, info] of Object.entries(metafile.inputs)) {
    if (!emitted.has(input)) continue;
    const stubs = info.imports.filter(
      (imp) => imp.path.startsWith(prefix) && emitted.has(imp.path)
    );
    for (const imp of stubs) {
      const specifier = imp.path.slice(prefix.length);
      const importers = importersBySpecifier.get(specifier) ?? [];
      if (!importers.includes(input)) importers.push(input);
      importersBySpecifier.set(specifier, importers);
    }
  }
  return importersBySpecifier;
}

/**
 * Describes the built-ins that dependencies still import after tree-shaking
 * and that the workflow bundle replaced with stand-ins, each with a module
 * that imports it. Returns `undefined` when there are none. The bundle loads
 * either way; this says where to look if a workflow does reach that code.
 */
export function formatUnavailableBuiltinWarning(
  metafile: esbuild.Metafile | undefined
): string | undefined {
  if (!metafile) return undefined;
  const importersBySpecifier = getUnavailableBuiltinImporters(metafile);
  if (importersBySpecifier.size === 0) return undefined;

  const lines = [...importersBySpecifier.keys()].sort().map((specifier) => {
    const importers = (importersBySpecifier.get(specifier) ?? []).sort();
    const more =
      importers.length > 1 ? ` (and ${importers.length - 1} more)` : '';
    return `  • "${specifier}" imported by ${importers[0]}${more}`;
  });
  return [
    'The workflow bundle includes dependencies that import Node.js or Bun modules, which are not available in workflow functions:',
    ...lines,
    '',
    'Each one is replaced with a stand-in that throws if a workflow calls into it, so the bundle still loads. If a workflow needs that code, move it into a "use step" function.',
    `Learn more: ${DOCS_URL}`,
  ].join('\n');
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
      // Whether each package/workflow-file pair was reported as a violation.
      const reportedViolations = new Map<string, boolean>();

      // Enable the esbuild metafile so we can inspect which Node.js / Bun
      // built-in imports actually survive tree-shaking. We need this to
      // suppress false positives where a shared module has a workflow-safe
      // export alongside a step-only export that references Node.js builtins.
      // esbuild's tree-shaker can drop the step-only branch, but `onResolve`
      // fires before tree-shaking, so we defer the final error decision to
      // `onEnd` (see the metafile-based filter below).
      build.initialOptions.metafile = true;

      // Track ALL import relationships to build the dependency graph.
      // This is necessary to trace transitive dependencies back to user code.
      // Performance impact is minimal as we only store path mappings.
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (!args.importer) return null;

        const parentValue = normalize(args.importer);
        const specifierPackageName = getPackageNameFromSpecifier(args.path);

        try {
          const resolvedChild = await enhancedResolve(
            args.resolveDir,
            args.path
          );

          if (resolvedChild) {
            const childKey = normalize(resolvedChild);
            importParents.set(childKey, parentValue);

            // Record the resolved package edge so transitive builtin usage can
            // still trace back even when esbuild and enhanced-resolve pick
            // different entry files (e.g. `module` vs `main`).
            const resolvedPackageName = getPackageName(childKey);
            if (resolvedPackageName) {
              importParents.set(resolvedPackageName, parentValue);
            }
          }

          // Also preserve the bare package-specifier edge (e.g. "postgres"),
          // which is the fallback key used when tracing from files in
          // node_modules back to user code.
          if (specifierPackageName) {
            importParents.set(specifierPackageName, parentValue);
          }
        } catch {
          // For built-in modules that can't be resolved, still track using the import path
          const childKey = args.path;
          importParents.set(childKey, parentValue);

          if (specifierPackageName) {
            importParents.set(specifierPackageName, parentValue);
          }
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

        // A built-in that only a dependency imports, which the user never
        // imported themselves. Bundling the dependency does not mean any
        // workflow calls the code that needs the built-in (a provider SDK
        // pulled in through a barrel file, a checksum helper picked at module
        // load), so swap in a stand-in that loads and only throws when it is
        // used. Built-ins imported from user code, and packages the user
        // imports directly that need one, stay external below and fail the
        // build instead.
        const stubUnreported = importerPath.includes('node_modules');
        const unavailable = {
          path: args.path,
          namespace: UNAVAILABLE_BUILTIN_NAMESPACE,
          // Lets esbuild drop the import when nothing that survives
          // tree-shaking reads from it.
          sideEffects: false,
        };

        if (!workflowFile || workflowFile.includes('node_modules')) {
          if (stubUnreported) return unavailable;
          // Mark builtin imports as side-effect-free so esbuild can tree-shake
          // them when they're only referenced by dead (e.g. step-only) code
          // paths in shared modules. The onEnd filter below uses the metafile
          // to decide which imports actually survive.
          return {
            path: args.path,
            external: true,
            sideEffects: false,
          };
        }

        const packageName = importerPath.includes('node_modules')
          ? (getPackageName(importerPath) ?? args.path)
          : args.path;

        const relativeWorkflowFile = relative(cwd, workflowFile);
        const violationKey = `${packageName}:${relativeWorkflowFile}`;

        let reported = reportedViolations.get(violationKey);
        if (reported === undefined) {
          const location = await getViolationLocation(
            cwd,
            relativeWorkflowFile,
            packageName
          );
          // Only report violations where we can find the import location.
          // If we can't find it, the package is likely a transitive dependency
          // that the user didn't directly import - we'll report the top-level
          // package they did import instead.
          reported = location !== undefined && location !== null;
          reportedViolations.set(violationKey, reported);
          if (location) {
            packageViolations.push({
              path: args.path,
              importer: relativeWorkflowFile,
              packageName,
              location,
            });
          }
        }

        if (!reported && stubUnreported) return unavailable;

        // Mark builtin imports as side-effect-free so esbuild can tree-shake
        // them when they're only referenced by dead (e.g. step-only) code
        // paths in shared modules. The onEnd filter below uses the metafile
        // to decide which imports actually survive.
        return {
          path: args.path,
          external: true,
          sideEffects: false,
        };
      });

      // Report violations at the end of the build, filtered to only those
      // whose Node.js / Bun builtin imports actually survived tree-shaking.
      //
      // `onResolve` fires during module loading, before esbuild's tree-shaker
      // runs. That means a shared module whose step-only export references a
      // builtin will record a violation even if the workflow never touches
      // that export. By marking builtin imports as `sideEffects: false` in
      // `onResolve` above, esbuild can drop such imports from the output.
      // Here we consult the metafile to see which builtin imports remain
      // in the emitted bundle and only report those.
      build.onLoad(
        { filter: /.*/, namespace: UNAVAILABLE_BUILTIN_NAMESPACE },
        (args) => ({
          contents: createUnavailableBuiltinModule(
            args.path,
            getBuiltinExportNames(args.path)
          ),
          loader: 'js',
        })
      );

      build.onEnd((result) => {
        if (packageViolations.length === 0) return;

        const survivingBuiltins = new Set<string>();
        const outputs = result.metafile?.outputs;
        if (outputs) {
          for (const output of Object.values(outputs)) {
            for (const imp of output.imports) {
              // External imports in the metafile are recorded with the path
              // that was returned from `onResolve` (e.g. "node:fs/promises",
              // "fs", "bun:sqlite"). Only collect the ones that match
              // Node.js / Bun builtins.
              if (imp.external && runtimeModulesRegex.test(imp.path)) {
                survivingBuiltins.add(imp.path);
              }
            }
          }
        }

        // If the metafile is unavailable for some reason, fall back to
        // reporting all recorded violations so we never silently suppress
        // real ones.
        const liveViolations = outputs
          ? packageViolations.filter((violation) =>
              survivingBuiltins.has(violation.path)
            )
          : packageViolations;

        if (liveViolations.length === 0) return;

        return {
          errors: liveViolations.map((violation) => {
            const isBuiltinModule = runtimeModulesRegex.test(
              violation.packageName
            );
            const moduleType = getModuleTypeLabel(violation.path);

            // Different messages for built-in modules vs npm packages that use them
            const text = isBuiltinModule
              ? `You are attempting to use "${violation.packageName}" which is a ${moduleType} module. ${moduleType} modules are not available in workflow functions.\n\nLearn more: https://workflow-sdk.dev/err/${ERROR_SLUGS.NODE_JS_MODULE_IN_WORKFLOW}`
              : `You are attempting to use "${violation.packageName}" which depends on ${moduleType} modules. Packages that depend on ${moduleType} modules are not available in workflow functions.\n\nLearn more: https://workflow-sdk.dev/err/${ERROR_SLUGS.NODE_JS_MODULE_IN_WORKFLOW}`;

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
      });
    },
  };
}
