import {
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
import { describe, expect, it, onTestFinished } from 'vitest';
import { LocalBuilder, VercelBuilder } from './builders.js';
import nitroModule from './index.js';

type StubOptions = {
  routing: boolean;
  workspaceDir?: string;
  workflow?: { runtime?: string };
};

function createNitroStub({
  routing,
  workspaceDir = '/tmp/project',
  workflow = {},
}: StubOptions) {
  return {
    routing,
    options: {
      alias: {},
      buildDir: '/tmp/.nitro',
      dev: false,
      handlers: [],
      preset: 'node-server',
      rootDir: '/tmp/project',
      typescript: {},
      virtual: {},
      workspaceDir,
      workflow,
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
  it('routes workflow HTTP endpoints to generated Vercel functions', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'workflow-nitro-vercel-'));
    onTestFinished(async () => {
      await rm(testRoot, { recursive: true, force: true });
    });

    const configPath = join(testRoot, '.vercel/output/config.json');
    const flowRoute = {
      src: '^\\/\\.well-known\\/workflow\\/v1\\/flow$',
      dest: '/.well-known/workflow/v1/flow',
    };
    const stepRoute = {
      src: '^\\/\\.well-known\\/workflow\\/v1\\/step$',
      dest: '/.well-known/workflow/v1/step',
    };
    const webhookRoute = {
      src: '^\\/\\.well-known\\/workflow\\/v1\\/webhook\\/([^\\/]+)$',
      dest: '/.well-known/workflow/v1/webhook/[token]',
    };
    const filesystemRoute = { handle: 'filesystem' };
    const apiRoute = { src: '/api/chat', dest: '/api/chat' };
    const fallbackRoute = { src: '/(.*)', dest: '/__server' };

    await mkdir(join(testRoot, '.vercel/output'), { recursive: true });
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
        routes: [filesystemRoute, apiRoute, fallbackRoute],
      })
    );

    // A real workflow file makes VercelBuilder emit the generated flow, step,
    // and webhook functions instead of only exercising config merging.
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

    // Flow/step are prepended by Nitro so HTTP traffic reaches generated
    // workflow functions before Nitro's catch-all. Webhook already had an
    // explicit route from the shared Vercel workflow builder.
    expect(config.routes).toEqual([
      flowRoute,
      stepRoute,
      webhookRoute,
      filesystemRoute,
      apiRoute,
      fallbackRoute,
    ]);
  });
});

describe('@workflow/nitro projectRoot', () => {
  for (const [label, Builder] of [
    ['VercelBuilder', VercelBuilder],
    ['LocalBuilder', LocalBuilder],
  ] as const) {
    describe(label, () => {
      it('uses nitro workspaceDir as the workflow projectRoot', () => {
        const nitro = createNitroStub({
          routing: true,
          workspaceDir: '/tmp',
        });
        const builder = new Builder(nitro) as any;
        expect(builder.config.projectRoot).toBe('/tmp');
      });
    });
  }
});
