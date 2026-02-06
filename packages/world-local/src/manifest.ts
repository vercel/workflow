import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { WorkflowManifestData } from '@workflow/world';

const MANIFEST_FILENAME = 'manifest.json';

/**
 * Known paths where the manifest JSON file may be located, relative to the
 * project root. These match the locations used by framework-specific builders.
 */
const KNOWN_MANIFEST_PATHS = [
  'app/.well-known/workflow/v1/manifest.json',
  'src/app/.well-known/workflow/v1/manifest.json',
  '.well-known/workflow/v1/manifest.json',
  'src/routes/.well-known/workflow/v1/manifest.json',
  'node_modules/.nitro/workflow/manifest.json',
  '.nuxt/workflow/manifest.json',
  '.nestjs/workflow/manifest.json',
];

/**
 * Attempts to read a JSON file. Returns null if the file doesn't exist.
 */
async function tryReadJson(filePath: string): Promise<unknown | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Creates a manifest store backed by the local filesystem.
 *
 * The `get()` method looks for the manifest in two locations:
 * 1. The data directory itself (where `set()` writes it)
 * 2. Known framework-specific manifest locations relative to the project root
 *    (auto-discovered by walking up from the data directory)
 *
 * The `set()` method stores the manifest as a JSON file in the data directory.
 */
export function createManifestStore(dataDir: string) {
  const storedManifestPath = join(dataDir, MANIFEST_FILENAME);

  return {
    async get(): Promise<WorkflowManifestData | null> {
      // First, check the data directory for a manifest stored via set()
      const stored = await tryReadJson(storedManifestPath);
      if (stored) {
        return stored as WorkflowManifestData;
      }

      // Otherwise, search for the manifest in known framework locations
      // Walk up from the data directory to find the project root
      const projectRoot = resolveProjectRoot(dataDir);
      if (projectRoot) {
        for (const manifestPath of KNOWN_MANIFEST_PATHS) {
          const fullPath = join(projectRoot, manifestPath);
          const data = await tryReadJson(fullPath);
          if (data) {
            return data as WorkflowManifestData;
          }
        }
      }

      return null;
    },

    async set(manifest: WorkflowManifestData): Promise<void> {
      await writeFile(
        storedManifestPath,
        JSON.stringify(manifest, null, 2),
        'utf-8'
      );
    },
  };
}

/**
 * Resolves the project root directory from a data directory path.
 * The data directory is typically inside the project root:
 * - .workflow-data/ -> parent is project root
 * - .next/workflow-data/ -> grandparent is project root
 */
function resolveProjectRoot(dataDir: string): string {
  const absDataDir = resolve(dataDir);

  // Check common data dir patterns to determine the project root
  if (absDataDir.endsWith('.workflow-data')) {
    return dirname(absDataDir);
  }
  if (absDataDir.endsWith('workflow-data')) {
    // Could be .next/workflow-data or just workflow-data
    const parent = dirname(absDataDir);
    if (parent.endsWith('.next') || parent.endsWith('.nestjs')) {
      return dirname(parent);
    }
    return parent;
  }

  // Default: assume data dir is inside the project root
  return dirname(absDataDir);
}
