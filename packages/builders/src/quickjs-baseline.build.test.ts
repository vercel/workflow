import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { BaseBuilder, type DiscoveredEntries } from './base-builder.js';
import { FLOW_ASSETS_DIR } from './constants.js';
import type { StandaloneConfig } from './types.js';

/**
 * The builder prebuilds the QuickJS engine's baseline heap for every
 * production build: the header goes inline in the flow route, and the heap
 * ships as a file next to it that the route's asset loader reads.
 */

class TestBuilder extends BaseBuilder {
  async build(): Promise<void> {}

  createWorkflowBundle(
    inputFile: string,
    outfile: string,
    discoveredEntries: DiscoveredEntries
  ) {
    return this.createWorkflowsBundle({
      inputFiles: [inputFile],
      outfile,
      bundleFinalOutput: false,
      discoveredEntries,
    });
  }
}

const ASSET = 'quickjs-baseline.bin';

describe('prebuilt QuickJS baseline', () => {
  const repoRoot = resolve(import.meta.dirname, '../../..');
  const outputDirs: string[] = [];

  afterEach(() => {
    for (const outputDir of outputDirs) {
      rmSync(outputDir, { recursive: true, force: true });
    }
    outputDirs.length = 0;
    delete process.env.WORKFLOW_VM;
  });

  async function buildRoute(
    source = 'export async function wf() { "use workflow"; return 1; }\n',
    options: { watch?: boolean } = {}
  ) {
    const outputDir = mkdtempSync(join(import.meta.dirname, '.qjs-baseline-'));
    outputDirs.push(outputDir);
    const inputFile = join(outputDir, 'workflow.ts');
    writeFileSync(inputFile, source);
    const config: StandaloneConfig = {
      buildTarget: 'standalone',
      workingDir: outputDir,
      projectRoot: repoRoot,
      moduleSpecifierRoot: repoRoot,
      dirs: ['.'],
      stepsBundlePath: join(outputDir, 'steps.js'),
      workflowsBundlePath: join(outputDir, 'flow', 'workflow.mjs'),
      webhookBundlePath: join(outputDir, 'webhook.js'),
      sourcemap: false,
      watch: options.watch,
      suppressCreateWorkflowsBundleLogs: true,
      suppressCreateWorkflowsBundleWarnings: true,
    };
    const result = await new TestBuilder(config).createWorkflowBundle(
      inputFile,
      config.workflowsBundlePath,
      {
        discoveredSteps: new Set(),
        discoveredWorkflows: new Set([inputFile]),
        discoveredSerdeFiles: new Set(),
      }
    );
    await result.interimBundleCtx?.dispose();
    const routePath = config.workflowsBundlePath;
    return {
      routePath,
      route: readFileSync(routePath, 'utf8'),
      interimBundleText: result.interimBundleText as string,
      assetPath: join(dirname(routePath), FLOW_ASSETS_DIR, ASSET),
    };
  }

  function constant(route: string, name: string): string | undefined {
    return route.match(new RegExp(`^const ${name} = (.*);$`, 'm'))?.[1];
  }

  it('ships the heap as a file next to the route, and the header inline', async () => {
    const { route, routePath, interimBundleText, assetPath } =
      await buildRoute();
    const header = JSON.parse(
      constant(route, 'workflowQuickJSBaseline') ?? 'null'
    );
    expect(header).toMatchObject({ v: 2 });
    expect(header.ineligible).toBeUndefined();
    // Keyed to the exact code the route hands the runtime.
    expect(header.codeDigest).toBe(
      createHash('sha256').update(interimBundleText).digest('hex')
    );
    expect(route).toContain(
      'quickjsBaseline: workflowQuickJSBaseline, loadAsset: workflowLoadAsset'
    );
    // No heap bytes in the route itself.
    expect(route.length).toBeLessThan(interimBundleText.length + 4096);
    expect(existsSync(assetPath)).toBe(true);

    // The route's loader finds the file relative to the route module.
    const loader = constant(route, 'workflowLoadAsset');
    const probe = join(dirname(routePath), 'probe.mjs');
    writeFileSync(probe, `export default ${loader};\n`);
    const { default: loadAsset } = await import(pathToFileURL(probe).href);
    const bytes: Uint8Array = await loadAsset(ASSET);
    expect(Buffer.compare(bytes, readFileSync(assetPath))).toBe(0);
  });

  it('is not built in watch mode', async () => {
    const { route, assetPath } = await buildRoute(undefined, { watch: true });
    expect(route).not.toContain('quickjsBaseline');
    expect(existsSync(assetPath)).toBe(false);
  });

  it('records an ineligible bundle inline and ships no file', async () => {
    const { route, assetPath } = await buildRoute(
      'const startedAt = Date.now();\nexport async function wf() { "use workflow"; return startedAt; }\n'
    );
    const header = JSON.parse(
      constant(route, 'workflowQuickJSBaseline') ?? 'null'
    );
    expect(header.ineligible).toMatch(/clock read/);
    expect(route).not.toContain('loadAsset');
    expect(existsSync(assetPath)).toBe(false);
  });

  describe('a bundle whose module scope throws in the QuickJS engine', () => {
    const source =
      'const fmt = new Intl.NumberFormat("en-US");\nexport async function wf() { "use workflow"; return fmt.format(1); }\n';

    it('fails the build when the build selects the QuickJS engine', async () => {
      process.env.WORKFLOW_VM = 'quickjs';
      await expect(buildRoute(source)).rejects.toThrow(
        /threw while evaluating in the QuickJS engine[\s\S]*Intl\.NumberFormat/
      );
    });

    it('does not fail a build for the node engine', async () => {
      const { route, assetPath } = await buildRoute(source);
      const header = JSON.parse(
        constant(route, 'workflowQuickJSBaseline') ?? 'null'
      );
      expect(header.ineligible).toMatch(/module scope threw/);
      expect(existsSync(assetPath)).toBe(false);
    });
  });
});
