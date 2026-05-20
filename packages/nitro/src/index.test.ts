import { WORKFLOW_QUEUE_TRIGGER } from '@workflow/builders';
import { describe, expect, it } from 'vitest';
import { LocalBuilder, VercelBuilder } from './builders.js';
import nitroModule from './index.js';

type StubOptions = {
  routing: boolean;
  majorVersion?: number;
  dev?: boolean;
  preset?: string;
  workflow?: { runtime?: string };
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
      rootDir: '/tmp/project',
      typescript: {},
      vercel: vercel ?? {},
      virtual: {},
      workflow,
    },
    hooks: {
      hook() {},
    },
  } as any;
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
