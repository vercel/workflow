import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APP_GRAPH_DIR_ENV,
  APP_GRAPH_MANIFEST_ENV,
  armWorkflowAppGraph,
  assertWorkflowsAreRegistered,
  recordTransformedWorkflows,
  resolveAppGraphDir,
  resolveRegistrationCheckMode,
} from './app-graph.js';
import type { WorkflowManifest } from './apply-swc-transform.js';

const realTmpdir = realpathSync(tmpdir());

/** A module as the transform leaves it: code plus the manifest sentinel. */
function transformed(file: string, workflowIds: string[]): string {
  const manifest: WorkflowManifest = {
    workflows: {
      [file]: Object.fromEntries(
        workflowIds.map((workflowId, index) => [
          `workflow${index}`,
          { workflowId },
        ])
      ),
    },
  };
  return `export const x = 1;\n/**__internal_workflows${JSON.stringify(manifest)}*/\n`;
}

describe('registration check', () => {
  let projectDir: string;
  let appGraphDir: string;
  let manifestPath: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  const REGISTERED = 'workflow//./workflows/order//order';
  const UNREGISTERED = 'workflow//./workflows/mail//mail';

  beforeEach(() => {
    projectDir = mkdtempSync(join(realTmpdir, 'workflow-registration-'));
    appGraphDir = resolveAppGraphDir(projectDir);
    manifestPath = join(projectDir, 'manifest.json');
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    delete process.env[APP_GRAPH_DIR_ENV];
    delete process.env[APP_GRAPH_MANIFEST_ENV];
    delete process.env.WORKFLOW_REGISTRATION_CHECK;
    delete process.env.WORKFLOW_DISCOVER_NODE_MODULES;
    writeManifest([REGISTERED]);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    delete process.env[APP_GRAPH_DIR_ENV];
    delete process.env[APP_GRAPH_MANIFEST_ENV];
    delete process.env.WORKFLOW_REGISTRATION_CHECK;
    delete process.env.WORKFLOW_DISCOVER_NODE_MODULES;
    rmSync(projectDir, { recursive: true, force: true });
  });

  function writeManifest(workflowIds: string[]): void {
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(
      manifestPath,
      JSON.stringify({
        workflows: {
          'workflows/order.ts': Object.fromEntries(
            workflowIds.map((workflowId, index) => [
              `workflow${index}`,
              { workflowId },
            ])
          ),
        },
      }),
      'utf-8'
    );
  }

  /** Arm, record one module, then check — one whole build in miniature. */
  const build = async (workflowIds: string[]) => {
    await armWorkflowAppGraph({ appGraphDir, isDevelopment: false });
    process.env[APP_GRAPH_MANIFEST_ENV] = manifestPath;
    await recordTransformedWorkflows({
      file: join(projectDir, 'workflows/declared.ts'),
      code: transformed('workflows/declared.ts', workflowIds),
    });
    return assertWorkflowsAreRegistered({ workingDir: projectDir });
  };

  describe('arming', () => {
    it('empties what an earlier build recorded', async () => {
      await armWorkflowAppGraph({ appGraphDir, isDevelopment: false });
      await recordTransformedWorkflows({
        file: join(projectDir, 'workflows/removed.ts'),
        code: transformed('workflows/removed.ts', [UNREGISTERED]),
      });
      expect(readdirSync(appGraphDir)).toHaveLength(1);

      // A second build in a fresh process starts clean.
      delete process.env[APP_GRAPH_DIR_ENV];
      await armWorkflowAppGraph({ appGraphDir, isDevelopment: false });

      expect(readdirSync(appGraphDir)).toEqual([]);
    });

    // The client and server passes, and SvelteKit's worker threads, all arm.
    // Resetting per pass would wipe what the previous one recorded.
    it('keeps records across repeated arming in one build', async () => {
      await armWorkflowAppGraph({ appGraphDir, isDevelopment: false });
      await recordTransformedWorkflows({
        file: join(projectDir, 'workflows/a.ts'),
        code: transformed('workflows/a.ts', [REGISTERED]),
      });

      await armWorkflowAppGraph({ appGraphDir, isDevelopment: false });

      expect(readdirSync(appGraphDir)).toHaveLength(1);
    });

    it('arms nothing for a development build', async () => {
      await armWorkflowAppGraph({ appGraphDir, isDevelopment: true });

      expect(process.env[APP_GRAPH_DIR_ENV]).toBeUndefined();
    });
  });

  describe('recording', () => {
    it('records nothing when no build armed a directory', async () => {
      await recordTransformedWorkflows({
        file: join(projectDir, 'workflows/order.ts'),
        code: transformed('workflows/order.ts', [REGISTERED]),
      });

      expect(process.env[APP_GRAPH_DIR_ENV]).toBeUndefined();
    });
  });

  describe('asserting', () => {
    it('passes when every compiled workflow is registered', async () => {
      await expect(build([REGISTERED])).resolves.toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('fails when the app can start an unregistered workflow', async () => {
      await expect(build([REGISTERED, UNREGISTERED])).rejects.toThrow(
        /not registered in this build[\s\S]*workflows\/mail\/\/mail/
      );
    });

    it('names WorkflowRegistrationError and points at discovery', async () => {
      const error = (await build([UNREGISTERED]).catch(
        (thrown: unknown) => thrown
      )) as Error;

      expect(error.name).toBe('WorkflowRegistrationError');
      expect(error.message).toContain('WORKFLOW_REGISTRATION_CHECK=warn');
    });

    it('says nothing when nothing was recorded', async () => {
      await armWorkflowAppGraph({ appGraphDir, isDevelopment: false });
      process.env[APP_GRAPH_MANIFEST_ENV] = manifestPath;

      await expect(
        assertWorkflowsAreRegistered({ workingDir: projectDir })
      ).resolves.toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('says nothing when no manifest was published', async () => {
      await armWorkflowAppGraph({ appGraphDir, isDevelopment: false });
      await recordTransformedWorkflows({
        file: join(projectDir, 'workflows/declared.ts'),
        code: transformed('workflows/declared.ts', [UNREGISTERED]),
      });

      await expect(
        assertWorkflowsAreRegistered({ workingDir: projectDir })
      ).resolves.toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    // Reading an unreadable manifest as "registered nothing" would report
    // every workflow in the app.
    it('says nothing when the manifest cannot be parsed', async () => {
      writeFileSync(manifestPath, '{"workflows": {', 'utf-8');

      await expect(build([UNREGISTERED])).resolves.toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    // A framework compiles in several passes and the plugin checks after each,
    // because it cannot know which is last.
    it('reports a finding once across repeated checks', async () => {
      process.env.WORKFLOW_REGISTRATION_CHECK = 'warn';
      const reportedWorkflowIds = new Set<string>();
      await armWorkflowAppGraph({ appGraphDir, isDevelopment: false });
      process.env[APP_GRAPH_MANIFEST_ENV] = manifestPath;
      await recordTransformedWorkflows({
        file: join(projectDir, 'workflows/declared.ts'),
        code: transformed('workflows/declared.ts', [UNREGISTERED]),
      });

      await assertWorkflowsAreRegistered({ reportedWorkflowIds });
      await assertWorkflowsAreRegistered({ reportedWorkflowIds });

      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('warns without failing under WORKFLOW_REGISTRATION_CHECK=warn', async () => {
      process.env.WORKFLOW_REGISTRATION_CHECK = 'warn';

      await expect(build([UNREGISTERED])).resolves.toBeUndefined();
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain(UNREGISTERED);
    });

    it.each([
      'off',
      '0',
      'false',
    ])('skips the check under WORKFLOW_REGISTRATION_CHECK=%s', async (value) => {
      process.env.WORKFLOW_REGISTRATION_CHECK = value;

      await expect(build([UNREGISTERED])).resolves.toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('resolveRegistrationCheckMode', () => {
    it('fails builds by default', () => {
      expect(resolveRegistrationCheckMode({})).toBe('error');
    });

    // Opting out of dependency discovery deliberately leaves a dependency's
    // workflows unregistered while the bundler still compiles them.
    it.each([
      '0',
      'false',
    ])('reports without failing when node_modules discovery is %s', (value) => {
      expect(
        resolveRegistrationCheckMode({
          WORKFLOW_DISCOVER_NODE_MODULES: value,
        })
      ).toBe('warn');
    });

    it('still fails for that opt-out when forced on', () => {
      expect(
        resolveRegistrationCheckMode({
          WORKFLOW_DISCOVER_NODE_MODULES: '0',
          WORKFLOW_REGISTRATION_CHECK: 'error',
        })
      ).toBe('error');
    });
  });
});
