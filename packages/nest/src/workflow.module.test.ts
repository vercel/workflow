import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
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

  it('receives ApplicationConfig through the real Nest injector', async () => {
    writeBundles(outDir, ['steps.mjs', 'workflows.mjs', 'webhook.mjs']);
    class RootModule {}
    Module({
      imports: [
        WorkflowModule.forRoot({
          outDir,
          skipBuild: true,
          preloadBundles: false,
        }),
      ],
    })(RootModule);

    const app = await NestFactory.create(RootModule, { logger: false });
    try {
      app.setGlobalPrefix('api');
      await app.init();
      expect(getWorkflowBasePath()).toBe('/api');
    } finally {
      await app.close();
    }
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

  it('stays quiet for a basePath applied entirely outside NestJS', async () => {
    // A reverse proxy mounts the app on /proxied and strips it, so there is no
    // NestJS global prefix for it to agree with. This is the setup the docs
    // recommend basePath for; reporting it told the user to unset the one
    // option that makes their deployment work.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    writeBundles(outDir, ['steps.mjs', 'workflows.mjs', 'webhook.mjs']);
    await moduleWith(options({ basePath: '/proxied' })).onModuleInit();
    expect(getWorkflowBasePath()).toBe('/proxied');
    expect(error).not.toHaveBeenCalled();
  });

  it('stays quiet when basePath composes a proxy sub-path with the prefix', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    writeBundles(outDir, ['steps.mjs', 'workflows.mjs', 'webhook.mjs']);
    await moduleWith(
      options({ basePath: '/proxied/api' }),
      '/api'
    ).onModuleInit();
    expect(getWorkflowBasePath()).toBe('/proxied/api');
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

describe('WorkflowModule bundle preloading', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('does not look for local bundles in the Vercel catch-all', async () => {
    vi.stubEnv('VERCEL', '1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const module = moduleWith({
      ...resolveModuleOptions(
        { outDir: '/bundles-not-in-the-catch-all', preloadBundles: true },
        { VERCEL: '1' }
      ),
      preloadBundles: true,
    });

    await module.onModuleInit();
    await new Promise((resolve) => setImmediate(resolve));
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('WorkflowModule world lifecycle', () => {
  let appDir: string;

  /**
   * Lay out an application that has `workflow` installed, the way a real app
   * does. The module has to resolve `workflow/runtime` from *here*, not from
   * its own directory: `workflow` depends on `@workflow/nest`, so under a
   * strict node_modules layout a bare import from the package fails outright.
   */
  function writeHostApp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'wf-nest-app-'));
    const pkgDir = join(dir, 'node_modules', 'workflow');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'host-app', version: '0.0.0' })
    );
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        name: 'workflow',
        version: '0.0.0',
        type: 'module',
        exports: { './runtime': './runtime.js' },
      })
    );
    writeFileSync(
      join(pkgDir, 'runtime.js'),
      `import { appendFileSync } from 'node:fs';
       const log = ${JSON.stringify(join(dir, 'calls.log'))};
       const world = {
         async start() { appendFileSync(log, 'start\\n'); },
         async close() { appendFileSync(log, 'close\\n'); },
       };
       export async function getWorld() { return world; }`
    );
    return dir;
  }

  function calls(dir: string): string[] {
    try {
      return readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n');
    } catch {
      return [];
    }
  }

  beforeEach(() => {
    appDir = writeHostApp();
    setWorkflowBasePath('');
  });

  afterEach(() => {
    rmSync(appDir, { recursive: true, force: true });
  });

  function managed(): ResolvedWorkflowModuleOptions {
    return {
      ...resolveModuleOptions(
        { workingDir: appDir, outDir: appDir, skipBuild: true },
        {}
      ),
      preloadBundles: false,
      manageWorldLifecycle: true,
    };
  }

  it("starts the World from the application's own workflow install", async () => {
    // Resolving the specifier from this package instead threw
    // ERR_MODULE_NOT_FOUND and took down startup, because `workflow` is not a
    // dependency of `@workflow/nest` and cannot be under pnpm.
    writeBundles(appDir, ['steps.mjs', 'workflows.mjs', 'webhook.mjs']);
    await moduleWith(managed()).onModuleInit();
    expect(calls(appDir)).toEqual(['start']);
  });

  it('closes the same World on shutdown', async () => {
    writeBundles(appDir, ['steps.mjs', 'workflows.mjs', 'webhook.mjs']);
    const module = moduleWith(managed());
    await module.onModuleInit();
    await module.onApplicationShutdown();
    expect(calls(appDir)).toEqual(['start', 'close']);
  });

  // The "workflow is not installed" branch is deliberately not covered here:
  // Vitest's resolver falls back to the workspace when a fixture has no
  // `node_modules/workflow`, so the failure cannot be staged under the test
  // runner. That fallback is also what makes the two tests above meaningful —
  // they only pass because the fixture's own copy took precedence.

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
