import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  buildMock,
  builderConfigs,
  getNextBuilderMock,
  prewarmWorkflowSwcPluginCacheMock,
} = vi.hoisted(() => {
  const buildMock = vi.fn(async () => {});
  const builderConfigs: Record<string, unknown>[] = [];
  const getNextBuilderMock = vi.fn(async () => {
    return class MockNextBuilder {
      build = buildMock;

      constructor(config: Record<string, unknown>) {
        builderConfigs.push(config);
      }
    };
  });
  const prewarmWorkflowSwcPluginCacheMock = vi.fn();

  return {
    buildMock,
    builderConfigs,
    getNextBuilderMock,
    prewarmWorkflowSwcPluginCacheMock,
  };
});

vi.mock('./builder.js', () => ({
  getNextBuilder: getNextBuilderMock,
}));

vi.mock('./swc-plugin-cache.js', () => ({
  prewarmWorkflowSwcPluginCache: prewarmWorkflowSwcPluginCacheMock,
}));

import { withWorkflow } from './index.js';

const loaderStubPath = join(__dirname, 'loader.js');
const hadLoaderStub = existsSync(loaderStubPath);
const realTmpDir = realpathSync(tmpdir());

function writeFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf-8');
}

describe('withWorkflow builder config', () => {
  const originalCwd = process.cwd();
  const originalEnv = {
    PORT: process.env.PORT,
    VERCEL_DEPLOYMENT_ID: process.env.VERCEL_DEPLOYMENT_ID,
    WORKFLOW_LOCAL_DATA_DIR: process.env.WORKFLOW_LOCAL_DATA_DIR,
    WORKFLOW_NEXT_PRIVATE_BUILT: process.env.WORKFLOW_NEXT_PRIVATE_BUILT,
    WORKFLOW_TARGET_WORLD: process.env.WORKFLOW_TARGET_WORLD,
  };

  beforeEach(() => {
    buildMock.mockClear();
    builderConfigs.length = 0;
    getNextBuilderMock.mockClear();
    prewarmWorkflowSwcPluginCacheMock.mockClear();
    if (!hadLoaderStub) {
      writeFileSync(loaderStubPath, 'module.exports = {};\n', 'utf-8');
    }

    delete process.env.PORT;
    delete process.env.VERCEL_DEPLOYMENT_ID;
    delete process.env.WORKFLOW_LOCAL_DATA_DIR;
    delete process.env.WORKFLOW_NEXT_PRIVATE_BUILT;
    delete process.env.WORKFLOW_TARGET_WORLD;
    delete (globalThis as Record<symbol, unknown>)[
      Symbol.for('@workflow/next/workflowBuilds')
    ];
  });

  afterEach(() => {
    if (!hadLoaderStub && existsSync(loaderStubPath)) {
      rmSync(loaderStubPath);
    }

    if (process.cwd() !== originalCwd) {
      process.chdir(originalCwd);
    }

    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('uses outputFileTracingRoot for tracing without changing module specifier root', async () => {
    const config = withWorkflow({
      outputFileTracingRoot: '/repo',
      pageExtensions: ['page.ts'],
    });

    await config('phase-production-build', {
      defaultConfig: {},
    });

    expect(getNextBuilderMock).toHaveBeenCalledOnce();
    expect(buildMock).toHaveBeenCalledOnce();
    expect(builderConfigs).toHaveLength(1);
    expect(builderConfigs[0]).toMatchObject({
      dirs: ['.'],
      pageExtensions: ['page.ts'],
      projectRoot: '/repo',
      moduleSpecifierRoot: process.cwd(),
      workingDir: process.cwd(),
    });
  });

  it.each([
    'phase-production-build',
    'phase-development-server',
  ])('prewarms the SWC plugin cache during %s', async (phase) => {
    const config = withWorkflow({});

    await config(phase, { defaultConfig: {} });

    expect(prewarmWorkflowSwcPluginCacheMock).toHaveBeenCalledOnce();
    expect(prewarmWorkflowSwcPluginCacheMock).toHaveBeenCalledWith(
      process.cwd()
    );
  });

  it('builds once per process when Next resets process.env between config evaluations', async () => {
    // Next 16 dev re-evaluates next.config (validateTurboNextConfig) after
    // startup, and a forced @next/env reload in between (triggered by any env
    // change the dev watcher sees, e.g. an `.env*` edit or an app route being
    // added) restores process.env to its initial snapshot, dropping
    // WORKFLOW_NEXT_PRIVATE_BUILT.
    const config = withWorkflow({});

    await config('phase-development-server', { defaultConfig: {} });
    delete process.env.WORKFLOW_NEXT_PRIVATE_BUILT;
    await config('phase-development-server', { defaultConfig: {} });

    expect(buildMock).toHaveBeenCalledOnce();
    expect(builderConfigs).toHaveLength(1);
    expect(process.env.WORKFLOW_NEXT_PRIVATE_BUILT).toBe('1');
  });

  it('shares an in-flight build between concurrent config evaluations', async () => {
    buildMock.mockImplementationOnce(
      () => new Promise<void>((resolve) => setTimeout(resolve, 20))
    );
    const config = withWorkflow({});

    await Promise.all([
      config('phase-development-server', { defaultConfig: {} }),
      config('phase-development-server', { defaultConfig: {} }),
    ]);

    expect(buildMock).toHaveBeenCalledOnce();
  });

  it('retries the build on the next config evaluation after a failed build', async () => {
    buildMock.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    const config = withWorkflow({});

    await expect(
      config('phase-development-server', { defaultConfig: {} })
    ).rejects.toThrow('boom');
    expect(process.env.WORKFLOW_NEXT_PRIVATE_BUILT).toBeUndefined();

    await config('phase-development-server', { defaultConfig: {} });

    expect(buildMock).toHaveBeenCalledTimes(2);
    expect(process.env.WORKFLOW_NEXT_PRIVATE_BUILT).toBe('1');
  });

  it('builds once when the plugin module is re-imported between config evaluations', async () => {
    // Next may re-require next.config (and this plugin) when it re-evaluates
    // the config, so the build record must not live in module scope.
    await withWorkflow({})('phase-development-server', { defaultConfig: {} });
    delete process.env.WORKFLOW_NEXT_PRIVATE_BUILT;

    vi.resetModules();
    const { withWorkflow: freshWithWorkflow } = await import('./index.js');
    await freshWithWorkflow({})('phase-development-server', {
      defaultConfig: {},
    });

    expect(buildMock).toHaveBeenCalledOnce();
  });

  it('does not prewarm the SWC plugin cache for the production server', async () => {
    const config = withWorkflow({});

    await config('phase-production-server', { defaultConfig: {} });

    expect(prewarmWorkflowSwcPluginCacheMock).not.toHaveBeenCalled();
  });

  it('configures diagnostics inside the default Next.js dist dir', async () => {
    const config = withWorkflow({});

    await config('phase-production-build', {
      defaultConfig: {},
    });

    expect(builderConfigs[0]).toMatchObject({
      distDir: '.next',
      diagnosticsDir: '.next/diagnostics',
    });
  });

  it('configures diagnostics inside a custom Next.js dist dir', async () => {
    const config = withWorkflow({
      distDir: 'build-output',
    });

    await config('phase-production-build', {
      defaultConfig: {},
    });

    expect(builderConfigs[0]).toMatchObject({
      distDir: 'build-output',
      diagnosticsDir: 'build-output/diagnostics',
    });
  });

  it('passes Next basePath to the workflow builder', async () => {
    const config = withWorkflow({
      basePath: '/v2',
    });

    await config('phase-production-build', {
      defaultConfig: {},
    });

    expect(builderConfigs).toHaveLength(1);
    expect(builderConfigs[0]).toMatchObject({
      basePath: '/v2',
    });
  });

  it('externalizes the non-bundlable Vercel packages while preserving user externals', async () => {
    const config = withWorkflow({
      serverExternalPackages: ['@node-rs/xxhash'],
    });

    const nextConfig = await config('phase-production-build', {
      defaultConfig: {},
    });

    // @workflow/world-vercel and @vercel/queue are deliberately absent: they
    // are bundled into the server output so a cold start does not resolve their
    // module graphs from disk one file at a time.
    expect(nextConfig.serverExternalPackages).toEqual([
      '@node-rs/xxhash',
      '@vercel/oidc',
      '@vercel/cli-auth',
      '@napi-rs/keyring',
    ]);
    expect(nextConfig.outputFileTracingIncludes).toBeUndefined();
  });

  function writeProjectWithQueueVersion(version: string): string {
    const projectDir = mkdtempSync(
      join(realTmpDir, 'workflow-next-queue-version-')
    );
    writeFile(
      join(projectDir, 'node_modules', '@vercel', 'queue', 'package.json'),
      JSON.stringify({
        name: '@vercel/queue',
        version,
        main: 'index.js',
        // The published package exports `.` and nothing else, so asking Node
        // for the manifest by subpath throws. Mirroring the map here keeps a
        // resolver-based lookup from passing against a fixture that the real
        // package layout would reject.
        exports: {
          '.': {
            require: './index.js',
          },
        },
      })
    );
    writeFile(
      join(projectDir, 'node_modules', '@vercel', 'queue', 'index.js'),
      'module.exports = {};'
    );
    return projectDir;
  }

  it('keeps an unbundlable @vercel/queue external', async () => {
    // Older releases leave their dynamic `import()` unannotated, which Turbopack
    // cannot resolve, so bundling that copy risks failing the build. Any version
    // below the bundlable floor works here, without restating the floor.
    process.chdir(writeProjectWithQueueVersion('0.0.1'));

    const nextConfig = await withWorkflow({})('phase-production-build', {
      defaultConfig: {},
    });

    expect(nextConfig.serverExternalPackages).toContain('@vercel/queue');
  });

  it('bundles a @vercel/queue version that carries the bundler-ignore hints', async () => {
    // Any version above the bundlable floor, without restating the floor here.
    process.chdir(writeProjectWithQueueVersion('99.0.0'));

    const nextConfig = await withWorkflow({})('phase-production-build', {
      defaultConfig: {},
    });

    expect(nextConfig.serverExternalPackages).not.toContain('@vercel/queue');
  });

  it('keeps the Vercel world external for the workflow/step bundles', async () => {
    const config = withWorkflow({});

    await config('phase-production-build', { defaultConfig: {} });

    expect(builderConfigs[0].externalPackages).toEqual(
      expect.arrayContaining(['@workflow/world-vercel', '@vercel/queue'])
    );
  });

  it('preserves user webpack externals without adding Vercel world dependency externals', async () => {
    const userWebpack = vi.fn((webpackConfig: any) => {
      webpackConfig.externals = [{ react: 'commonjs react' }];
      return webpackConfig;
    });
    const config = withWorkflow({
      webpack: userWebpack,
    });

    const nextConfig = await config('phase-production-build', {
      defaultConfig: {},
    });
    const webpackConfig = nextConfig.webpack?.(
      {
        externals: [],
        module: {
          rules: [],
        },
      },
      {} as any
    );

    expect(userWebpack).toHaveBeenCalledOnce();
    expect(webpackConfig?.externals).toEqual([{ react: 'commonjs react' }]);
  });

  it('removes workflow packages from serverExternalPackages for this build', async () => {
    const projectDir = mkdtempSync(
      join(realTmpDir, 'workflow-next-server-external-')
    );
    process.chdir(projectDir);

    writeFile(join(projectDir, 'index.ts'), 'export const x = 1;');
    writeFile(
      join(
        projectDir,
        'node_modules',
        'workflow-auto-remove-a',
        'package.json'
      ),
      JSON.stringify({
        name: 'workflow-auto-remove-a',
        version: '1.0.0',
        main: 'index.js',
      })
    );
    writeFile(
      join(projectDir, 'node_modules', 'workflow-auto-remove-a', 'index.js'),
      `export async function runJob() {
  "use workflow";
  return "ok";
}`
    );

    writeFile(
      join(projectDir, 'node_modules', 'plain-external-a', 'package.json'),
      JSON.stringify({
        name: 'plain-external-a',
        version: '1.0.0',
        main: 'index.js',
      })
    );
    writeFile(
      join(projectDir, 'node_modules', 'plain-external-a', 'index.js'),
      'export const plain = true;'
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const config = withWorkflow({
        serverExternalPackages: ['workflow-auto-remove-a', 'plain-external-a'],
      });

      const resolvedConfig = await config('phase-production-build', {
        defaultConfig: {},
      });

      expect(resolvedConfig.serverExternalPackages).toEqual([
        'plain-external-a',
        '@vercel/oidc',
        '@vercel/cli-auth',
        '@napi-rs/keyring',
      ]);
      expect(builderConfigs).toHaveLength(1);
      expect(builderConfigs[0]).toMatchObject({
        externalPackages: [
          'server-only',
          'client-only',
          'plain-external-a',
          '@vercel/oidc',
          '@vercel/cli-auth',
          '@napi-rs/keyring',
          '@workflow/world-vercel',
          '@vercel/queue',
        ],
      });

      expect(warnSpy).toHaveBeenCalledOnce();
      const warning = warnSpy.mock.calls[0]?.[0] as string;
      expect(warning).toContain('workflow-auto-remove-a');
      expect(warning).toContain('serverExternalPackages');
      expect(warning).toContain('removed');
      expect(warning).toContain('compiling the packages anyway');
    } finally {
      warnSpy.mockRestore();
      process.chdir(originalCwd);
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('keeps plain serverExternalPackages unchanged', async () => {
    const projectDir = mkdtempSync(
      join(realTmpDir, 'workflow-next-server-external-')
    );
    process.chdir(projectDir);

    writeFile(join(projectDir, 'index.ts'), 'export const x = 1;');
    writeFile(
      join(projectDir, 'node_modules', 'plain-external-b', 'package.json'),
      JSON.stringify({
        name: 'plain-external-b',
        version: '1.0.0',
        main: 'index.js',
      })
    );
    writeFile(
      join(projectDir, 'node_modules', 'plain-external-b', 'index.js'),
      'export const plain = true;'
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const config = withWorkflow({
        serverExternalPackages: ['plain-external-b'],
      });

      const resolvedConfig = await config('phase-production-build', {
        defaultConfig: {},
      });

      expect(resolvedConfig.serverExternalPackages).toEqual([
        'plain-external-b',
        '@vercel/oidc',
        '@vercel/cli-auth',
        '@napi-rs/keyring',
      ]);
      expect(builderConfigs).toHaveLength(1);
      expect(builderConfigs[0]).toMatchObject({
        externalPackages: [
          'server-only',
          'client-only',
          'plain-external-b',
          '@vercel/oidc',
          '@vercel/cli-auth',
          '@napi-rs/keyring',
          '@workflow/world-vercel',
          '@vercel/queue',
        ],
      });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      process.chdir(originalCwd);
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  describe('registration check after a production compile', () => {
    let projectDir: string;
    let warnSpy: ReturnType<typeof vi.spyOn>;

    const REGISTERED = 'workflow//./workflows/order//order';
    const UNREGISTERED = 'workflow//./workflows/mail//mail';

    beforeEach(() => {
      projectDir = mkdtempSync(join(realTmpDir, 'workflow-next-registration-'));
      // `buildConfig` resolves the app-graph directory from the working
      // directory, the way a real `next build` does, so the test has to be in
      // the project it is pretending to build.
      process.chdir(projectDir);
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      delete process.env.WORKFLOW_REGISTRATION_CHECK;
      delete process.env.WORKFLOW_DISCOVER_NODE_MODULES;
      delete process.env.WORKFLOW_NEXT_PRIVATE_APP_GRAPH_DIR;
      writeFile(
        join(projectDir, 'app/.well-known/workflow/v1/manifest.json'),
        JSON.stringify({
          version: '1.0.0',
          steps: {},
          workflows: {
            'workflows/order.ts': {
              order: {
                workflowId: REGISTERED,
                graph: { nodes: [], edges: [] },
              },
            },
          },
          classes: {},
        })
      );
    });

    afterEach(() => {
      warnSpy.mockRestore();
      delete process.env.WORKFLOW_REGISTRATION_CHECK;
      delete process.env.WORKFLOW_DISCOVER_NODE_MODULES;
      delete process.env.WORKFLOW_NEXT_PRIVATE_APP_GRAPH_DIR;
      process.chdir(originalCwd);
      rmSync(projectDir, { recursive: true, force: true });
    });

    /**
     * Evaluate the config (which arms the check), let the loader record what
     * the compile would have, then run the hook Next calls once it is done.
     */
    const compile = async ({
      declares = [],
      userHook,
    }: {
      declares?: string[];
      userHook?: () => Promise<void>;
    } = {}) => {
      const nextConfig = await withWorkflow({
        compiler: userHook
          ? ({ runAfterProductionCompile: userHook } as never)
          : undefined,
      })('phase-production-build', { defaultConfig: {} });

      await recordDeclaredWorkflows(declares);

      return (
        nextConfig.compiler as unknown as {
          runAfterProductionCompile: (metadata: {
            projectDir: string;
            distDir: string;
          }) => Promise<void>;
        }
      ).runAfterProductionCompile({ projectDir, distDir: '.next' });
    };

    /**
     * Stand in for the loader: record the ids the transform would have
     * reported for a module the bundler compiled.
     */
    const recordDeclaredWorkflows = async (workflowIds: string[]) => {
      if (workflowIds.length === 0) {
        return;
      }
      const { recordWorkflowAppGraphEntry } = await import(
        '@workflow/builders'
      );
      await recordWorkflowAppGraphEntry({
        appGraphDir: join(projectDir, '.next/workflow-app-graph'),
        file: join(projectDir, 'workflows/declared.ts'),
        manifest: {
          workflows: {
            'workflows/declared.ts': Object.fromEntries(
              workflowIds.map((workflowId, index) => [
                `workflow${index}`,
                { workflowId },
              ])
            ),
          },
        },
      });
    };

    it('fails the build when the app can start an unregistered workflow', async () => {
      await expect(
        compile({ declares: [REGISTERED, UNREGISTERED] })
      ).rejects.toThrow(
        /not registered in this build[\s\S]*workflow\/\/\.\/workflows\/mail\/\/mail/
      );
    });

    it('names WorkflowRegistrationError and points at discovery', async () => {
      const error = (await compile({ declares: [UNREGISTERED] }).catch(
        (thrown: unknown) => thrown
      )) as Error;

      expect(error.name).toBe('WorkflowRegistrationError');
      expect(error.message).toContain('WORKFLOW_REGISTRATION_CHECK=warn');
    });

    it('still copies the diagnostics manifest before failing', async () => {
      await expect(compile({ declares: [UNREGISTERED] })).rejects.toThrow();
      expect(
        existsSync(
          join(projectDir, '.next/diagnostics/workflows-manifest.json')
        )
      ).toBe(true);
    });

    it("still runs the app's own runAfterProductionCompile before failing", async () => {
      const userHook = vi.fn(async () => {});

      await expect(
        compile({ declares: [UNREGISTERED], userHook })
      ).rejects.toThrow();
      expect(userHook).toHaveBeenCalledOnce();
    });

    it('passes when every compiled workflow is registered', async () => {
      await expect(
        compile({ declares: [REGISTERED] })
      ).resolves.toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    // A bundler that served every module from its loader cache records
    // nothing, which must read as "no information", not "no workflows".
    it('says nothing when the compile recorded no workflows', async () => {
      await expect(compile()).resolves.toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('says nothing when the app has no workflow manifest', async () => {
      rmSync(join(projectDir, 'app'), { recursive: true, force: true });

      await expect(
        compile({ declares: [UNREGISTERED] })
      ).resolves.toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    // Reading an unwritable manifest as "registered nothing" would report
    // every workflow in the app.
    it('says nothing when the manifest cannot be parsed', async () => {
      writeFile(
        join(projectDir, 'app/.well-known/workflow/v1/manifest.json'),
        '{"workflows": {'
      );

      await expect(
        compile({ declares: [UNREGISTERED] })
      ).resolves.toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('empties what an earlier build recorded before compiling', async () => {
      // Recorded before the config runs, the way a previous build would have
      // left it behind.
      await recordDeclaredWorkflows([UNREGISTERED]);

      await expect(
        compile({ declares: [REGISTERED] })
      ).resolves.toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('warns without failing when WORKFLOW_REGISTRATION_CHECK=warn', async () => {
      process.env.WORKFLOW_REGISTRATION_CHECK = 'warn';

      await expect(
        compile({ declares: [UNREGISTERED] })
      ).resolves.toBeUndefined();
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain(UNREGISTERED);
    });

    // Opting out of dependency discovery deliberately leaves a dependency's
    // workflows unregistered while the bundler still compiles them.
    it('reports without failing when node_modules discovery is off', async () => {
      process.env.WORKFLOW_DISCOVER_NODE_MODULES = '0';

      await expect(
        compile({ declares: [UNREGISTERED] })
      ).resolves.toBeUndefined();
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain(UNREGISTERED);
    });

    it('still fails for that opt-out when the check is forced on', async () => {
      process.env.WORKFLOW_DISCOVER_NODE_MODULES = '0';
      process.env.WORKFLOW_REGISTRATION_CHECK = 'error';

      await expect(compile({ declares: [UNREGISTERED] })).rejects.toThrow();
    });

    it.each([
      'off',
      '0',
      'false',
    ])('skips the check when WORKFLOW_REGISTRATION_CHECK=%s', async (value) => {
      process.env.WORKFLOW_REGISTRATION_CHECK = value;

      await expect(
        compile({ declares: [UNREGISTERED] })
      ).resolves.toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
