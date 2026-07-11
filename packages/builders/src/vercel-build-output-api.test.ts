import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { VercelBuildOutputConfig } from './types.js';
import { VercelBuildOutputAPIBuilder } from './vercel-build-output-api.js';

const BUILD_TIMEOUT = 120_000;
// A .dylib.node name matches no platform sharedlib glob in nft, so this
// also covers native addons that are traced as plain dependencies.
const engineFile = 'libquery_engine-darwin.dylib.node';
const engineContents = 'fake native query engine\n';
const schemaContents = 'model Fake { id Int @id }\n';
const require = createRequire(import.meta.url);

async function write(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, 'utf8');
}

function getFlowFuncDir(workingDir: string): string {
  return join(
    workingDir,
    '.vercel/output/functions/.well-known/workflow/v1/flow.func'
  );
}

function createBuilder(workingDir: string): VercelBuildOutputAPIBuilder {
  const config: VercelBuildOutputConfig = {
    buildTarget: 'vercel-build-output-api',
    workingDir,
    dirs: ['src'],
    stepsBundlePath: join(workingDir, 'unused-steps.mjs'),
    workflowsBundlePath: join(workingDir, 'unused-workflows.mjs'),
    webhookBundlePath: join(workingDir, 'unused-webhook.mjs'),
    suppressCreateManifestLogs: true,
  };
  return new VercelBuildOutputAPIBuilder(config);
}

function executeStep(workingDir: string, stepName: string): string {
  const bundleUrl = pathToFileURL(
    join(getFlowFuncDir(workingDir), 'index.mjs')
  ).href;
  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(bundleUrl)});
const steps = globalThis[Symbol.for('@workflow/core//registeredSteps')];
const step = [...steps].find(([id]) => id.endsWith(${JSON.stringify(`//${stepName}`)}))?.[1];
if (!step) throw new Error(${JSON.stringify(`${stepName} step was not registered`)});
process.stdout.write(JSON.stringify(await step()));`,
    ],
    { encoding: 'utf8' }
  );
  return JSON.parse(output);
}

/**
 * Minimal stand-in for the `workflow` package so the builder can resolve
 * its runtime imports inside the temp app.
 */
async function writeWorkflowRuntimeStub(workingDir: string): Promise<void> {
  const packageDir = join(workingDir, 'node_modules/workflow');
  await write(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: 'workflow',
      version: '1.0.0',
      type: 'module',
      exports: {
        './api': './api.js',
        './internal/builtins': './internal/builtins.js',
        './runtime': './runtime.js',
      },
    })
  );
  await write(
    join(packageDir, 'api.js'),
    'export async function resumeWebhook() { return new Response(null, { status: 204 }); }\n'
  );
  await write(
    join(packageDir, 'internal/builtins.js'),
    'export const __workflow_builtins = true;\n'
  );
  await write(
    join(packageDir, 'runtime.js'),
    'export function workflowEntrypoint() { return async function POST() { return new Response(null, { status: 204 }); }; }\n'
  );
}

/**
 * Prisma-shaped fixture: a package whose entry resolves a dot-prefixed
 * generated sibling package (like `@prisma/client` → `.prisma/client`)
 * that loads a native query engine from disk at runtime.
 *
 * `packageRoot` is the node_modules directory that hosts the package —
 * either the app's own node_modules (npm/yarn flat layout) or a directory
 * inside the pnpm store.
 */
async function writeFakePrismaClient(packageRoot: string): Promise<void> {
  await write(
    join(packageRoot, 'fake-prisma-client/package.json'),
    JSON.stringify({
      name: 'fake-prisma-client',
      version: '1.0.0',
      main: 'index.js',
    })
  );
  await write(
    join(packageRoot, 'fake-prisma-client/index.js'),
    "module.exports = require('.fake-prisma/client');\n"
  );
  await write(
    join(packageRoot, '.fake-prisma/client/package.json'),
    JSON.stringify({ name: '.fake-prisma/client', main: 'index.js' })
  );
  await write(
    join(packageRoot, '.fake-prisma/client/index.js'),
    `const { readFileSync } = require('fs');
const path = require('path');

// Module-scope __dirname reference, like @prisma/client's runtime — the
// bundled ESM output must provide it (see getEsmRequireBanner).
exports.moduleDir = __dirname;

exports.getQueryEngine = function getQueryEngine() {
  return readFileSync(path.join(__dirname, '${engineFile}'), 'utf8');
};

exports.getSchema = function getSchema() {
  return readFileSync(path.join(__dirname, 'schema.prisma'), 'utf8');
};
`
  );
  await write(
    join(packageRoot, `.fake-prisma/client/${engineFile}`),
    engineContents
  );
  await write(
    join(packageRoot, '.fake-prisma/client/schema.prisma'),
    schemaContents
  );
}

async function writeStepUsingFakePrisma(workingDir: string): Promise<void> {
  await write(
    join(workingDir, 'src/workflows/db.ts'),
    `import { getQueryEngine, getSchema } from 'fake-prisma-client';

export async function readEngine(): Promise<string> {
  'use step';
  return getQueryEngine() + getSchema();
}

export async function engineWorkflow(): Promise<string> {
  'use workflow';
  return readEngine();
}
`
  );
}

describe('VercelBuildOutputAPIBuilder traced runtime assets', () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(realpathSync(tmpdir()), 'workflow-vercel-'));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it(
    'executes a bundled step that reads Prisma-shaped runtime assets (#1956)',
    { timeout: BUILD_TIMEOUT },
    async () => {
      await writeWorkflowRuntimeStub(workingDir);
      await writeFakePrismaClient(join(workingDir, 'node_modules'));
      await writeStepUsingFakePrisma(workingDir);

      await createBuilder(workingDir).build();

      const clientOutputDir = join(
        getFlowFuncDir(workingDir),
        'node_modules/.fake-prisma/client'
      );
      expect(await readFile(join(clientOutputDir, engineFile), 'utf8')).toBe(
        engineContents
      );
      expect(
        await readFile(join(clientOutputDir, 'schema.prisma'), 'utf8')
      ).toBe(schemaContents);
      expect(
        JSON.parse(
          await readFile(join(clientOutputDir, 'package.json'), 'utf8')
        ).name
      ).toBe('.fake-prisma/client');
      // The referencing module reads join(__dirname, engineFile), and its
      // __dirname is the function root once bundled — so the engine is
      // also copied there (pdfkit/tiktoken-style lookups).
      expect(
        await readFile(join(getFlowFuncDir(workingDir), engineFile), 'utf8')
      ).toBe(engineContents);
      expect(executeStep(workingDir, 'readEngine')).toBe(
        engineContents + schemaContents
      );
    }
  );

  it(
    'copies pnpm store assets at flattened and real paths and keeps app assets',
    { timeout: BUILD_TIMEOUT },
    async () => {
      await writeWorkflowRuntimeStub(workingDir);

      // pnpm layout: real files live in the store, the app's node_modules
      // only has a symlink to the package.
      const storePackageRoot = join(
        workingDir,
        'node_modules/.pnpm/fake-prisma-client@1.0.0/node_modules'
      );
      await writeFakePrismaClient(storePackageRoot);
      const appNodeModules = join(workingDir, 'node_modules');
      // Absolute target: Windows junctions resolve relative targets against
      // process.cwd(), not the link directory.
      symlinkSync(
        join(storePackageRoot, 'fake-prisma-client'),
        join(appNodeModules, 'fake-prisma-client'),
        // Junctions don't need symlink privileges on Windows runners
        process.platform === 'win32' ? 'junction' : 'dir'
      );

      await writeStepUsingFakePrisma(workingDir);
      await write(
        join(workingDir, 'src/workflows/report.ts'),
        `import { readFileSync } from 'fs';
import { join } from 'path';

export async function readTemplate(): Promise<string> {
  'use step';
  return readFileSync(join(process.cwd(), 'data/template.txt'), 'utf8');
}

export async function reportWorkflow(): Promise<string> {
  'use workflow';
  return readTemplate();
}
`
      );
      await write(join(workingDir, 'data/template.txt'), 'template asset\n');

      await createBuilder(workingDir).build();

      const flowFuncDir = getFlowFuncDir(workingDir);
      // The engine is reachable at the flat node_modules path npm-style
      // runtime lookups probe...
      expect(
        await readFile(
          join(flowFuncDir, 'node_modules/.fake-prisma/client', engineFile),
          'utf8'
        )
      ).toBe(engineContents);
      // ...and at its real store path, which lookups with a baked
      // generate-time relative path (Prisma under pnpm) probe.
      expect(
        await readFile(
          join(
            flowFuncDir,
            'node_modules/.pnpm/fake-prisma-client@1.0.0/node_modules/.fake-prisma/client',
            engineFile
          ),
          'utf8'
        )
      ).toBe(engineContents);
      expect(
        await readFile(join(flowFuncDir, 'data/template.txt'), 'utf8')
      ).toBe('template asset\n');
    }
  );

  it(
    'executes sharp with its traced native packages (#1003)',
    { timeout: BUILD_TIMEOUT },
    async () => {
      await writeWorkflowRuntimeStub(workingDir);
      const sharpPackageDir = dirname(dirname(require.resolve('sharp')));
      symlinkSync(
        sharpPackageDir,
        join(workingDir, 'node_modules/sharp'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );
      await write(
        join(workingDir, 'src/workflows/sharp.ts'),
        `import sharp from 'sharp';

export async function resizeImage(): Promise<string> {
  'use step';
  const { data, info } = await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 4,
      background: '#ff0000',
    },
  }).png().toBuffer({ resolveWithObject: true });
  return info.width + 'x' + info.height + ':' + data.subarray(1, 4).toString();
}

export async function sharpWorkflow(): Promise<string> {
  'use workflow';
  return resizeImage();
}
`
      );

      await createBuilder(workingDir).build();
      expect(executeStep(workingDir, 'resizeImage')).toBe('2x2:PNG');
    }
  );

  it(
    'fails when workflow code reads a secret-like runtime asset',
    { timeout: BUILD_TIMEOUT },
    async () => {
      await writeWorkflowRuntimeStub(workingDir);
      await write(
        join(workingDir, 'src/workflows/secret.ts'),
        `import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export async function readSecret(): Promise<string> {
  'use step';
  return readFileSync(join(process.cwd(), '.env'), 'utf8');
}

export async function secretWorkflow(): Promise<string> {
  'use workflow';
  return readSecret();
}
`
      );
      await write(join(workingDir, '.env'), 'SECRET=do-not-deploy\n');

      await expect(createBuilder(workingDir).build()).rejects.toThrow(
        'Refusing to deploy secret-like runtime asset'
      );
    }
  );

  it(
    'fails when a runtime asset conflicts with generated function output',
    { timeout: BUILD_TIMEOUT },
    async () => {
      await writeWorkflowRuntimeStub(workingDir);
      await write(
        join(workingDir, 'src/workflows/conflict.ts'),
        `import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export async function readGeneratedOutput(): Promise<string> {
  'use step';
  return readFileSync(join(process.cwd(), 'package.json'), 'utf8');
}

export async function conflictWorkflow(): Promise<string> {
  'use workflow';
  return readGeneratedOutput();
}
`
      );
      await write(join(workingDir, 'package.json'), '{"private":true}\n');

      await expect(createBuilder(workingDir).build()).rejects.toThrow(
        'Runtime asset conflicts with generated function output'
      );
    }
  );

  it(
    'fails when different runtime assets map to the same function path',
    { timeout: BUILD_TIMEOUT },
    async () => {
      await writeWorkflowRuntimeStub(workingDir);
      for (const packageName of ['client-a', 'client-b']) {
        const packageDir = join(workingDir, 'node_modules', packageName);
        await write(
          join(packageDir, 'package.json'),
          JSON.stringify({ name: packageName, main: 'index.js' })
        );
        await write(
          join(packageDir, 'index.js'),
          `const { readFileSync } = require('node:fs');
const { join } = require('node:path');
exports.read = () => readFileSync(join(__dirname, 'node_modules/shared/data.txt'), 'utf8');
`
        );
        await write(
          join(packageDir, 'node_modules/shared/data.txt'),
          packageName
        );
      }
      await write(
        join(workingDir, 'src/workflows/collision.ts'),
        `import { read as readA } from 'client-a';
import { read as readB } from 'client-b';

export async function readBoth(): Promise<string> {
  'use step';
  return readA() + readB();
}

export async function collisionWorkflow(): Promise<string> {
  'use workflow';
  return readBoth();
}
`
      );

      await expect(createBuilder(workingDir).build()).rejects.toThrow(
        'Conflicting runtime assets'
      );
    }
  );
});
