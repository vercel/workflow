import { describe, expect, it } from 'vitest';
import { hasWorkflowPlugin, mergeSwcrc, serializeSwcrc } from './swcrc.js';

const PLUGIN = '/abs/path/@workflow/swc-plugin/swc_plugin_workflow.wasm';

function pluginsOf(config: Record<string, unknown>): unknown[] {
  const jsc = config.jsc as Record<string, unknown>;
  const experimental = jsc.experimental as Record<string, unknown>;
  return experimental.plugins as unknown[];
}

describe('mergeSwcrc', () => {
  it('produces a working config from nothing', () => {
    const { config, merged } = mergeSwcrc(undefined, PLUGIN, 'es6');
    expect(merged).toBe(false);
    expect(pluginsOf(config)).toEqual([[PLUGIN, { mode: 'step' }]]);
    expect(config.module).toEqual({ type: 'es6' });
    expect((config.jsc as Record<string, unknown>).transform).toEqual({
      legacyDecorator: true,
      decoratorMetadata: true,
    });
  });

  it('preserves unrelated settings the app configured', () => {
    // `init --force` runs on every build, so it must not be a config wipe.
    const existing = JSON.stringify({
      jsc: {
        target: 'es2021',
        parser: { syntax: 'typescript', tsx: true },
        baseUrl: './src',
        paths: { '@app/*': ['app/*'] },
      },
      minify: { compress: true },
      sourceMaps: false,
    });
    const { config, merged } = mergeSwcrc(existing, PLUGIN, 'commonjs');
    const jsc = config.jsc as Record<string, unknown>;
    expect(merged).toBe(true);
    expect(jsc.target).toBe('es2021');
    expect(jsc.baseUrl).toBe('./src');
    expect(jsc.paths).toEqual({ '@app/*': ['app/*'] });
    expect(config.minify).toEqual({ compress: true });
    expect(config.sourceMaps).toBe(false);
    expect((jsc.parser as Record<string, unknown>).tsx).toBe(true);
  });

  it('keeps other SWC plugins and replaces only the workflow entry', () => {
    const existing = JSON.stringify({
      jsc: {
        experimental: {
          plugins: [
            ['@some/other-plugin', { a: 1 }],
            ['/stale/machine/path/swc_plugin_workflow.wasm', { mode: 'step' }],
          ],
        },
      },
    });
    const { config } = mergeSwcrc(existing, PLUGIN, 'es6');
    expect(pluginsOf(config)).toEqual([
      ['@some/other-plugin', { a: 1 }],
      [PLUGIN, { mode: 'step' }],
    ]);
  });

  it('forces on the decorator options NestJS DI depends on', () => {
    // Without decorators + decoratorMetadata there is no design:paramtypes and
    // constructor injection silently stops working.
    const existing = JSON.stringify({
      jsc: {
        parser: { syntax: 'typescript', decorators: false },
        transform: { legacyDecorator: false, decoratorMetadata: false },
      },
    });
    const { config } = mergeSwcrc(existing, PLUGIN, 'es6');
    const jsc = config.jsc as Record<string, unknown>;
    expect((jsc.parser as Record<string, unknown>).decorators).toBe(true);
    expect(jsc.transform).toEqual({
      legacyDecorator: true,
      decoratorMetadata: true,
    });
  });

  it('overrides module.type while keeping sibling module settings', () => {
    const existing = JSON.stringify({
      module: { type: 'es6', strict: true, noInterop: true },
    });
    const { config } = mergeSwcrc(existing, PLUGIN, 'commonjs');
    expect(config.module).toEqual({
      type: 'commonjs',
      strict: true,
      noInterop: true,
    });
  });

  it('falls back to a fresh config when the existing file is not valid json', () => {
    const { config, merged } = mergeSwcrc('{ not json', PLUGIN, 'es6');
    expect(merged).toBe(false);
    expect(pluginsOf(config)).toEqual([[PLUGIN, { mode: 'step' }]]);
  });

  it('round-trips through serializeSwcrc', () => {
    const { config } = mergeSwcrc(undefined, PLUGIN, 'es6');
    const text = serializeSwcrc(config);
    expect(text.endsWith('\n')).toBe(true);
    expect(hasWorkflowPlugin(text)).toBe(true);
    // Re-merging its own output must be a no-op on the plugin list.
    expect(pluginsOf(mergeSwcrc(text, PLUGIN, 'es6').config)).toEqual([
      [PLUGIN, { mode: 'step' }],
    ]);
  });
});

describe('hasWorkflowPlugin', () => {
  it('detects a configured workflow plugin', () => {
    expect(
      hasWorkflowPlugin(
        JSON.stringify({ jsc: { experimental: { plugins: [[PLUGIN, {}]] } } })
      )
    ).toBe(true);
  });

  it('returns false for an unrelated plugin list', () => {
    expect(
      hasWorkflowPlugin(
        JSON.stringify({
          jsc: { experimental: { plugins: [['@some/other', {}]] } },
        })
      )
    ).toBe(false);
  });

  it('returns false for an empty or invalid file', () => {
    expect(hasWorkflowPlugin('')).toBe(false);
    expect(hasWorkflowPlugin('{')).toBe(false);
    expect(hasWorkflowPlugin('{}')).toBe(false);
  });
});
