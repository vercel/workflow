import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowManifest } from './apply-swc-transform.js';
import { BaseBuilder } from './base-builder.js';
import type { StandaloneConfig } from './types.js';

class TestBuilder extends BaseBuilder {
  async build(): Promise<void> {
    // no-op
  }

  public logProgress(...args: unknown[]): void {
    this.logBaseBuilderInfo(...args);
  }

  public createTestManifest(args: {
    workflowBundlePath: string;
    manifestDir: string;
    manifest: WorkflowManifest;
  }): Promise<string | undefined> {
    return this.createManifest(args);
  }
}

function createBuilder(workingDir: string): TestBuilder {
  const config: StandaloneConfig = {
    buildTarget: 'standalone',
    workingDir,
    dirs: ['.'],
    stepsBundlePath: join(workingDir, '.workflow', 'steps.js'),
    workflowsBundlePath: join(workingDir, '.workflow', 'workflows.js'),
    webhookBundlePath: join(workingDir, '.workflow', 'webhook.js'),
  };
  return new TestBuilder(config);
}

describe('base builder logging', () => {
  let testRoot: string;
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), 'workflow-builder-logging-'));
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    debugSpy.mockRestore();
    logSpy.mockRestore();
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('hides progress logs by default', () => {
    createBuilder(testRoot).logProgress('Created step registrations', '10ms');

    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('shows progress logs when DEBUG matches workflow:build', () => {
    vi.stubEnv('DEBUG', 'workflow:build');

    createBuilder(testRoot).logProgress('Created step registrations', '10ms');

    expect(debugSpy).toHaveBeenCalledWith(
      '[workflow:build] Created step registrations 10ms',
      ''
    );
  });

  it.each([
    'workflow:*',
    '*',
  ])('shows progress logs when DEBUG wildcard %s matches workflow:build', (debugPattern) => {
    vi.stubEnv('DEBUG', debugPattern);

    createBuilder(testRoot).logProgress('Created step registrations', '10ms');

    expect(debugSpy).toHaveBeenCalledWith(
      '[workflow:build] Created step registrations 10ms',
      ''
    );
  });

  it('hides progress logs when DEBUG negates workflow:build', () => {
    vi.stubEnv('DEBUG', 'workflow:*,-workflow:build');

    createBuilder(testRoot).logProgress('Created step registrations', '10ms');

    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('emits Next-like workflow compile summaries when manifests are created', async () => {
    const workflowBundlePath = join(testRoot, 'workflow.js');
    const manifestDir = join(testRoot, '.well-known/workflow/v1');
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(workflowBundlePath, '', 'utf-8');

    const builder = createBuilder(testRoot);
    const manifest: WorkflowManifest = {
      steps: {
        'src/workflow.ts': {
          stepOne: { stepId: 'step//src/workflow.ts//stepOne' },
          stepTwo: { stepId: 'step//src/workflow.ts//stepTwo' },
        },
      },
      workflows: {
        'src/workflow.ts': {
          run: { workflowId: 'workflow//src/workflow.ts//run' },
        },
      },
    };

    await builder.createTestManifest({
      workflowBundlePath,
      manifestDir,
      manifest,
    });
    await builder.createTestManifest({
      workflowBundlePath,
      manifestDir,
      manifest,
    });

    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy.mock.calls[0]?.[0]).toMatch(
      /^✓ Compiled workflows in \d+(?:ms|\.\d+s) \(2 steps, 1 workflow\)$/
    );
    expect(logSpy.mock.calls[1]?.[0]).toMatch(
      /^✓ Compiled workflows in \d+(?:ms|\.\d+s) \(2 steps, 1 workflow\)$/
    );
  });
});
