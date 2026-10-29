import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowManifest } from './apply-swc-transform.js';
import { BaseBuilder, type DiscoveredEntries } from './base-builder.js';
import type { StandaloneConfig } from './types.js';

class TestBuilder extends BaseBuilder {
  async build(): Promise<void> {
    // no-op
  }

  public discoverEntriesPublic(
    inputs: string[],
    outdir: string
  ): Promise<DiscoveredEntries> {
    return this.discoverEntries(inputs, outdir);
  }

  public createTestManifest(args: {
    workflowBundlePath: string;
    manifestDir: string;
    manifest: WorkflowManifest;
  }): Promise<string | undefined> {
    return this.createManifest(args);
  }
}

const realTmpdir = realpathSync(tmpdir());

function writeFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf-8');
}

function createBuilder(
  workingDir: string,
  overrides?: Partial<StandaloneConfig>
): TestBuilder {
  const config: StandaloneConfig = {
    buildTarget: 'standalone',
    workingDir,
    dirs: ['.'],
    stepsBundlePath: join(workingDir, 'steps.js'),
    workflowsBundlePath: join(workingDir, 'workflows.js'),
    webhookBundlePath: join(workingDir, 'webhook.js'),
    ...overrides,
  };
  return new TestBuilder(config);
}

describe('base builder build diagnostics', () => {
  let testRoot: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    testRoot = mkdtempSync(join(realTmpdir, 'workflow-builder-diagnostics-'));
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    warnSpy.mockRestore();
    logSpy.mockRestore();
    rmSync(testRoot, { recursive: true, force: true });
  });

  /**
   * An entry importing a workflow whose own import goes nowhere: the module
   * behind `./charge` is never scanned, so the step it would have declared is
   * missing from the build.
   */
  function writeWorkflowWithMissingImport(): string {
    const entryFile = join(testRoot, 'src', 'entry.ts');
    writeFile(entryFile, `import './workflows/order';\n`);
    writeFile(
      join(testRoot, 'src', 'workflows', 'order.ts'),
      `import { charge } from './charge';

export async function order() {
  'use workflow';
  return charge();
}
`
    );
    return entryFile;
  }

  const unresolvedWarnings = (): string[] =>
    warnSpy.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .filter((message: string) => message.includes('could not resolve'));

  describe('unresolved imports out of workflow code', () => {
    it('warns on a production build, naming the file and the specifier', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      const entryFile = writeWorkflowWithMissingImport();

      await createBuilder(testRoot).discoverEntriesPublic(
        [entryFile],
        join(testRoot, 'out')
      );

      const warnings = unresolvedWarnings();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('src/workflows/order.ts');
      expect(warnings[0]).toContain('"./charge"');
      expect(warnings[0]).toContain('WorkflowNotRegisteredError');
    });

    it('stays quiet in development, where the target may not exist yet', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      const entryFile = writeWorkflowWithMissingImport();

      await createBuilder(testRoot).discoverEntriesPublic(
        [entryFile],
        join(testRoot, 'out')
      );

      expect(unresolvedWarnings()).toEqual([]);
    });

    // `@workflow/nest` rebuilds at application startup — every
    // `nest start --watch` restart — and `@workflow/vitest` rebuilds per test
    // run under `NODE_ENV=test`. Neither watches nor sets
    // `NODE_ENV=development`, so without this they would be read as deploy
    // builds and warn on every restart.
    it('stays quiet for a builder that declares itself a development build', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      const entryFile = writeWorkflowWithMissingImport();

      await createBuilder(testRoot, {
        development: true,
      }).discoverEntriesPublic([entryFile], join(testRoot, 'out'));

      expect(unresolvedWarnings()).toEqual([]);
    });

    it('stays quiet in watch mode', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      const entryFile = writeWorkflowWithMissingImport();

      await createBuilder(testRoot, { watch: true }).discoverEntriesPublic(
        [entryFile],
        join(testRoot, 'out')
      );

      expect(unresolvedWarnings()).toEqual([]);
    });

    it('warns once when a build discovers the same graph twice', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      const entryFile = writeWorkflowWithMissingImport();
      const builder = createBuilder(testRoot);

      // Separate array references, so the discovery cache misses and the walk
      // reports the same unresolved edge again. One build makes several
      // bundles this way.
      await builder.discoverEntriesPublic([entryFile], join(testRoot, 'out'));
      await builder.discoverEntriesPublic([entryFile], join(testRoot, 'out'));

      expect(unresolvedWarnings()).toHaveLength(1);
    });
  });

  describe('manifest creation failures', () => {
    const manifest: WorkflowManifest = {
      workflows: {
        'src/workflows/order.ts': {
          order: { workflowId: 'workflow//./src/workflows/order//order' },
        },
      },
    };

    // The flow bundle the manifest describes is never written, so reading it
    // back fails the way a broken or missing bundle would.
    const createManifestForMissingBundle = (overrides?: {
      watch?: boolean;
      development?: boolean;
    }): Promise<string | undefined> => {
      const manifestDir = join(testRoot, '.well-known/workflow/v1');
      mkdirSync(manifestDir, { recursive: true });
      return createBuilder(testRoot, overrides).createTestManifest({
        workflowBundlePath: join(testRoot, 'missing-flow-bundle.js'),
        manifestDir,
        manifest,
      });
    };

    it('fails a production build instead of reporting success', async () => {
      vi.stubEnv('NODE_ENV', 'production');

      await expect(createManifestForMissingBundle()).rejects.toThrow(
        /Failed to create the workflow manifest/
      );
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('names WorkflowBuildError and keeps the original cause', async () => {
      vi.stubEnv('NODE_ENV', 'production');

      const error = await createManifestForMissingBundle().catch(
        (thrown: unknown) => thrown
      );

      expect((error as Error).name).toBe('WorkflowBuildError');
      expect((error as Error).cause).toBeInstanceOf(Error);
    });

    it('keeps warning and continuing in development', async () => {
      vi.stubEnv('NODE_ENV', 'development');

      await expect(createManifestForMissingBundle()).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        'Failed to create manifest:',
        expect.any(String)
      );
    });

    it('keeps warning and continuing for a declared development build', async () => {
      vi.stubEnv('NODE_ENV', 'production');

      await expect(
        createManifestForMissingBundle({ development: true })
      ).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        'Failed to create manifest:',
        expect.any(String)
      );
    });

    it('keeps warning and continuing in watch mode', async () => {
      vi.stubEnv('NODE_ENV', 'production');

      await expect(
        createManifestForMissingBundle({ watch: true })
      ).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        'Failed to create manifest:',
        expect.any(String)
      );
    });
  });
});
