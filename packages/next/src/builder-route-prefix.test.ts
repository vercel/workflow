import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getNextBuilderEager } from './builder-eager.js';

const QUEUE_TRIGGER = { type: 'queue/v2beta', topic: '__wkf_workflow_*' };

interface RecordedBundle {
  stepsOutfile?: string;
  flowOutfile?: string;
}

const combinedBundles: RecordedBundle[] = [];
const webhookBundles: string[] = [];
const manifestDirs: string[] = [];

/**
 * A stand-in for the pieces of `@workflow/builders` the Next builder reaches
 * for, so the generated file layout can be asserted without running esbuild or
 * the SWC transforms. Only the paths matter here.
 */
function createBuildersStub(): typeof import('@workflow/builders') {
  class BaseBuilderStub {
    protected config: Record<string, any>;
    // Forced on rather than read from `WORKFLOW_PUBLIC_MANIFEST`: the env
    // gating lives on the real getter, while these cases are about where the
    // public copy lands once it is enabled.
    protected shouldExposePublicManifest = true;

    constructor(config: Record<string, any>) {
      this.config = config;
    }

    protected async getInputFiles(): Promise<string[]> {
      return [];
    }

    protected async findTsConfigPath(): Promise<string | undefined> {
      return undefined;
    }

    protected clearDiscoveredEntriesCache(): void {}

    protected async createCombinedBundle(options: RecordedBundle) {
      combinedBundles.push({
        stepsOutfile: options.stepsOutfile,
        flowOutfile: options.flowOutfile,
      });
      return {
        manifest: { steps: {}, workflows: {}, classes: {} },
        stepsManifest: { steps: {}, workflows: {}, classes: {} },
        workflowsManifest: { steps: {}, workflows: {}, classes: {} },
        discoveredEntries: new Map(),
      };
    }

    protected async createWebhookBundle({ outfile }: { outfile: string }) {
      webhookBundles.push(outfile);
    }

    protected async createManifest({
      manifestDir,
    }: {
      manifestDir: string;
    }): Promise<string> {
      manifestDirs.push(manifestDir);
      const manifestJson = '{"version":"1.0.0"}';
      await mkdir(manifestDir, { recursive: true });
      await writeFile(join(manifestDir, 'manifest.json'), manifestJson);
      return manifestJson;
    }
  }

  return {
    BaseBuilder: BaseBuilderStub,
    getWorkflowQueueTrigger: () => QUEUE_TRIGGER,
    detectWorkflowPatterns: () => ({
      hasUseWorkflow: false,
      hasUseStep: false,
      hasSerde: false,
    }),
    parentHasChild: () => false,
    writeFileIfChanged: async (path: string, contents: string) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents);
      return true;
    },
  } as unknown as typeof import('@workflow/builders');
}

// `getNextBuilderEager` memoizes the class it builds, so the first stub is the
// one every case in this file runs against.
const buildersStub = createBuildersStub();
const workingDirs: string[] = [];

function createWorkingDir(label: string): string {
  const workingDir = mkdtempSync(join(tmpdir(), `workflow-next-${label}-`));
  workingDirs.push(workingDir);
  return workingDir;
}

async function build(
  workingDir: string,
  experimentalRoutePrefix?: string
): Promise<void> {
  const NextBuilder = await getNextBuilderEager(buildersStub);
  await new NextBuilder({
    buildTarget: 'next',
    dirs: ['.'],
    pageExtensions: ['tsx', 'ts', 'jsx', 'js'],
    workingDir,
    projectRoot: workingDir,
    distDir: '.next',
    experimentalRoutePrefix,
    watch: false,
    stepsBundlePath: '',
    workflowsBundlePath: '',
    webhookBundlePath: '',
  }).build();
}

async function buildProject(experimentalRoutePrefix?: string): Promise<string> {
  const workingDir = createWorkingDir('builder-prefix');
  mkdirSync(join(workingDir, 'app'), { recursive: true });
  await build(workingDir, experimentalRoutePrefix);
  return workingDir;
}

describe('NextBuilder route prefix', () => {
  beforeEach(() => {
    combinedBundles.length = 0;
    webhookBundles.length = 0;
    manifestDirs.length = 0;
    // `writeFunctionsConfig` is a no-op in development.
    vi.stubEnv('NODE_ENV', 'production');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const workingDir of workingDirs.splice(0)) {
      rmSync(workingDir, { recursive: true, force: true });
    }
  });

  it('emits the routes, function config and manifest at the app root by default', async () => {
    const workingDir = await buildProject();
    const generatedDir = join(workingDir, 'app/.well-known/workflow/v1');

    expect(combinedBundles).toEqual([
      {
        stepsOutfile: join(generatedDir, 'flow/__step_registrations.js'),
        flowOutfile: join(generatedDir, 'flow/route.js'),
      },
    ]);
    expect(webhookBundles).toEqual([
      join(generatedDir, 'webhook/[token]/route.js'),
    ]);
    expect(manifestDirs).toEqual([generatedDir]);
    expect(existsSync(join(generatedDir, 'config.json'))).toBe(true);
    expect(
      existsSync(
        join(workingDir, 'public/.well-known/workflow/v1/manifest.json')
      )
    ).toBe(true);
  });

  it('emits everything below the route prefix', async () => {
    const workingDir = await buildProject('/ship');
    const generatedDir = join(workingDir, 'app/ship/.well-known/workflow/v1');

    expect(combinedBundles).toEqual([
      {
        stepsOutfile: join(generatedDir, 'flow/__step_registrations.js'),
        flowOutfile: join(generatedDir, 'flow/route.js'),
      },
    ]);
    expect(webhookBundles).toEqual([
      join(generatedDir, 'webhook/[token]/route.js'),
    ]);
    expect(manifestDirs).toEqual([generatedDir]);
    expect(existsSync(join(workingDir, 'app/.well-known'))).toBe(false);
    expect(
      existsSync(
        join(workingDir, 'public/ship/.well-known/workflow/v1/manifest.json')
      )
    ).toBe(true);
  });

  // The Vercel Next.js builder reads the flow function's options from
  // `../config.json` relative to the route file, so the config has to move
  // with the route for the queue trigger to be attached to it.
  it('writes the queue trigger config next to the prefixed flow route', async () => {
    const workingDir = await buildProject('ship/');
    const configPath = join(
      workingDir,
      'app/ship/.well-known/workflow/v1/config.json'
    );

    expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toEqual({
      version: '0',
      workflows: {
        maxDuration: 'max',
        experimentalTriggers: [QUEUE_TRIGGER],
      },
    });
  });

  // Every one of these leaves a second flow route carrying the queue trigger,
  // which would give the deployment two consumers of the same topic.
  it.each([
    { from: undefined, to: '/ship', stale: 'app/.well-known/workflow/v1' },
    { from: '/ship', to: '/cargo', stale: 'app/ship/.well-known/workflow/v1' },
    { from: '/ship', to: undefined, stale: 'app/ship/.well-known/workflow/v1' },
  ])('removes the generated routes from a previous $from build when building $to', async ({
    from,
    to,
    stale,
  }) => {
    const workingDir = createWorkingDir('builder-reprefix');
    mkdirSync(join(workingDir, 'app'), { recursive: true });

    await build(workingDir, from);
    expect(existsSync(join(workingDir, stale))).toBe(true);

    await build(workingDir, to);

    expect(existsSync(join(workingDir, stale))).toBe(false);
    expect(
      existsSync(
        join(workingDir, 'app', to ?? '', '.well-known/workflow/v1/config.json')
      )
    ).toBe(true);
    // The public copy follows the routes rather than accumulating one
    // manifest per prefix ever configured.
    expect(existsSync(join(workingDir, stale.replace(/^app/, 'public')))).toBe(
      false
    );
    expect(
      existsSync(
        join(
          workingDir,
          'public',
          to ?? '',
          '.well-known/workflow/v1/manifest.json'
        )
      )
    ).toBe(true);
  });

  it('keeps a hand-written route directory that carries no generated marker', async () => {
    const workingDir = createWorkingDir('builder-manual');
    const manualRoute = join(
      workingDir,
      'app/.well-known/workflow/v1/custom/route.ts'
    );
    mkdirSync(dirname(manualRoute), { recursive: true });
    await writeFile(manualRoute, 'export function GET() {}');

    await build(workingDir, '/ship');

    expect(existsSync(manualRoute)).toBe(true);
  });
});
