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

function isRetryableTurbopackLoaderFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('TurbopackInternalError') &&
    message.includes('failed to receive message') &&
    message.includes('evaluate_webpack_loader')
  );
}

async function runBuildWithRetry(cwd: string): Promise<CommandResult> {
  try {
    return await runCommandWithLiveOutput('pnpm', ['build'], cwd);
  } catch (error) {
    if (!isRetryableTurbopackLoaderFailure(error)) {
      throw error;
    }

    console.warn('Retrying build after Turbopack loader transport failure.');
    return await runCommandWithLiveOutput('pnpm', ['build'], cwd);
  }
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

const SOURCE_MAP_WARNING = 'failed to read input source map';
const SOURCE_MAP_FIXTURE_PACKAGE = 'workflow-sourcemap-warning-fixture';
const SOURCE_MAP_COMMENT = '//# sourceMapping' + 'URL=index.js.map';

async function writeFileWithParents(
  filePath: string,
  content: string
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

async function setupNextSourceMapWarningFixture(
  appPath: string
): Promise<() => Promise<void>> {
  const packageDir = path.join(
    appPath,
    'node_modules',
    SOURCE_MAP_FIXTURE_PACKAGE
  );
  const workflowPath = path.join(
    appPath,
    'workflows',
    'source-map-warning-fixture.ts'
  );

  await writeFileWithParents(
    path.join(packageDir, 'package.json'),
    JSON.stringify(
      {
        name: SOURCE_MAP_FIXTURE_PACKAGE,
        version: '0.0.0',
        type: 'module',
        main: './index.js',
        types: './index.d.ts',
      },
      null,
      2
    )
  );
  await writeFileWithParents(
    path.join(packageDir, 'index.js'),
    `export const sourceMapWarningFixtureValue = Symbol.for('workflow-serialize').description ?? 'workflow-serialize';
${SOURCE_MAP_COMMENT}
`
  );
  await writeFileWithParents(
    path.join(packageDir, 'index.d.ts'),
    `export declare const sourceMapWarningFixtureValue: string;
`
  );
  await writeFileWithParents(
    workflowPath,
    `import { sourceMapWarningFixtureValue } from '${SOURCE_MAP_FIXTURE_PACKAGE}';

async function readSourceMapWarningFixture() {
  'use step';
  return sourceMapWarningFixtureValue;
}

export async function sourceMapWarningFixtureWorkflow() {
  'use workflow';
  return readSourceMapWarningFixture();
}
`
  );

  return async () => {
    await Promise.all([
      fs.rm(packageDir, { recursive: true, force: true }),
      fs.rm(workflowPath, { force: true }),
    ]);
  };
}

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
  'tanstack-start',
])('e2e', (project) => {
  test('builds without errors', { timeout: 180_000 }, async () => {
    // skip if we're targeting specific app to test
    if (process.env.APP_NAME && project !== process.env.APP_NAME) {
      return;
    }

    const appPath = getWorkbenchAppPath(project);

    if (project === 'sveltekit') {
      const importResult = await runCommandWithLiveOutput(
        process.execPath,
        [
          '-e',
          "import('workflow/sveltekit').then(() => console.log('workflow/sveltekit import ok')).catch((error) => { console.error(error); process.exit(1); })",
        ],
        appPath
      );

      expect(importResult.output).toContain('workflow/sveltekit import ok');
    }

    const cleanup =
      project === 'nextjs-turbopack'
        ? await setupNextSourceMapWarningFixture(appPath)
        : async () => {};
    const preserveFixtureForBuiltOutput =
      project === 'nextjs-turbopack' && process.env.CI === 'true';

    let result: CommandResult;
    try {
      result = await runBuildWithRetry(appPath);
    } finally {
      // CI starts the just-built app in the same prepared workbench path after
      // this test. Turbopack production bundles can retain references to the
      // fixture package/source, so keep them available until the job ends.
      if (!preserveFixtureForBuiltOutput) {
        await cleanup();
      }
    }

    expect(result.output).not.toContain('Error:');
    expect(result.output).not.toContain(SOURCE_MAP_WARNING);

    if (usesVercelWorld()) {
      const diagnosticsManifestPath = path.join(
        appPath,
        '.vercel/output/diagnostics/workflows-manifest.json'
      );
      await fs.access(diagnosticsManifestPath);
    }

    // Verify CJS import.meta polyfill is present in CJS step bundles
    const cjsBundlePath = CJS_STEP_BUNDLE_PROJECTS[project];
    if (cjsBundlePath) {
      const bundleContent = await readFileIfExists(
        path.join(appPath, cjsBundlePath)
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
