import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Nitro } from 'nitro/types';
import { afterEach, describe, expect, it } from 'vitest';
import { VercelBuilder } from './builders.js';
import nitroModule from './index.js';

let testRoot: string | undefined;

afterEach(async () => {
  if (testRoot) {
    await rm(testRoot, { recursive: true, force: true });
    testRoot = undefined;
  }
});

function createNitroStub({ routing }: { routing: boolean }): Nitro {
  return {
    routing,
    options: {
      alias: {},
      buildDir: '/tmp/.nitro',
      dev: false,
      externals: {},
      handlers: [],
      preset: 'node-server',
      rootDir: '/tmp/project',
      typescript: {},
      virtual: {},
      workflow: {},
    },
    hooks: {
      hook() {},
    },
  } as unknown as Nitro;
}

describe('@workflow/nitro virtual handlers', () => {
  it('preserves side effects from generated step modules in Nitro v2 handlers', async () => {
    const nitro = createNitroStub({ routing: false });

    await nitroModule.setup(nitro);

    const source = nitro.options.virtual['#workflow/steps.mjs'];
    expect(source).toContain('import "/tmp/.nitro/workflow/steps.mjs";');
    expect(source).toContain(
      'import { POST } from "/tmp/.nitro/workflow/steps.mjs";'
    );
  });

  it('preserves side effects from generated step modules in Nitro v3 handlers', async () => {
    const nitro = createNitroStub({ routing: true });

    await nitroModule.setup(nitro);

    const source = nitro.options.virtual['#workflow/steps.mjs'];
    expect(source).toContain('import "/tmp/.nitro/workflow/steps.mjs";');
    expect(source).toContain(
      'import { POST } from "/tmp/.nitro/workflow/steps.mjs";'
    );
  });
});

describe('@workflow/nitro Vercel Build Output API', () => {
  it('routes workflow HTTP endpoints through Nitro and keeps queue functions trigger-only', async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'workflow-nitro-vercel-'));
    const outputDir = join(testRoot, '.vercel/output');
    const functionsDir = join(outputDir, 'functions');
    const serverDest = '/__fallback';
    const serverFuncDir = join(functionsDir, '__fallback.func');
    const workflowRoutesDir = join(functionsDir, '.well-known/workflow/v1');
    const configPath = join(outputDir, 'config.json');
    const flowRoute = {
      src: '^\\/\\.well-known\\/workflow\\/v1\\/flow$',
      dest: serverDest,
    };
    const stepRoute = {
      src: '^\\/\\.well-known\\/workflow\\/v1\\/step$',
      dest: serverDest,
    };
    const webhookRoute = {
      src: '^\\/\\.well-known\\/workflow\\/v1\\/webhook\\/([^\\/]+)$',
      dest: serverDest,
    };
    const nitroRoutes = [
      {
        src: '^\\/\\.well-known\\/workflow\\/v1\\/flow$',
        dest: '/.well-known/workflow/v1/flow',
      },
      {
        src: '^\\/\\.well-known\\/workflow\\/v1\\/step$',
        dest: '/.well-known/workflow/v1/step',
      },
      {
        src: '^\\/\\.well-known\\/workflow\\/v1\\/webhook\\/([^\\/]+)$',
        dest: '/.well-known/workflow/v1/webhook/[token]',
      },
      {
        src: '/assets/(.*)',
        headers: { 'cache-control': 'public, max-age=31536000' },
        continue: true,
      },
      { handle: 'filesystem' },
    ];

    await mkdir(outputDir, { recursive: true });
    await mkdir(serverFuncDir, { recursive: true });
    await mkdir(workflowRoutesDir, { recursive: true });
    await mkdir(join(testRoot, 'node_modules'), { recursive: true });
    await symlink(
      fileURLToPath(new URL('../../workflow', import.meta.url)),
      join(testRoot, 'node_modules/workflow'),
      'junction'
    );
    await writeFile(
      configPath,
      JSON.stringify({
        version: 3,
        routes: nitroRoutes,
      })
    );
    await writeFile(
      join(serverFuncDir, '.vc-config.json'),
      JSON.stringify({
        handler: 'index.mjs',
        launcherType: 'Nodejs',
        shouldAddHelpers: false,
      })
    );
    await writeFile(join(serverFuncDir, 'index.mjs'), 'export default {};');
    await symlink(
      './../../../__fallback.func',
      join(workflowRoutesDir, 'step.func'),
      'junction'
    );
    await writeFile(
      join(testRoot, 'workflow.ts'),
      `export async function exampleWorkflow() {
  'use workflow';
  return exampleStep();
}

async function exampleStep() {
  'use step';
  return 'done';
}
`
    );

    const nitro = {
      options: {
        rootDir: testRoot,
        workflow: {},
      },
    } as unknown as Nitro;

    await new VercelBuilder(nitro).build();

    const config = JSON.parse(await readFile(configPath, 'utf-8'));
    const serverConfig = JSON.parse(
      await readFile(join(serverFuncDir, '.vc-config.json'), 'utf-8')
    );
    const stepConfig = JSON.parse(
      await readFile(
        join(workflowRoutesDir, 'step.func/.vc-config.json'),
        'utf-8'
      )
    );
    const stepFuncStats = await lstat(join(workflowRoutesDir, 'step.func'));

    expect(serverConfig.handler).toBe('index.mjs');
    expect(stepFuncStats.isSymbolicLink()).toBe(false);
    expect(stepConfig.experimentalTriggers).toEqual([
      expect.objectContaining({
        topic: '__wkf_step_*',
        type: 'queue/v2beta',
      }),
    ]);
    expect(config.routes).toEqual([
      flowRoute,
      stepRoute,
      webhookRoute,
      {
        src: '/assets/(.*)',
        headers: { 'cache-control': 'public, max-age=31536000' },
        continue: true,
      },
      { handle: 'filesystem' },
    ]);
  });
});
