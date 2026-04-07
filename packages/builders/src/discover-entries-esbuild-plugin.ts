import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import enhancedResolveOriginal from 'enhanced-resolve';
import type { Plugin } from 'esbuild';
import type { WorkflowManifest } from './apply-swc-transform.js';
import { applySwcTransform } from './apply-swc-transform.js';
import {
  detectWorkflowPatterns,
  isGeneratedWorkflowFile,
  isWorkflowSdkFile,
} from './transform-utils.js';

const enhancedResolve = promisify(enhancedResolveOriginal);

export const jsTsRegex = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

/** Returns true if a manifest section has at least one entry. */
function hasManifestEntries(
  section: WorkflowManifest[keyof WorkflowManifest]
): boolean {
  if (!section) return false;
  return Object.values(section).some(
    (entries) => Object.keys(entries).length > 0
  );
}

function isGeneratedBuildArtifactPath(filePath: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/');
  return (
    normalizedPath.includes('/.output/') ||
    normalizedPath.includes('/.next/') ||
    normalizedPath.includes('/.nuxt/') ||
    normalizedPath.includes('/.svelte-kit/') ||
    normalizedPath.includes('/.vercel/')
  );
}

// parent -> children relationship (a file can import multiple files)
export const importParents = new Map<string, Set<string>>();

// check if a parent has a child in its import chain
// e.g. if a dependency needs to be bundled because it has
// a 'use workflow/'use step' directive in it
export function parentHasChild(parent: string, childToFind: string): boolean {
  const visited = new Set<string>();
  const queue: string[] = [parent];

  while (queue.length > 0) {
    const current = queue.shift()!;

    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    const children = importParents.get(current);
    if (!children) {
      continue;
    }

    for (const child of children) {
      if (child === childToFind) {
        return true;
      }
      queue.push(child);
    }
  }

  return false;
}

export function createDiscoverEntriesPlugin(
  state: {
    discoveredSteps: Set<string>;
    discoveredWorkflows: Set<string>;
    discoveredSerdeFiles: Set<string>;
  },
  projectRoot?: string
): Plugin {
  return {
    name: 'discover-entries-esbuild-plugin',
    setup(build) {
      build.onResolve({ filter: jsTsRegex }, async (args) => {
        try {
          const resolved = await enhancedResolve(args.resolveDir, args.path);

          if (resolved) {
            // Normalize path separators for cross-platform compatibility
            const normalizedImporter = args.importer.replace(/\\/g, '/');
            const normalizedResolved = resolved.replace(/\\/g, '/');
            // A file can import multiple files, so we store a Set of children
            let children = importParents.get(normalizedImporter);
            if (!children) {
              children = new Set<string>();
              importParents.set(normalizedImporter, children);
            }
            children.add(normalizedResolved);
          }
        } catch (_) {}
        return null;
      });

      // Handle TypeScript and JavaScript files
      build.onLoad({ filter: jsTsRegex }, async (args) => {
        try {
          if (isGeneratedBuildArtifactPath(args.path)) {
            return {
              contents: '',
              loader: 'js',
            };
          }

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

          // Normalize path separators to forward slashes for cross-platform compatibility
          // This is critical for Windows where paths contain backslashes
          const normalizedPath = args.path.replace(/\\/g, '/');

          const resolvedProjectRoot =
            projectRoot || build.initialOptions.absWorkingDir || process.cwd();

          // Two-phase discovery:
          //  1. Fast regexp pre-scan filters out the vast majority of files.
          //  2. For the small number that match, run the SWC plugin in 'detect'
          //     mode to get an AST-level manifest. Detect mode walks the AST to
          //     find directives and serde patterns but does NOT transform any
          //     code, eliminating false positives where directive-like strings
          //     appear inside template literals, regular strings, or comments.
          //
          // All files are transformed by SWC (TS→JS, decorators, etc.) since
          // esbuild does not support all TypeScript syntax (e.g. legacy
          // decorators, emitDecoratorMetadata). For regexp-matched files the
          // 'detect' call handles both the syntax transform and the manifest
          // in a single pass; for all other files a mode:false call is used.
          const patterns = detectWorkflowPatterns(source);

          let transformedCode: string;

          if (patterns.hasDirective || patterns.hasSerde) {
            const { code, workflowManifest } = await applySwcTransform(
              normalizedPath,
              source,
              'detect',
              normalizedPath,
              resolvedProjectRoot
            );
            transformedCode = code;

            if (hasManifestEntries(workflowManifest.workflows)) {
              state.discoveredWorkflows.add(normalizedPath);
            }
            if (hasManifestEntries(workflowManifest.steps)) {
              state.discoveredSteps.add(normalizedPath);
            }

            // For @workflow SDK packages, only discover files with actual
            // directives, not files that just match serde patterns (internal
            // SDK implementation files).
            const isSdkFile = isWorkflowSdkFile(args.path);
            if (hasManifestEntries(workflowManifest.classes) && !isSdkFile) {
              state.discoveredSerdeFiles.add(normalizedPath);
            }
          } else {
            const { code } = await applySwcTransform(
              normalizedPath,
              source,
              false,
              normalizedPath,
              resolvedProjectRoot
            );
            transformedCode = code;
          }

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
