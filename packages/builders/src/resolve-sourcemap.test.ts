import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BaseBuilder } from './base-builder.js';
import type { SourcemapMode, StandaloneConfig } from './types.js';

/**
 * Minimal subclass that exposes the protected `resolveSourcemap()` and
 * `sourcemapsEnabled` members for testing.
 */
class TestBuilder extends BaseBuilder {
  async build(): Promise<void> {
    // no-op
  }

  public callResolveSourcemap(defaultMode: SourcemapMode): SourcemapMode {
    return this.resolveSourcemap(defaultMode);
  }

  public get publicSourcemapsEnabled(): boolean {
    return this.sourcemapsEnabled;
  }
}

function createBuilder(sourcemap?: SourcemapMode): TestBuilder {
  const config: StandaloneConfig = {
    buildTarget: 'standalone',
    workingDir: '/tmp/workflow-test',
    dirs: ['.'],
    stepsBundlePath: '',
    workflowsBundlePath: '',
    webhookBundlePath: '',
    sourcemap,
  };
  return new TestBuilder(config);
}

describe('resolveSourcemap', () => {
  const originalEnv = process.env.WORKFLOW_SOURCEMAP;

  beforeEach(() => {
    delete process.env.WORKFLOW_SOURCEMAP;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.WORKFLOW_SOURCEMAP;
    } else {
      process.env.WORKFLOW_SOURCEMAP = originalEnv;
    }
  });

  it('returns the default when no config or env var is set', () => {
    const builder = createBuilder();
    expect(builder.callResolveSourcemap('inline')).toBe('inline');
    expect(builder.callResolveSourcemap(false)).toBe(false);
    expect(builder.callResolveSourcemap(true)).toBe(true);
  });

  it('prefers explicit config over the default', () => {
    expect(createBuilder(false).callResolveSourcemap('inline')).toBe(false);
    expect(createBuilder('external').callResolveSourcemap('inline')).toBe(
      'external'
    );
    expect(createBuilder('linked').callResolveSourcemap(false)).toBe('linked');
    expect(createBuilder(true).callResolveSourcemap('inline')).toBe(true);
  });

  it('prefers explicit config over environment variable', () => {
    process.env.WORKFLOW_SOURCEMAP = 'inline';
    expect(createBuilder(false).callResolveSourcemap('inline')).toBe(false);
    expect(createBuilder('external').callResolveSourcemap('inline')).toBe(
      'external'
    );
  });

  it('uses environment variable when config is not set', () => {
    process.env.WORKFLOW_SOURCEMAP = 'false';
    expect(createBuilder().callResolveSourcemap('inline')).toBe(false);

    process.env.WORKFLOW_SOURCEMAP = 'true';
    expect(createBuilder().callResolveSourcemap(false)).toBe(true);

    for (const mode of ['inline', 'linked', 'external', 'both'] as const) {
      process.env.WORKFLOW_SOURCEMAP = mode;
      expect(createBuilder().callResolveSourcemap('inline')).toBe(mode);
    }
  });

  it('accepts "0" / "1" as environment variable aliases for false / true', () => {
    process.env.WORKFLOW_SOURCEMAP = '0';
    expect(createBuilder().callResolveSourcemap('inline')).toBe(false);

    process.env.WORKFLOW_SOURCEMAP = '1';
    expect(createBuilder().callResolveSourcemap(false)).toBe(true);
  });

  it('falls back to default when env var is empty or unrecognized', () => {
    process.env.WORKFLOW_SOURCEMAP = '';
    expect(createBuilder().callResolveSourcemap('inline')).toBe('inline');

    // Suppress the expected warning
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      process.env.WORKFLOW_SOURCEMAP = 'nonsense';
      expect(createBuilder().callResolveSourcemap('inline')).toBe('inline');
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe('sourcemapsEnabled', () => {
  const originalEnv = process.env.WORKFLOW_SOURCEMAP;

  beforeEach(() => {
    delete process.env.WORKFLOW_SOURCEMAP;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.WORKFLOW_SOURCEMAP;
    } else {
      process.env.WORKFLOW_SOURCEMAP = originalEnv;
    }
  });

  it('is true by default', () => {
    expect(createBuilder().publicSourcemapsEnabled).toBe(true);
  });

  it('is false when config sourcemap is false', () => {
    expect(createBuilder(false).publicSourcemapsEnabled).toBe(false);
  });

  it('is true for any non-false config value', () => {
    for (const mode of [
      true,
      'inline',
      'linked',
      'external',
      'both',
    ] as const) {
      expect(createBuilder(mode).publicSourcemapsEnabled).toBe(true);
    }
  });

  it('is false when WORKFLOW_SOURCEMAP env is false', () => {
    process.env.WORKFLOW_SOURCEMAP = 'false';
    expect(createBuilder().publicSourcemapsEnabled).toBe(false);
  });
});
