import fs from 'fs';
import path from 'path';

/**
 * Checks if the SWC plugin build has changed and invalidates the Next.js cache if needed.
 * Also registers an exit handler to write the current build hash for future comparisons.
 *
 * @param distDir - The Next.js dist directory (e.g., '.next')
 */
export function maybeInvalidateCacheOnSwcChange(distDir: string): void {
  const cacheDir = path.join(distDir, 'cache');
  const devCacheDir = path.join(distDir, 'dev', 'cache');
  const workflowJsonPath = path.join(cacheDir, 'workflow.json');
  const swcPluginBuildHash = require('@workflow/swc-plugin/build-hash.json')
    .buildHash as string;

  let shouldInvalidateCache = false;
  try {
    const existing = JSON.parse(fs.readFileSync(workflowJsonPath, 'utf-8'));
    if (existing.swcPluginBuildHash !== swcPluginBuildHash) {
      shouldInvalidateCache = true;
    }
  } catch {
    // File doesn't exist or is invalid
    shouldInvalidateCache = true;
  }

  if (shouldInvalidateCache) {
    // Delete cache directories
    const cacheDirs = [cacheDir, devCacheDir];
    for (const dir of cacheDirs) {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }

  // Write workflow.json lazily on process exit
  process.on('exit', () => {
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(
        workflowJsonPath,
        JSON.stringify({ swcPluginBuildHash }, null, 2)
      );
    } catch {
      // Ignore errors on exit
    }
  });
}
