import { describe, expect, it } from 'vitest';
import { LocalBuilder, VercelBuilder } from './builders.js';
import nitroModule from './index.js';

function createNitroStub({
  routing,
  externals,
}: {
  routing: boolean;
  externals?: {
    external?: Array<string | RegExp | ((id: string) => boolean)>;
  };
}) {
  return {
    routing,
    options: {
      alias: {},
      buildDir: '/tmp/.nitro',
      dev: false,
      externals: externals ?? {},
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
  } as any;
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
