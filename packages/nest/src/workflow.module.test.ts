import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getWorkflowBasePath,
  type ResolvedWorkflowModuleOptions,
  resolveModuleOptions,
  setWorkflowBasePath,
  WORKFLOW_MODULE_OPTIONS,
  WORKFLOW_OPTIONS,
} from './options.js';
import { WorkflowController } from './workflow.controller.js';
import { WorkflowModule } from './workflow.module.js';

type ProviderLike = {
  provide?: unknown;
  useValue?: unknown;
  useExisting?: unknown;
  useFactory?: (...args: never[]) => unknown;
  inject?: unknown[];
};

function providerFor(
  providers: unknown[] | undefined,
  token: unknown
): ProviderLike | undefined {
  return (providers as ProviderLike[] | undefined)?.find(
    (provider) => provider?.provide === token
  );
}

/**
 * Build a module instance directly. `Test.createTestingModule` would need
 * `@nestjs/testing`, which this package does not depend on, and the lifecycle
 * hook is what we want to exercise anyway.
 */
function moduleWith(
  options: ResolvedWorkflowModuleOptions,
  globalPrefix = ''
): WorkflowModule {
  const appConfig = { getGlobalPrefix: () => globalPrefix };
  return new WorkflowModule(
    options,
    appConfig as unknown as ConstructorParameters<typeof WorkflowModule>[1]
  );
}

function writeBundles(outDir: string, names: string[]): void {
  for (const name of names) {
    writeFileSync(
      join(outDir, name),
      'export const __steps_registered = true;'
    );
  }
}

describe('WorkflowModule.forRoot', () => {
  it('registers the controller and both options tokens', () => {
    const dynamic = WorkflowModule.forRoot({ outDir: '/tmp/bundles' });
    expect(dynamic.controllers).toEqual([WorkflowController]);
    expect(dynamic.global).toBe(true);
    expect(dynamic.exports).toEqual([
      WORKFLOW_MODULE_OPTIONS,
      WORKFLOW_OPTIONS,
    ]);
    const options = providerFor(dynamic.providers, WORKFLOW_MODULE_OPTIONS);
    expect(
      (options?.useValue as ResolvedWorkflowModuleOptions | undefined)?.outDir
    ).toBe('/tmp/bundles');
  });

  it('aliases the legacy WORKFLOW_OPTIONS token onto the same value', () => {
    // Previously WORKFLOW_OPTIONS was a separate, unexported, uninjected
    // provider. Anything already injecting it must keep resolving.
    const dynamic = WorkflowModule.forRoot();
    expect(providerFor(dynamic.providers, WORKFLOW_OPTIONS)?.useExisting).toBe(
      WORKFLOW_MODULE_OPTIONS
    );
  });
});

describe('WorkflowModule.forRootAsync', () => {
  it('resolves options from a factory and passes imports through', async () => {
    const dynamic = WorkflowModule.forRootAsync({
      imports: ['ConfigModule'],
      inject: ['ConfigService'],
      useFactory: () => ({ basePath: 'api/', outDir: '/tmp/x' }),
    });
    expect(dynamic.imports).toEqual(['ConfigModule']);
    const provider = providerFor(dynamic.providers, WORKFLOW_MODULE_OPTIONS);
    expect(provider?.inject).toEqual(['ConfigService']);
    const resolved = (await provider?.useFactory?.()) as
      | ResolvedWorkflowModuleOptions
      | undefined;
    expect(resolved?.basePath).toBe('/api');
    expect(resolved?.outDir).toBe('/tmp/x');
  });

  it('accepts an async factory', async () => {
    const dynamic = WorkflowModule.forRootAsync({
      useFactory: async () => ({ basePath: '/v1' }),
    });
    const provider = providerFor(dynamic.providers, WORKFLOW_MODULE_OPTIONS);
    const resolved = (await provider?.useFactory?.()) as
      | ResolvedWorkflowModuleOptions
      | undefined;
    expect(resolved?.basePath).toBe('/v1');
  });
});

describe('WorkflowModule base path reconciliation', () => {
  let outDir: string;

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), 'wf-nest-module-'));
    setWorkflowBasePath('');
    vi.restoreAllMocks();
  });

  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  function options(
    overrides: Partial<ResolvedWorkflowModuleOptions> = {}
  ): ResolvedWorkflowModuleOptions {
    return {
      ...resolveModuleOptions({ outDir, skipBuild: true }, {}),
      preloadBundles: false,
      ...overrides,
    };
  }

  it('adopts the NestJS global prefix when no basePath is configured', async () => {
    // Without this, runs are created and every queue delivery 404s against the
    // unprefixed URL the SDK generated.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    writeBundles(outDir, ['steps.mjs', 'workflows.mjs', 'webhook.mjs']);
    await moduleWith(options(), '/api').onModuleInit();
    expect(getWorkflowBasePath()).toBe('/api');
    expect(log.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
      'global prefix "/api"'
    );
  });

  it('normalizes an adopted prefix that has no leading slash', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    writeBundles(outDir, ['steps.mjs', 'workflows.mjs', 'webhook.mjs']);
    await moduleWith(options(), 'api').onModuleInit();
    expect(getWorkflowBasePath()).toBe('/api');
  });

  it('publishes an empty base path when there is no prefix', async () => {
    writeBundles(outDir, ['steps.mjs', 'workflows.mjs', 'webhook.mjs']);
    await moduleWith(options()).onModuleInit();
    expect(getWorkflowBasePath()).toBe('');
  });

  it('lets an explicit basePath win over the global prefix and reports it', async () => {
    // An explicit basePath also covers a reverse proxy sub-path NestJS cannot
    // see, so it must not be silently overwritten.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    writeBundles(outDir, ['steps.mjs', 'workflows.mjs', 'webhook.mjs']);
    await moduleWith(options({ basePath: '/proxied' }), '/api').onModuleInit();
    expect(getWorkflowBasePath()).toBe('/proxied');
    expect(
      error.mock.calls.map((call) => String(call[0])).join('\n')
    ).toContain('Global prefix mismatch');
  });

  it('stays quiet when an explicit basePath matches the prefix', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    writeBundles(outDir, ['steps.mjs', 'workflows.mjs', 'webhook.mjs']);
    await moduleWith(options({ basePath: '/api' }), '/api').onModuleInit();
    expect(getWorkflowBasePath()).toBe('/api');
    expect(error).not.toHaveBeenCalled();
  });
});

describe('WorkflowModule bundle validation', () => {
  let outDir: string;

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), 'wf-nest-module-'));
    setWorkflowBasePath('');
  });

  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it('fails startup when skipBuild is set but the bundles are missing', async () => {
    // Previously the app logged a healthy startup and then answered every
    // workflow request with ERR_MODULE_NOT_FOUND.
    const module = moduleWith({
      ...resolveModuleOptions({ outDir, skipBuild: true }, {}),
      preloadBundles: false,
    });
    await expect(module.onModuleInit()).rejects.toThrow(
      /skipBuild is enabled but the workflow bundles are missing/
    );
  });

  it('names the bundles that are missing', async () => {
    writeBundles(outDir, ['steps.mjs']);
    const module = moduleWith({
      ...resolveModuleOptions({ outDir, skipBuild: true }, {}),
      preloadBundles: false,
    });
    await expect(module.onModuleInit()).rejects.toThrow(
      /workflows\.mjs, webhook\.mjs/
    );
  });

  it('starts when every bundle is present', async () => {
    writeBundles(outDir, ['steps.mjs', 'workflows.mjs', 'webhook.mjs']);
    const module = moduleWith({
      ...resolveModuleOptions({ outDir, skipBuild: true }, {}),
      preloadBundles: false,
    });
    await expect(module.onModuleInit()).resolves.toBeUndefined();
  });
});

describe('WorkflowModule world lifecycle', () => {
  it('does nothing on shutdown unless manageWorldLifecycle is set', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const module = moduleWith({
      ...resolveModuleOptions({ outDir: '/tmp/none' }, {}),
      manageWorldLifecycle: false,
    });
    await expect(module.onApplicationShutdown()).resolves.toBeUndefined();
    expect(error).not.toHaveBeenCalled();
  });
});
