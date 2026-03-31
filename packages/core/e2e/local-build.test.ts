import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { usesVercelWorld } from '../../utils/src/world-target';
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
 * Projects that use the VercelBuildOutputAPIBuilder and produce CJS step bundles.
 * Their step bundles should contain the import.meta.url CJS polyfill.
 */
const CJS_STEP_BUNDLE_PROJECTS: Record<string, string> = {
  example:
    '.vercel/output/functions/.well-known/workflow/v1/step.func/index.js',
};

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

    if (usesVercelWorld()) {
      const diagnosticsManifestPath = path.join(
        getWorkbenchAppPath(project),
        '.vercel/output/diagnostics/workflows-manifest.json'
      );
      await fs.access(diagnosticsManifestPath);
    }

    // Verify CJS import.meta polyfill is present in CJS step bundles
    const cjsBundlePath = CJS_STEP_BUNDLE_PROJECTS[project];
    if (cjsBundlePath) {
      const bundleContent = await readFileIfExists(
        path.join(getWorkbenchAppPath(project), cjsBundlePath)
      );
      expect(bundleContent).not.toBeNull();
      expect(bundleContent).toContain('var __import_meta_url');
      expect(bundleContent).toContain('pathToFileURL(__filename)');
      expect(bundleContent).toContain('var __import_meta_resolve');
      // Raw import.meta.url should be replaced by the define
      expect(bundleContent).not.toMatch(/\bimport\.meta\.url\b/);
    }
  });
});
