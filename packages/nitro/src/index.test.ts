import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKFLOW_QUEUE_TRIGGER } from '@workflow/builders';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalBuilder, VercelBuilder } from './builders.js';
import nitroModule from './index.js';

type StubOptions = {
  routing: boolean;
  majorVersion?: number;
  dev?: boolean;
  preset?: string;
  workspaceDir?: string;
  baseURL?: string;
  workflow?: { runtime?: string };
  buildDir?: string;
  rootDir?: string;
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
  workspaceDir = '/tmp/project',
  buildDir = '/tmp/.nitro',
  rootDir = '/tmp/project',
  baseURL,
  workflow = {},
  externals,
  vercel,
}: StubOptions) {
  return {
    routing,
    meta: majorVersion != null ? { majorVersion } : undefined,
    options: {
      alias: {},
      buildDir,
      ...(baseURL !== undefined && { baseURL }),
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

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('@workflow/nitro virtual handlers', () => {
  it('registers the runtime base path plugin only when a baseURL is set', async () => {
    const nitro = createNitroStub({
      routing: true,
      baseURL: '/app/',
    });

    await nitroModule.setup(nitro);

    expect(nitro.options.plugins[0]).toBe('#workflow/base-path');
    expect(nitro.options.virtual['#workflow/base-path']).toContain(
      'globalThis[Symbol.for(\'@workflow/core/basePath\')] = "/app"'
    );
    // Queue triggers only invoke root-relative paths on Vercel deploys —
    // no request rewrite outside them.
    expect(nitro.options.virtual['#workflow/base-path']).not.toContain(
      "hooks.hook('request'"
    );

    const bare = createNitroStub({ routing: true });
    await nitroModule.setup(bare);
    expect(bare.options.plugins ?? []).not.toContain('#workflow/base-path');
  });

  it('rewrites root-relative flow requests to the base path on Vercel deploys (queue trigger invocations)', async () => {
    const nitro = createNitroStub({
      routing: true,
      preset: 'vercel',
      baseURL: '/app/',
    });

    await nitroModule.setup(nitro);

    const plugin = nitro.options.virtual['#workflow/base-path'];
    expect(plugin).toContain("hooks.hook('request'");
    // Only queue deliveries (CloudEvents/queue headers) are rewritten —
    // plain HTTP requests keep Nitro's native root-URL redirect behavior.
    expect(plugin).toContain("'ce-type'");
    expect(plugin).toContain("'vqs-message-id'");
    expect(plugin).toContain('"/app/.well-known/workflow/v1/flow"');
  });

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

  it('keeps handler routes and functionRules internal (unprefixed) when baseURL is set — Nitro applies baseURL when serving', async () => {
    const nitro = createNitroStub({
      routing: true,
      preset: 'vercel',
      baseURL: '/app/',
      workflow: { runtime: 'nodejs22.x' },
    });

    await nitroModule.setup(nitro);

    const routes = nitro.options.handlers.map(
      (handler: { route: string }) => handler.route
    );
    expect(routes).toContain('/.well-known/workflow/v1/flow');
    expect(routes).not.toContain('/app/.well-known/workflow/v1/flow');

    const rules = nitro.options.vercel.functionRules;
    expect(rules).toHaveProperty('/.well-known/workflow/v1/flow');
    expect(rules).toHaveProperty('/.well-known/workflow/v1/webhook/:token');
    expect(rules).not.toHaveProperty('/app/.well-known/workflow/v1/flow');
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
    vi.stubEnv('WORKFLOW_PUBLIC_MANIFEST', '1');
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

describe('@workflow/nitro Vercel output patching with baseURL', () => {
  it('repoints base-prefixed flow/webhook routes at the catch-all server function', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workflow-nitro-'));
    try {
      const rootDir = join(dir, 'app');
      await mkdir(join(rootDir, '.vercel/output'), { recursive: true });
      await writeFile(
        join(rootDir, '.vercel/output/config.json'),
        JSON.stringify({
          version: 3,
          routes: [
            { handle: 'filesystem' },
            {
              src: '/app/.well-known/workflow/v1/flow',
              dest: '/.well-known/workflow/v1/flow',
            },
            {
              src: '/app/.well-known/workflow/v1/webhook/(?<token>[^/]+)',
              dest: '/.well-known/workflow/v1/webhook/[token]',
            },
            {
              src: '/app/.well-known/workflow/v1/manifest.json',
              dest: '/.well-known/workflow/v1/manifest.json',
            },
            { src: '/(.*)', dest: '/__server' },
          ],
        })
      );

      const compiledHooks: Array<() => void> = [];
      const nitro = createNitroStub({
        routing: true,
        preset: 'vercel',
        baseURL: '/app/',
        rootDir,
      });
      nitro.hooks.hook = (name: string, fn: () => void) => {
        if (name === 'compiled') compiledHooks.push(fn);
      };

      await nitroModule.setup(nitro);
      for (const hook of compiledHooks) hook();

      const config = JSON.parse(
        await readFile(join(rootDir, '.vercel/output/config.json'), 'utf-8')
      );
      expect(config.routes[0]).toMatchObject({ handle: 'filesystem' });
      // Flow + webhook repointed at the catch-all server function; the
      // manifest route resolves natively and stays untouched.
      expect(config.routes[1]).toMatchObject({
        src: '/app/.well-known/workflow/v1/flow',
        dest: '/__server',
      });
      expect(config.routes[2]).toMatchObject({
        src: '/app/.well-known/workflow/v1/webhook/(?<token>[^/]+)',
        dest: '/__server',
      });
      expect(config.routes[3]).toMatchObject({
        src: '/app/.well-known/workflow/v1/manifest.json',
        dest: '/.well-known/workflow/v1/manifest.json',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
      // (the Vercel output patch hook is only added with a baseURL)
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

      it('forwards Nitro baseURL as the workflow basePath', () => {
        const nitro = createNitroStub({
          routing: true,
          baseURL: '/app/',
        });
        const builder = new Builder(nitro) as any;
        expect(builder.config.basePath).toBe('/app');
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
