import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
    `import { getQueryEngine } from 'fake-prisma-client';

export async function readEngine(): Promise<string> {
  'use step';
  return getQueryEngine();
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
    'copies runtime assets loaded by bundled dependencies into flow.func (#1956)',
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

      // The bundle must execute under plain Node (not vitest's module
      // runner): inlined CJS referencing __dirname at module scope (like
      // @prisma/client's runtime) relies on the ESM banner shims.
      const bundleUrl = pathToFileURL(
        join(getFlowFuncDir(workingDir), 'index.mjs')
      ).href;
      const output = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `const bundle = await import(${JSON.stringify(bundleUrl)}); console.log(typeof bundle.POST);`,
        ],
        { encoding: 'utf8' }
      );
      expect(output.trim()).toBe('function');
    }
  );

  it(
    'copies pnpm store assets at flattened and real paths, keeps app assets, never copies secrets',
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
  try {
    readFileSync(join(process.cwd(), '.env'), 'utf8');
    // An app file whose cwd-relative path collides with a generated
    // function file — it must never clobber the bundle.
    readFileSync(join(process.cwd(), 'index.mjs'), 'utf8');
  } catch {}
  return readFileSync(join(process.cwd(), 'data/template.txt'), 'utf8');
}

export async function reportWorkflow(): Promise<string> {
  'use workflow';
  return readTemplate();
}
`
      );
      await write(join(workingDir, 'data/template.txt'), 'template asset\n');
      await write(join(workingDir, '.env'), 'SECRET=do-not-copy\n');
      await write(
        join(workingDir, 'index.mjs'),
        'app sentinel — not the bundle\n'
      );

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
      // App files read at runtime keep their cwd-relative path; credential
      // files stay out of the deployed function.
      expect(
        await readFile(join(flowFuncDir, 'data/template.txt'), 'utf8')
      ).toBe('template asset\n');
      expect(existsSync(join(flowFuncDir, '.env'))).toBe(false);
      // The app's root index.mjs must not clobber the generated bundle.
      expect(await readFile(join(flowFuncDir, 'index.mjs'), 'utf8')).not.toBe(
        'app sentinel — not the bundle\n'
      );
    }
  );
});
