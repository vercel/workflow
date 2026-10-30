import {
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  extractWorkflowManifestComment,
  findUnregisteredWorkflows,
  formatUnregisteredWorkflows,
  getManifestWorkflowIds,
  readWorkflowAppGraph,
  recordWorkflowAppGraphEntry,
  resetWorkflowAppGraph,
} from './app-graph.js';
import type { WorkflowManifest } from './apply-swc-transform.js';

const realTmpdir = realpathSync(tmpdir());

/** The manifest comment the SWC plugin appends to a transformed module. */
function sentinel(manifest: WorkflowManifest): string {
  return `/**__internal_workflows${JSON.stringify(manifest)}*/`;
}

function manifestFor(
  file: string,
  names: Record<string, string>
): WorkflowManifest {
  return {
    workflows: {
      [file]: Object.fromEntries(
        Object.entries(names).map(([name, workflowId]) => [
          name,
          { workflowId },
        ])
      ),
    },
  };
}

describe('workflow app graph', () => {
  let appGraphDir: string;

  beforeEach(() => {
    appGraphDir = join(
      mkdtempSync(join(realTmpdir, 'workflow-app-graph-')),
      'app-graph'
    );
  });

  afterEach(() => {
    rmSync(appGraphDir, { recursive: true, force: true });
  });

  describe('extractWorkflowManifestComment', () => {
    it('reads the manifest the transform emitted', () => {
      const manifest = manifestFor('workflows/order.ts', {
        order: 'workflow//./workflows/order//order',
      });

      expect(
        extractWorkflowManifestComment(
          `export function order() {}\n${sentinel(manifest)};\n`
        )
      ).toEqual(manifest);
    });

    it('reads nothing from a module that declared nothing', () => {
      expect(extractWorkflowManifestComment('export const x = 1;\n')).toEqual(
        {}
      );
    });

    it('reads nothing from a sentinel whose payload is malformed', () => {
      expect(
        extractWorkflowManifestComment('/**__internal_workflows{broken*/')
      ).toEqual({});
    });

    // The whole reason the app graph is recorded from the compiler rather than
    // scanned out of build output: shipped bundles are not comment-stripped,
    // and documentation, code-generation templates and test fixtures quote the
    // emit shape. None of that can produce an entry here.
    // Guards the one way this can silently stop working: if the sentinel
    // moves or changes shape, nothing is ever recorded and the comparison
    // quietly covers nothing. Runs the real transform rather than a fixture.
    it('reads back what a real transform emitted', async () => {
      const { applySwcTransform } = await import('./apply-swc-transform.js');
      const { code } = await applySwcTransform(
        'workflows/order.ts',
        `export async function order() {
  'use workflow';
  return 'ok';
}
`,
        'step'
      );

      expect(
        getManifestWorkflowIds(extractWorkflowManifestComment(code))
      ).toEqual(['workflow//./workflows/order//order']);
    });

    it('reads nothing from workflow ids written in comments or strings', () => {
      const code = `/**
 * @param name - e.g. "workflow//./src/jobs/order//processOrder"
 *   or 'workflow//mypackage@1.0.0//processOrder'.
 */
// order.workflowId = "workflow//./workflows/order//order";
const template = 'order.workflowId = "workflow//./workflows/order//order";';
const alsoNot = '{"workflowId":"workflow//./workflows/order//order"}';
export { template, alsoNot };
`;

      expect(extractWorkflowManifestComment(code)).toEqual({});
    });
  });

  describe('getManifestWorkflowIds', () => {
    it('flattens ids across files and function names', () => {
      expect(
        getManifestWorkflowIds({
          workflows: {
            'a.ts': { one: { workflowId: 'workflow//./a//one' } },
            'b.ts': {
              two: { workflowId: 'workflow//./b//two' },
              three: { workflowId: 'workflow//./b//three' },
            },
          },
        })
      ).toEqual([
        'workflow//./a//one',
        'workflow//./b//two',
        'workflow//./b//three',
      ]);
    });

    it('reads an absent or empty manifest as nothing', () => {
      expect(getManifestWorkflowIds(undefined)).toEqual([]);
      expect(getManifestWorkflowIds({})).toEqual([]);
    });
  });

  describe('recording and reading back', () => {
    const record = (file: string, manifest: WorkflowManifest) =>
      recordWorkflowAppGraphEntry({ appGraphDir, file, manifest });

    it('maps each recorded id to the modules declaring it', async () => {
      await record(
        '/app/workflows/order.ts',
        manifestFor('workflows/order.ts', {
          order: 'workflow//./workflows/order//order',
        })
      );
      await record(
        '/app/workflows/mail.ts',
        manifestFor('workflows/mail.ts', {
          mail: 'workflow//./workflows/mail//mail',
        })
      );

      await expect(readWorkflowAppGraph(appGraphDir)).resolves.toEqual(
        new Map([
          ['workflow//./workflows/order//order', ['/app/workflows/order.ts']],
          ['workflow//./workflows/mail//mail', ['/app/workflows/mail.ts']],
        ])
      );
    });

    it('writes nothing for a module that declares no workflows', async () => {
      await record('/app/page.tsx', {});
      await record('/app/steps.ts', {
        steps: { 'steps.ts': { charge: { stepId: 'step//./steps//charge' } } },
      });

      expect(existsSync(appGraphDir) ? readdirSync(appGraphDir) : []).toEqual(
        []
      );
    });

    it('keeps one entry per module when the same module is transformed twice', async () => {
      const manifest = manifestFor('workflows/order.ts', {
        order: 'workflow//./workflows/order//order',
      });
      await record('/app/workflows/order.ts', manifest);
      await record('/app/workflows/order.ts', manifest);

      expect(readdirSync(appGraphDir)).toHaveLength(1);
      await expect(readWorkflowAppGraph(appGraphDir)).resolves.toEqual(
        new Map([
          ['workflow//./workflows/order//order', ['/app/workflows/order.ts']],
        ])
      );
    });

    it('reads nothing when nothing was ever recorded', async () => {
      await expect(readWorkflowAppGraph(appGraphDir)).resolves.toEqual(
        new Map()
      );
    });

    it('skips entries it cannot parse rather than failing the read', async () => {
      await record(
        '/app/workflows/order.ts',
        manifestFor('workflows/order.ts', {
          order: 'workflow//./workflows/order//order',
        })
      );
      writeFileSync(join(appGraphDir, 'broken.json'), '{not json', 'utf-8');
      writeFileSync(join(appGraphDir, 'unrelated.txt'), 'ignored', 'utf-8');

      await expect(readWorkflowAppGraph(appGraphDir)).resolves.toEqual(
        new Map([
          ['workflow//./workflows/order//order', ['/app/workflows/order.ts']],
        ])
      );
    });
  });

  describe('resetWorkflowAppGraph', () => {
    // A build records into an empty directory, so an entry can only describe a
    // module this build transformed. That is what makes a missing entry the
    // worst case rather than a wrong one.
    it('drops what an earlier build recorded', async () => {
      await recordWorkflowAppGraphEntry({
        appGraphDir,
        file: '/app/workflows/removed.ts',
        manifest: manifestFor('workflows/removed.ts', {
          removed: 'workflow//./workflows/removed//removed',
        }),
      });

      await resetWorkflowAppGraph(appGraphDir);

      expect(readdirSync(appGraphDir)).toEqual([]);
      await expect(readWorkflowAppGraph(appGraphDir)).resolves.toEqual(
        new Map()
      );
    });

    it('creates the directory when there was none', async () => {
      await resetWorkflowAppGraph(appGraphDir);

      expect(existsSync(appGraphDir)).toBe(true);
    });
  });

  describe('findUnregisteredWorkflows', () => {
    const appGraph = (entries: Record<string, string[]>) =>
      new Map(Object.entries(entries));

    it('finds nothing when every compiled workflow is registered', () => {
      expect(
        findUnregisteredWorkflows({
          appGraph: appGraph({
            'workflow//./workflows/order//order': ['/app/workflows/order.ts'],
          }),
          manifest: manifestFor('workflows/order.ts', {
            order: 'workflow//./workflows/order//order',
          }),
        })
      ).toEqual([]);
    });

    it('reports a compiled workflow the manifest does not register', () => {
      expect(
        findUnregisteredWorkflows({
          appGraph: appGraph({
            'workflow//./workflows/order//order': ['/app/workflows/order.ts'],
            'workflow//./workflows/mail//mail': ['/app/workflows/mail.ts'],
          }),
          manifest: manifestFor('workflows/order.ts', {
            order: 'workflow//./workflows/order//order',
          }),
          workingDir: '/app',
        })
      ).toEqual([
        {
          workflowId: 'workflow//./workflows/mail//mail',
          files: ['workflows/mail.ts'],
        },
      ]);
    });

    it('reports every compiled workflow when the manifest registered none', () => {
      expect(
        findUnregisteredWorkflows({
          appGraph: appGraph({
            'workflow//./w//b': ['/app/b.ts'],
            'workflow//./w//a': ['/app/a.ts'],
          }),
          manifest: {},
          workingDir: '/app',
        })
      ).toMatchObject([
        { workflowId: 'workflow//./w//a' },
        { workflowId: 'workflow//./w//b' },
      ]);
    });

    it('deduplicates and sorts the modules it names', () => {
      expect(
        findUnregisteredWorkflows({
          appGraph: appGraph({
            'workflow//./w//a': ['/app/z.ts', '/app/a.ts', '/app/z.ts'],
          }),
          manifest: {},
          workingDir: '/app',
        })
      ).toEqual([{ workflowId: 'workflow//./w//a', files: ['a.ts', 'z.ts'] }]);
    });

    it('keeps an absolute path for a module outside the app', () => {
      expect(
        findUnregisteredWorkflows({
          appGraph: appGraph({
            'workflow//pkg@1.0.0//a': ['/elsewhere/pkg/a.ts'],
          }),
          manifest: {},
          workingDir: '/app',
        })
      ).toEqual([
        {
          workflowId: 'workflow//pkg@1.0.0//a',
          files: ['/elsewhere/pkg/a.ts'],
        },
      ]);
    });
  });

  describe('formatUnregisteredWorkflows', () => {
    it('names each workflow and where it was declared', () => {
      const message = formatUnregisteredWorkflows([
        {
          workflowId: 'workflow//./workflows/mail//mail',
          files: ['workflows/mail.ts'],
        },
      ]);

      expect(message).toContain(
        '1 workflow is compiled into this app but not registered in this build'
      );
      expect(message).toContain('workflow//./workflows/mail//mail');
      expect(message).toContain('declared in workflows/mail.ts');
      expect(message).toContain('WorkflowNotRegisteredError');
    });

    it('pluralizes for more than one workflow', () => {
      expect(
        formatUnregisteredWorkflows([
          { workflowId: 'workflow//./a//a', files: ['a.ts'] },
          { workflowId: 'workflow//./b//b', files: ['b.ts'] },
        ])
      ).toContain('2 workflows are compiled into this app');
    });

    // One unreachable module can declare dozens of workflows that share a
    // cause, so the list identifies the module rather than being read whole.
    it('counts them all but lists only the first ten', () => {
      const message = formatUnregisteredWorkflows(
        Array.from({ length: 13 }, (_unused, index) => ({
          workflowId: `workflow//./w//w${index}`,
          files: ['w.ts'],
        }))
      );

      expect(message).toContain('13 workflows are compiled into this app');
      expect(message).toContain('workflow//./w//w9');
      expect(message).not.toContain('workflow//./w//w10');
      expect(message).toContain('…and 3 more workflows.');
    });
  });
});
