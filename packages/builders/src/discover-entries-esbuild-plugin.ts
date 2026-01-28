import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import enhancedResolveOrig from 'enhanced-resolve';
import type { Plugin } from 'esbuild';
import { applySwcTransform } from './apply-swc-transform.js';
import {
  detectWorkflowPatterns,
  isGeneratedWorkflowFile,
  isWorkflowSdkFile,
} from './transform-utils.js';

// Create resolver with ESM conditions to properly resolve package exports.
// The 'workflow' condition is first to prefer workflow-optimized entry points
// (e.g., packages that export a lightweight version for workflow VMs).
const enhancedResolve = promisify(
  enhancedResolveOrig.create({
    conditionNames: ['workflow', 'node', 'import', 'default'],
    exportsFields: ['exports'],
    extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
  })
);

export const jsTsRegex = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

// parent -> child relationship
export const importParents = new Map<string, string>();

/**
 * Maps resolved file paths to their package names.
 * When a file is resolved via a bare specifier import (e.g., "just-bash/workflow"),
 * we track the package name so it can be used for generating stable IDs.
 */
export const resolvedPathToPackageName = new Map<string, string>();

/**
 * Extract the package name from a bare specifier import.
 * Returns null if it's not a package import (e.g., relative path).
 *
 * Examples:
 * - "just-bash" → "just-bash"
 * - "just-bash/workflow" → "just-bash"
 * - "@scope/pkg" → "@scope/pkg"
 * - "@scope/pkg/subpath" → "@scope/pkg"
 * - "./foo" → null
 */
function extractPackageNameFromSpecifier(specifier: string): string | null {
  // Not a bare specifier
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    return null;
  }

  const parts = specifier.split('/');

  // Scoped package: @scope/name or @scope/name/subpath
  if (parts[0].startsWith('@')) {
    if (parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`;
    }
    return null;
  }

  // Regular package: name or name/subpath
  return parts[0];
}

// check if a parent has a child in it's import chain
// e.g. if a dependency needs to be bundled because it has
// a 'use workflow/'use step' directive in it
export function parentHasChild(parent: string, childToFind: string) {
  let child: string | undefined;
  let currentParent: string | undefined = parent;
  const visited = new Set<string>();

  do {
    if (currentParent) {
      // Detect circular imports to prevent infinite loop
      if (visited.has(currentParent)) {
        break;
      }
      visited.add(currentParent);
      child = importParents.get(currentParent);
    }

    if (child === childToFind) {
      return true;
    }
    currentParent = child;
  } while (child && currentParent);

  return false;
}

export function createDiscoverEntriesPlugin(state: {
  discoveredSteps: string[];
  discoveredWorkflows: string[];
  discoveredSerdeFiles: string[];
}): Plugin {
  return {
    name: 'discover-entries-esbuild-plugin',
    setup(build) {
      // Track ALL imports (not just file paths with extensions) to build
      // the parent-child relationship map. This is critical for detecting
      // when a package like "just-bash" re-exports code containing
      // 'use step', 'use workflow', or serde patterns from internal files.
      build.onResolve({ filter: /.*/ }, async (args) => {
        try {
          const resolved = await enhancedResolve(args.resolveDir, args.path);

          if (resolved) {
            importParents.set(args.importer, resolved);

            // Track package name for bare specifier imports
            // This allows us to generate stable IDs for files from packages
            const packageName = extractPackageNameFromSpecifier(args.path);
            if (packageName) {
              const normalizedResolved = resolved.replace(/\\/g, '/');
              resolvedPathToPackageName.set(normalizedResolved, packageName);
            }
          }
        } catch {
          // Ignore resolution errors
        }
        return null;
      });

      // Handle TypeScript and JavaScript files
      build.onLoad({ filter: jsTsRegex }, async (args) => {
        try {
          // Skip generated workflow route files to avoid re-processing them
          if (isGeneratedWorkflowFile(args.path)) {
            const source = await readFile(args.path, 'utf8');
            return {
              contents: source,
              loader: args.path.endsWith('.jsx') ? 'jsx' : 'js',
            };
          }

          // Determine the loader based on the output
          let loader: 'js' | 'jsx' = 'js';
          const isTypeScript =
            args.path.endsWith('.ts') ||
            args.path.endsWith('.tsx') ||
            args.path.endsWith('.mts') ||
            args.path.endsWith('.cts');
          if (!isTypeScript && args.path.endsWith('.jsx')) {
            loader = 'jsx';
          }
          const source = await readFile(args.path, 'utf8');
          const patterns = detectWorkflowPatterns(source);

          // Normalize path separators to forward slashes for cross-platform compatibility
          // This is critical for Windows where paths contain backslashes
          const normalizedPath = args.path.replace(/\\/g, '/');

          // For @workflow SDK packages, only discover files with actual directives,
          // not files that just match serde patterns (which are internal SDK implementation files)
          const isSdkFile = isWorkflowSdkFile(args.path);

          if (patterns.hasUseWorkflow) {
            state.discoveredWorkflows.push(normalizedPath);
          }

          if (patterns.hasUseStep) {
            state.discoveredSteps.push(normalizedPath);
          }

          // Track all serde files separately for cross-context class registration.
          // Classes need to be registered in all bundle contexts (step, workflow, client)
          // to support serialization across execution boundaries.
          // Skip @workflow SDK packages since those are internal implementation files.
          if (patterns.hasSerde && !isSdkFile) {
            if (!state.discoveredSerdeFiles.includes(normalizedPath)) {
              state.discoveredSerdeFiles.push(normalizedPath);
            }
          }

          const { code: transformedCode } = await applySwcTransform(
            args.path,
            source,
            false
          );

          return {
            contents: transformedCode,
            loader,
          };
        } catch (_) {
          // ignore trace errors during discover phase
          return {
            contents: '',
            loader: 'js',
          };
        }
      });
    },
  };
}
