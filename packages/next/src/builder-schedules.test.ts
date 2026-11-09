import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { collectWorkflowSchedules } from '@workflow/builders';
import { afterEach, describe, expect, it } from 'vitest';
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

    protected workflowSchedulesOf(
      manifest?: Parameters<typeof collectWorkflowSchedules>[0]
    ) {
      return collectWorkflowSchedules(manifest ?? {});
    }

    protected async createCombinedBundle(options: RecordedBundle) {
      combinedBundles.push({
        stepsOutfile: options.stepsOutfile,
        flowOutfile: options.flowOutfile,
      });
      return {
        manifest: {
          steps: {},
          workflows: {
            'app/workflows/report.ts': {
              nightlyReport: {
                workflowId: 'workflow//./app/workflows/report//nightlyReport',
                schedule: { cron: '0 2 * * *', timezone: 'Europe/London' },
              },
              unscheduled: {
                workflowId: 'workflow//./app/workflows/report//unscheduled',
              },
            },
          },
          classes: {},
        },
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

const workingDirs: string[] = [];

afterEach(() => {
  for (const dir of workingDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('NextBuilder schedules', () => {
  // The Vercel Next.js builder reads `config.json` next to the flow route and
  // returns its `schedules` with the build result, so the workflows'
  // `experimental_schedule` declarations reach the deployment without vercel.json.
  it("writes the workflows' schedules into the flow route's config.json", async () => {
    const workingDir = mkdtempSync(join(tmpdir(), 'workflow-next-schedules-'));
    workingDirs.push(workingDir);
    mkdirSync(join(workingDir, 'app'), { recursive: true });
    const NextBuilder = await getNextBuilderEager(createBuildersStub());
    await new NextBuilder({
      buildTarget: 'next',
      dirs: ['.'],
      pageExtensions: ['tsx', 'ts', 'jsx', 'js'],
      workingDir,
      projectRoot: workingDir,
      distDir: '.next',
      watch: false,
      stepsBundlePath: '',
      workflowsBundlePath: '',
      webhookBundlePath: '',
    }).build();

    expect(
      JSON.parse(
        readFileSync(
          join(workingDir, 'app/.well-known/workflow/v1/config.json'),
          'utf-8'
        )
      )
    ).toEqual({
      version: '0',
      workflows: {
        maxDuration: 'max',
        experimentalTriggers: [QUEUE_TRIGGER],
      },
      schedules: {
        nightlyReport: {
          schedule: '0 2 * * *',
          timezone: 'Europe/London',
          topic:
            '__wkf_workflow_schedule_app_sworkflows_sreport__nightlyReport',
        },
      },
    });
  });
});
