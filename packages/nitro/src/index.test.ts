import { fileURLToPath } from 'node:url';
import { WORKFLOW_QUEUE_TRIGGER } from '@workflow/builders';
import { createServer } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalBuilder, VercelBuilder } from './builders.js';
import nitroModule from './index.js';
import { workflow as viteWorkflow } from './vite.js';

afterEach(() => {
  vi.restoreAllMocks();
});

type StubOptions = {
  routing: boolean;
  majorVersion?: number;
  dev?: boolean;
  preset?: string;
  rootDir?: string;
  workspaceDir?: string;
  workflow?: { dirs?: string[]; runtime?: string };
  externals?: {
    external?: Array<string | RegExp | ((id: string) => boolean)>;
  };
  vercel?: Record<string, unknown>;
};

function createNitroStub({
  routing,
  majorVersion,
  dev = false,
  preset = 'node-server',
  rootDir = '/tmp/project',
  workspaceDir = '/tmp/project',
  workflow = {},
  externals,
  vercel,
}: StubOptions) {
  return {
    routing,
    meta: majorVersion != null ? { majorVersion } : undefined,
    options: {
      alias: {},
      buildDir: '/tmp/.nitro',
      dev,
      externals: externals ?? {},
      handlers: [],
      preset,
      rootDir,
      typescript: {},
      vercel: vercel ?? {},
      virtual: {},
      workspaceDir,
      workflow,
    },
    hooks: {
      hook() {},
    },
  } as any;
}

async function setupViteHarness() {
  const nitro = createNitroStub({ routing: true, dev: true });
  nitro.close = vi.fn(async () => {});
  const plugins = viteWorkflow();
  const workflowPlugin = plugins.find(
    (candidate) => candidate.name === 'workflow:nitro'
  ) as any;
  await workflowPlugin.nitro.setup(nitro);
  return { nitro, plugins, workflowPlugin };
}

describe('@workflow/nitro virtual handlers', () => {
  it('registers the combined flow + webhook virtual handlers for Nitro v2', async () => {
    const nitro = createNitroStub({ routing: false });

    await nitroModule.setup(nitro);

    const flowSource = nitro.options.virtual['#workflow/workflows.mjs'];
    expect(flowSource).toContain(
      'import "/tmp/.nitro/workflow/workflows.mjs";'
    );
    expect(flowSource).toContain(
      'import { POST } from "/tmp/.nitro/workflow/workflows.mjs";'
    );
    expect(flowSource).toContain('fromWebHandler');

    const webhookSource = nitro.options.virtual['#workflow/webhook.mjs'];
    expect(webhookSource).toContain(
      'import "/tmp/.nitro/workflow/webhook.mjs";'
    );
    expect(webhookSource).toContain('fromWebHandler');
  });

  it('registers the combined flow + webhook virtual handlers for Nitro v3', async () => {
    const nitro = createNitroStub({ routing: true });

    await nitroModule.setup(nitro);

    const flowSource = nitro.options.virtual['#workflow/workflows.mjs'];
    expect(flowSource).toContain(
      'import "/tmp/.nitro/workflow/workflows.mjs";'
    );
    expect(flowSource).toContain(
      'import { POST } from "/tmp/.nitro/workflow/workflows.mjs";'
    );
    // v3 handlers use the native web handler signature, not h3's
    // `fromWebHandler` adapter.
    expect(flowSource).not.toContain('fromWebHandler');

    const webhookSource = nitro.options.virtual['#workflow/webhook.mjs'];
    expect(webhookSource).toContain(
      'import "/tmp/.nitro/workflow/webhook.mjs";'
    );
    expect(webhookSource).not.toContain('fromWebHandler');
  });

  it('preserves the side-effect import alongside POST so step registrations are not tree-shaken', async () => {
    // Regression: in Nuxt + Nitro production builds, importing only the
    // `POST` symbol could let the bundler drop top-level step
    // registrations from the workflows.mjs bundle, so the handler loaded
    // but step IDs were missing at runtime.
    const nitro = createNitroStub({ routing: true });

    await nitroModule.setup(nitro);

    for (const buildPath of ['workflows.mjs', 'webhook.mjs']) {
      const source = nitro.options.virtual[`#workflow/${buildPath}`];
      expect(source).toContain(`import "/tmp/.nitro/workflow/${buildPath}";`);
      expect(source).toContain(
        `import { POST } from "/tmp/.nitro/workflow/${buildPath}";`
      );
    }
  });
});

describe('@workflow/nitro builder lifecycle', () => {
  it('keeps the debug alias disabled for Vite SSR integrations', async () => {
    const nitro = createNitroStub({
      routing: true,
      workflow: { _integration: { kind: 'vite-ssr' } } as any,
    });

    await nitroModule.setup(nitro);

    expect(nitro.options.alias.debug).toBeUndefined();
  });

  it('preserves unresolved host imports for the later production Vite build', async () => {
    const nitro = createNitroStub({ routing: true });
    const workflowPlugin = viteWorkflow().find(
      (candidate) => candidate.name === 'workflow:nitro'
    ) as any;

    await workflowPlugin.nitro.setup(nitro);

    await expect(
      nitro.options.workflow._integration.hostResolver.resolve(
        'virtual:env/server'
      )
    ).resolves.toEqual({ id: 'virtual:env/server', external: true });
  });

  it('closes a development Nitro instance with its Vite plugin container', async () => {
    const { nitro, workflowPlugin } = await setupViteHarness();

    await workflowPlugin.buildEnd?.();

    expect(nitro.close).toHaveBeenCalledOnce();
  });

  it('disposes temporary build contexts after each build', async () => {
    const dispose = vi.fn(async () => {});
    const builder = new LocalBuilder(
      createNitroStub({ routing: true, dev: true })
    );
    Object.assign(builder, {
      getInputFiles: async () => [],
      createCombinedBundle: async () => ({
        manifest: {},
        stepsContext: { dispose },
        interimBundleCtx: { dispose },
      }),
      createWebhookBundle: async () => {},
      createManifest: async () => {},
    });

    await builder.build();

    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it('runs the initial workflow build after host plugins finish buildStart', async () => {
    const events: string[] = [];
    const build = vi
      .spyOn(LocalBuilder.prototype, 'build')
      .mockImplementation(async () => {
        events.push('workflow build');
      });
    const { nitro, plugins } = await setupViteHarness();

    const server = await createServer({
      configFile: false,
      logLevel: 'silent',
      root: nitro.options.rootDir,
      server: { middlewareMode: true },
      plugins: [
        ...plugins,
        {
          name: 'stateful-host-plugin',
          buildStart: {
            order: 'post',
            async handler() {
              await new Promise<void>((resolve) => setTimeout(resolve, 0));
              events.push('host buildStart');
            },
          },
        },
      ],
    });

    expect(events).toEqual(['host buildStart', 'workflow build']);
    expect(build).toHaveBeenCalledOnce();
    await server.close();
  });

  it('fails Vite startup when the initial workflow build fails', async () => {
    vi.spyOn(LocalBuilder.prototype, 'build').mockRejectedValue(
      new Error('initial workflow build failed')
    );
    const { nitro, plugins } = await setupViteHarness();

    await expect(
      createServer({
        configFile: false,
        logLevel: 'silent',
        root: nitro.options.rootDir,
        server: { middlewareMode: true },
        plugins,
      })
    ).rejects.toThrow('initial workflow build failed');
  });

  it('registers its 404 middleware synchronously in the post hook', async () => {
    vi.spyOn(LocalBuilder.prototype, 'build').mockResolvedValue();
    const { workflowPlugin } = await setupViteHarness();
    const use = vi.fn();

    const postHook = workflowPlugin.configureServer({
      environments: {
        ssr: { pluginContainer: {} },
      },
      middlewares: { use },
    });
    postHook?.();

    expect(use).toHaveBeenCalledOnce();
  });

  it('returns initialized and transformed modules from Vite', async () => {
    vi.spyOn(LocalBuilder.prototype, 'build').mockResolvedValue();
    const { nitro, plugins } = await setupViteHarness();
    let value = 'before-build-start';
    const physicalModule = fileURLToPath(import.meta.url);
    const watchedDependency = fileURLToPath(
      new URL('./builders.ts', import.meta.url)
    );

    const server = await createServer({
      configFile: false,
      logLevel: 'silent',
      root: nitro.options.rootDir,
      server: { middlewareMode: true },
      plugins: [
        {
          name: 'stateful-host-module',
          async buildStart() {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            value = 'after-build-start';
          },
          resolveId(id: string) {
            if (id === 'virtual:stateful') return '\0virtual:stateful';
          },
          load(id: string) {
            if (id === '\0virtual:stateful') {
              return `export const value = '${value}';`;
            }
          },
          transform(code: string, id: string) {
            if (id === '\0virtual:stateful') {
              this.addWatchFile(watchedDependency);
              return code.replace('after-build-start', 'transformed');
            }
            if (id === physicalModule) {
              return `${code}\nexport const hostUpdateValue = '${value}';`;
            }
          },
        },
        ...plugins,
      ],
    });

    const hostResolver = nitro.options.workflow._integration.hostResolver;
    const resolve = hostResolver.resolve;
    hostResolver.beginBuild();
    await expect(resolve('virtual:stateful')).resolves.toMatchObject({
      id: '\0virtual:stateful',
      external: false,
      code: expect.stringContaining('transformed'),
    });
    hostResolver.endBuild(true);
    expect(hostResolver.isDependency(watchedDependency)).toBe(true);
    await expect(resolve('node:path', '\0virtual:stateful')).resolves.toEqual({
      id: 'node:path',
      external: true,
    });
    expect(hostResolver.beginBuild).toEqual(expect.any(Function));
    expect(hostResolver.endBuild).toEqual(expect.any(Function));
    expect(hostResolver.invalidate).toEqual(expect.any(Function));
    hostResolver.beginBuild();
    await expect(
      resolve(physicalModule, '\0virtual:stateful')
    ).resolves.toMatchObject({
      external: false,
      code: expect.stringContaining('after-build-start'),
    });
    hostResolver.endBuild(true);
    expect(hostResolver.isDependency(physicalModule)).toBe(true);

    value = 'after-update';
    hostResolver.invalidate(physicalModule, 2);
    await expect(
      resolve(physicalModule, '\0virtual:stateful')
    ).resolves.toMatchObject({
      code: expect.stringContaining('after-update'),
    });

    hostResolver.beginBuild();
    await resolve(watchedDependency, '\0virtual:stateful');
    hostResolver.endBuild(false);
    expect(hostResolver.isDependency(physicalModule)).toBe(true);
    expect(hostResolver.isDependency(watchedDependency)).toBe(true);

    hostResolver.beginBuild();
    await resolve('virtual:stateful');
    hostResolver.endBuild(true);
    expect(hostResolver.isDependency(physicalModule)).toBe(false);
    await server.close();
  });

  it('uses SSR resolution and transforms with legacy Vite containers', async () => {
    vi.spyOn(LocalBuilder.prototype, 'build').mockResolvedValue();
    const { nitro, workflowPlugin } = await setupViteHarness();
    const resolveId = vi.fn(async () => ({ id: '\0virtual:legacy' }));
    const load = vi.fn(async () => `export const value = 'loaded';`);
    const transform = vi.fn(async (code: string) => ({
      code: code.replace('loaded', 'transformed'),
    }));
    const postHook = workflowPlugin.configureServer({
      middlewares: { use: vi.fn() },
      moduleGraph: { ensureEntryFromUrl: vi.fn(async () => {}) },
      pluginContainer: { resolveId, load, transform },
    });
    postHook?.();

    await expect(
      nitro.options.workflow._integration.hostResolver.resolve('virtual:legacy')
    ).resolves.toEqual({
      id: '\0virtual:legacy',
      external: false,
      code: `export const value = 'transformed';`,
    });
    expect(resolveId).toHaveBeenCalledWith('virtual:legacy', undefined, {
      ssr: true,
    });
    expect(load).toHaveBeenCalledWith('\0virtual:legacy', { ssr: true });
    expect(transform).toHaveBeenCalledWith(
      `export const value = 'loaded';`,
      '\0virtual:legacy',
      { ssr: true }
    );
  });
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

describe('@workflow/nitro Vercel functionRules', () => {
  it('does not configure functionRules outside of Vercel deploys', async () => {
    const nitro = createNitroStub({ routing: true });

    await nitroModule.setup(nitro);

    expect(nitro.options.vercel?.functionRules ?? {}).toEqual({});
  });

  it('does not configure functionRules in dev mode, even when preset is vercel', async () => {
    const nitro = createNitroStub({
      routing: true,
      dev: true,
      preset: 'vercel',
    });

    await nitroModule.setup(nitro);

    expect(nitro.options.vercel?.functionRules ?? {}).toEqual({});
  });

  it('configures the flow function with queue triggers and max duration on Nitro v3 Vercel deploys', async () => {
    const nitro = createNitroStub({
      routing: true,
      preset: 'vercel',
    });

    await nitroModule.setup(nitro);

    const flowRule =
      nitro.options.vercel.functionRules['/.well-known/workflow/v1/flow'];
    expect(flowRule.maxDuration).toBe('max');
    expect(flowRule.experimentalTriggers).toEqual([WORKFLOW_QUEUE_TRIGGER]);
  });

  it('uses the handler route pattern (`:token`, not `**`) for the webhook functionRule', async () => {
    // Regression: keys in `functionRules` must match the route patterns
    // the handlers are registered with, otherwise nitro's vercel preset
    // creates a second `.func` directory next to the real one and shadows
    // the original route in `config.json`.
    const nitro = createNitroStub({
      routing: true,
      preset: 'vercel',
      workflow: { runtime: 'nodejs22.x' },
    });

    await nitroModule.setup(nitro);

    const rules = nitro.options.vercel.functionRules;
    expect(rules).toHaveProperty('/.well-known/workflow/v1/webhook/:token');
    expect(rules).not.toHaveProperty('/.well-known/workflow/v1/webhook/**');

    const handlerRoutes = nitro.options.handlers.map(
      (h: { route: string }) => h.route
    );
    for (const ruleKey of Object.keys(rules)) {
      // Manifest route is only registered when WORKFLOW_PUBLIC_MANIFEST=1,
      // so skip it — it's exercised in a separate test.
      if (ruleKey.endsWith('manifest.json')) continue;
      expect(handlerRoutes).toContain(ruleKey);
    }
  });

  it('propagates workflow.runtime to flow + webhook (and manifest when public) on Nitro v3 Vercel', async () => {
    const previous = process.env.WORKFLOW_PUBLIC_MANIFEST;
    process.env.WORKFLOW_PUBLIC_MANIFEST = '1';
    try {
      const nitro = createNitroStub({
        routing: true,
        preset: 'vercel',
        workflow: { runtime: 'nodejs22.x' },
      });

      await nitroModule.setup(nitro);

      const rules = nitro.options.vercel.functionRules;
      expect(rules['/.well-known/workflow/v1/flow'].runtime).toBe('nodejs22.x');
      expect(rules['/.well-known/workflow/v1/webhook/:token'].runtime).toBe(
        'nodejs22.x'
      );
      expect(rules['/.well-known/workflow/v1/manifest.json'].runtime).toBe(
        'nodejs22.x'
      );
    } finally {
      if (previous === undefined) delete process.env.WORKFLOW_PUBLIC_MANIFEST;
      else process.env.WORKFLOW_PUBLIC_MANIFEST = previous;
    }
  });

  it('omits the webhook + manifest functionRule entries when workflow.runtime is unset', async () => {
    // Without a runtime override there is nothing to attach to these
    // routes, so we shouldn't pollute functionRules — the catch-all
    // base function will serve them.
    const nitro = createNitroStub({
      routing: true,
      preset: 'vercel',
    });

    await nitroModule.setup(nitro);

    const rules = nitro.options.vercel.functionRules;
    expect(rules).not.toHaveProperty('/.well-known/workflow/v1/webhook/:token');
    expect(rules).not.toHaveProperty('/.well-known/workflow/v1/manifest.json');
  });

  it('lets workflow values win over user-provided values on touched fields, but preserves untouched fields like memory', async () => {
    const nitro = createNitroStub({
      routing: true,
      preset: 'vercel',
      vercel: {
        functionRules: {
          '/.well-known/workflow/v1/flow': {
            memory: 3008,
            maxDuration: 10,
            experimentalTriggers: [],
          },
        },
      },
    });

    await nitroModule.setup(nitro);

    const flowRule =
      nitro.options.vercel.functionRules['/.well-known/workflow/v1/flow'];
    // Untouched user field is preserved
    expect(flowRule.memory).toBe(3008);
    // Workflow-required fields win
    expect(flowRule.maxDuration).toBe('max');
    expect(flowRule.experimentalTriggers).toEqual([WORKFLOW_QUEUE_TRIGGER]);
  });

  it('routes Nitro v2 Vercel deploys through the legacy build-output builder, not functionRules', async () => {
    // On Nuxt 4.x (nitropack v2) we still ship via `.vercel/output/config.json`
    // routes, so we must NOT touch functionRules — and we must register a
    // `compiled` hook that runs the VercelBuilder.
    const compiledHooks: Array<() => void> = [];
    const nitro = createNitroStub({
      routing: false,
      majorVersion: 2,
      preset: 'vercel',
    });
    nitro.hooks.hook = (name: string, fn: () => void) => {
      if (name === 'compiled') compiledHooks.push(fn);
    };

    await nitroModule.setup(nitro);

    expect(nitro.options.vercel?.functionRules ?? {}).toEqual({});
    expect(compiledHooks.length).toBe(1);
  });
});

describe('@workflow/nitro isNitroV2 detection', () => {
  // `isNitroV2` isn't exported, but its behavior is observable through
  // whether the v2 legacy path runs. These cases lock the cross-product
  // of (meta.majorVersion, nitro.routing) so a refactor of the helper
  // can't silently reroute Nuxt-on-nitropack-v2 setups through the
  // v3 functionRules path.
  it.each([
    { majorVersion: 2, routing: false, expectLegacy: true },
    { majorVersion: 3, routing: true, expectLegacy: false },
    // Older Nuxt + nitropack v2 setups that pre-date `meta.majorVersion`
    // fall back to "no routing" => v2.
    { majorVersion: undefined, routing: false, expectLegacy: true },
    // Forward-compat: a v3+ release without `meta.majorVersion` but with
    // `routing` should still be treated as v3.
    { majorVersion: undefined, routing: true, expectLegacy: false },
  ])('majorVersion=$majorVersion routing=$routing → legacy=$expectLegacy', async ({
    majorVersion,
    routing,
    expectLegacy,
  }) => {
    const compiledHooks: Array<() => void> = [];
    const nitro = createNitroStub({
      routing,
      majorVersion,
      preset: 'vercel',
    });
    nitro.hooks.hook = (name: string, fn: () => void) => {
      if (name === 'compiled') compiledHooks.push(fn);
    };

    await nitroModule.setup(nitro);

    if (expectLegacy) {
      // legacy path: VercelBuilder runs on `compiled`, functionRules untouched
      expect(compiledHooks.length).toBe(1);
      expect(nitro.options.vercel?.functionRules ?? {}).toEqual({});
    } else {
      // v3 path: functionRules wired up, no `compiled` hook
      expect(compiledHooks.length).toBe(0);
      expect(
        nitro.options.vercel.functionRules['/.well-known/workflow/v1/flow']
      ).toBeDefined();
    }
  });
});

describe('@workflow/nitro externals forwarding', () => {
  for (const [label, Builder] of [
    ['VercelBuilder', VercelBuilder],
    ['LocalBuilder', LocalBuilder],
  ] as const) {
    describe(label, () => {
      it('leaves externalPackages undefined when nitro externals are empty', () => {
        const nitro = createNitroStub({ routing: true });
        const builder = new Builder(nitro) as any;
        expect(builder.config.externalPackages).toBeUndefined();
      });

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

      it('forwards string entries from nitro.options.externals.external', () => {
        const nitro = createNitroStub({
          routing: true,
          externals: { external: ['fsevents', 'pg'] },
        });
        const builder = new Builder(nitro) as any;
        expect(builder.config.externalPackages).toEqual(['fsevents', 'pg']);
      });

      it('skips RegExp and function entries', () => {
        const nitro = createNitroStub({
          routing: true,
          externals: {
            external: [/pkg/, () => true, 'fsevents'],
          },
        });
        const builder = new Builder(nitro) as any;
        expect(builder.config.externalPackages).toEqual(['fsevents']);
      });

      it('leaves externalPackages undefined when all entries are non-strings', () => {
        const nitro = createNitroStub({
          routing: true,
          externals: { external: [/pkg/, () => true] },
        });
        const builder = new Builder(nitro) as any;
        expect(builder.config.externalPackages).toBeUndefined();
      });
    });
  }
});
