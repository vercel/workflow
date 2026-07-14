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
import { stopEsbuildService } from '@workflow/builders';
import type { Nitro } from 'nitro/types';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { LocalBuilder, VercelBuilder } from './builders.js';
import nitroModule from './index.js';
import { workflow as viteWorkflow } from './vite.js';

vi.mock('@workflow/builders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@workflow/builders')>()),
  stopEsbuildService: vi.fn(),
}));

type StubOptions = {
  routing: boolean;
  dev?: boolean;
  workspaceDir?: string;
  workflow?: { dirs?: string[]; runtime?: string };
};

function createNitroStub({
  routing,
  dev = false,
  workspaceDir = '/tmp/project',
  workflow = {},
}: StubOptions) {
  return {
    routing,
    options: {
      alias: {},
      buildDir: '/tmp/.nitro',
      dev,
      handlers: [],
      preset: 'node-server',
      rootDir: '/tmp/project',
      typescript: {},
      virtual: {},
      workspaceDir,
      workflow,
    },
    hooks: {
      hook: vi.fn(),
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

describe('@workflow/nitro builder lifecycle', () => {
  beforeEach(() => {
    vi.mocked(stopEsbuildService).mockClear();
  });

  it('closes a development Nitro instance with its Vite plugin container', async () => {
    const nitro = createNitroStub({ routing: true, dev: true }) as any;
    nitro.close = vi.fn(async () => {});
    const plugin = viteWorkflow().find(
      (candidate) => candidate.name === 'workflow:nitro'
    ) as any;

    await plugin.nitro.setup(nitro);
    await plugin.buildEnd?.();

    expect(nitro.close).toHaveBeenCalledOnce();
    expect(stopEsbuildService).not.toHaveBeenCalled();
  });

  it('releases the esbuild service after Nitro finishes compiling', async () => {
    const nitro = createNitroStub({ routing: true });
    const plugin = viteWorkflow().find(
      (candidate) => candidate.name === 'workflow:nitro'
    ) as any;

    await plugin.nitro.setup(nitro);
    expect(stopEsbuildService).not.toHaveBeenCalled();
    const compiledHook = (nitro.hooks.hook as any).mock.calls.find(
      ([name]: [string]) => name === 'compiled'
    )?.[1];
    await compiledHook();

    expect(stopEsbuildService).toHaveBeenCalledOnce();
  });

  it('disposes temporary build contexts after each build', async () => {
    const dispose = vi.fn(async () => {});
    const builder = new LocalBuilder(
      createNitroStub({ routing: true, dev: true })
    );
    Object.assign(builder, {
      getInputFiles: async () => [],
      createWorkflowsBundle: async () => ({
        manifest: { steps: {}, workflows: {}, classes: {} },
        interimBundleCtx: { dispose },
      }),
      createStepsBundle: async () => ({
        manifest: { steps: {}, workflows: {}, classes: {} },
        context: { dispose },
      }),
      createWebhookBundle: async () => {},
      createManifest: async () => {},
    });

    await builder.build();

    expect(dispose).toHaveBeenCalledTimes(2);
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

      it('forwards workflow.dirs to the workflow builder', () => {
        const nitro = createNitroStub({
          routing: true,
          workflow: { dirs: ['server/workflows', 'layers/custom/workflows'] },
        });
        const builder = new Builder(nitro) as any;
        expect(builder.config.dirs).toEqual([
          'server/workflows',
          'layers/custom/workflows',
        ]);
      });
    });
  }
});

describe('@workflow/nitro transform boundaries', () => {
  it('does not re-transform generated Nitro build artifacts', async () => {
    const rollupBeforeHooks: Array<(nitro: any, config: any) => void> = [];
    const nitro = createNitroStub({ routing: true });
    nitro.hooks.hook = (
      name: string,
      hook: (nitro: any, config: any) => void
    ) => {
      if (name === 'rollup:before') rollupBeforeHooks.push(hook);
    };

    const plugins = viteWorkflow();
    const viteTransform = plugins.find(
      (plugin) => plugin.name === 'workflow:transform'
    ) as any;
    const viteNitro = plugins.find(
      (plugin) => plugin.name === 'workflow:nitro'
    ) as any;

    await viteNitro.nitro.setup(nitro);

    const config: { plugins: any[] } = { plugins: [] };
    for (const hook of rollupBeforeHooks) {
      hook(nitro, config);
    }
    const nitroTransform = config.plugins.find(
      (plugin: { name?: string }) => plugin.name === 'workflow:transform'
    );

    const code = `
      import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';
      export class Serializable {
        static [WORKFLOW_SERIALIZE](value) { return value; }
        static [WORKFLOW_DESERIALIZE]() { return new Serializable(); }
      }
    `;
    const generatedId = '/tmp/.nitro/vite/services/ssr/assets/index.js';
    const siblingId = '/tmp/.nitro-source/index.js';

    for (const transform of [viteTransform, nitroTransform]) {
      await expect(
        transform.transform.call({}, code, generatedId)
      ).resolves.toBeNull();
      await expect(
        transform.transform.call({}, code, siblingId)
      ).resolves.not.toBeNull();
    }
  });
});
