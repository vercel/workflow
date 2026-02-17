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

describe.each([
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
  });
});
