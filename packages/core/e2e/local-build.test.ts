import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { getWorkbenchAppPath } from './utils';

interface CommandResult {
  stdout: string;
  stderr: string;
  output: string;
}

async function runCommandWithLiveOutput(
  command: string,
  args: string[],
  cwd: string
): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let output = '';

    child.stdout?.on('data', (chunk) => {
      const text = Buffer.isBuffer(chunk)
        ? chunk.toString('utf8')
        : String(chunk);
      process.stdout.write(chunk);
      stdout += text;
      output += text;
    });

    child.stderr?.on('data', (chunk) => {
      const text = Buffer.isBuffer(chunk)
        ? chunk.toString('utf8')
        : String(chunk);
      process.stderr.write(chunk);
      stderr += text;
      output += text;
    });

    child.once('error', reject);

    child.once('close', (code, signal) => {
      if (code !== 0) {
        const exitInfo = signal
          ? `signal ${signal}`
          : `exit code ${String(code)}`;
        reject(
          new Error(
            `Command "${command} ${args.join(' ')}" failed with ${exitInfo}\n${output}`
          )
        );
        return;
      }

      resolve({ stdout, stderr, output });
    });
  });
}

/**
 * Read a file if it exists, return null otherwise.
 */
async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Projects that use the VercelBuildOutputAPIBuilder and produce ESM step bundles.
 */
const ESM_STEP_BUNDLE_PROJECTS: Record<string, string> = {
  example:
    '.vercel/output/functions/.well-known/workflow/v1/step.func/index.mjs',
};

const DIAGNOSTICS_MANIFEST_PATHS: Record<string, string> = {
  example: '.vercel/output/diagnostics/workflows-manifest.json',
  'nextjs-webpack': '.next/diagnostics/workflows-manifest.json',
  'nextjs-turbopack': '.next/diagnostics/workflows-manifest.json',
};

const DEFERRED_BUILD_MODE_PROJECTS = new Set([
  'nextjs-webpack',
  'nextjs-turbopack',
]);
const DEFERRED_BUILD_UNSUPPORTED_WARNING =
  'Enabled lazyDiscovery but Next.js version is not compatible';
const EAGER_DISCOVERY_LOG = 'Discovering workflow directives';

describe.each([
  'example',
  'nextjs-webpack',
  'nextjs-turbopack',
  'nitro',
  'vite',
  'sveltekit',
  'nuxt',
  'hono',
  'express',
  'fastify',
  'nest',
  'astro',
])('e2e', (project) => {
  test('builds without errors', { timeout: 180_000 }, async () => {
    // skip if we're targeting specific app to test
    if (process.env.APP_NAME && project !== process.env.APP_NAME) {
      return;
    }

    const result = await runCommandWithLiveOutput(
      'pnpm',
      ['build'],
      getWorkbenchAppPath(project)
    );

    expect(result.output).not.toContain('Error:');

    if (DEFERRED_BUILD_MODE_PROJECTS.has(project)) {
      const deferredBuildSupported = !result.output.includes(
        DEFERRED_BUILD_UNSUPPORTED_WARNING
      );
      if (deferredBuildSupported) {
        expect(result.output).not.toContain(EAGER_DISCOVERY_LOG);
      }
    }

    const diagnosticsManifestPath = DIAGNOSTICS_MANIFEST_PATHS[project];
    if (diagnosticsManifestPath) {
      const resolvedDiagnosticsManifestPath = path.join(
        getWorkbenchAppPath(project),
        diagnosticsManifestPath
      );
      await fs.access(resolvedDiagnosticsManifestPath);
    }

    // Verify ESM step bundles use native import.meta (no CJS polyfill needed)
    const esmBundlePath = ESM_STEP_BUNDLE_PROJECTS[project];
    if (esmBundlePath) {
      const bundleContent = await readFileIfExists(
        path.join(getWorkbenchAppPath(project), esmBundlePath)
      );
      expect(bundleContent).not.toBeNull();
      // ESM output should NOT contain CJS polyfill
      expect(bundleContent).not.toContain('var __import_meta_url');
      expect(bundleContent).not.toContain('pathToFileURL(__filename)');
    }
  });
});
