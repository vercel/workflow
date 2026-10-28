import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findUnregisteredWorkflows,
  formatUnregisteredWorkflows,
  readRegisteredWorkflowIds,
} from './registration-check.js';

const realTmpdir = realpathSync(tmpdir());

/** `order.workflowId = "…"`, as the transform leaves it in the output. */
function assignment(workflowId: string): string {
  return `order.workflowId = ${JSON.stringify(workflowId)};\n`;
}

describe('workflow registration check', () => {
  let testRoot: string;
  let serverDir: string;
  let manifestPath: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(realTmpdir, 'workflow-registration-check-'));
    serverDir = join(testRoot, '.next', 'server');
    manifestPath = join(testRoot, 'app/.well-known/workflow/v1/manifest.json');
    mkdirSync(serverDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  function writeManifest(workflowIds: string[]): void {
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: '1.0.0',
        steps: {},
        workflows: {
          'workflows/order.ts': Object.fromEntries(
            workflowIds.map((workflowId, index) => [
              `workflow${index}`,
              { workflowId, graph: { nodes: [], edges: [] } },
            ])
          ),
        },
        classes: {},
      }),
      'utf-8'
    );
  }

  function writeOutput(relativePath: string, contents: string): string {
    const filePath = join(serverDir, relativePath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents, 'utf-8');
    return filePath;
  }

  const find = () => findUnregisteredWorkflows({ manifestPath, serverDir });

  describe('readRegisteredWorkflowIds', () => {
    it('returns undefined when no manifest was written', async () => {
      await expect(
        readRegisteredWorkflowIds(manifestPath)
      ).resolves.toBeUndefined();
    });

    it('reads every workflow id the manifest records', async () => {
      writeManifest(['workflow//./workflows/order//order']);

      await expect(readRegisteredWorkflowIds(manifestPath)).resolves.toEqual(
        new Set(['workflow//./workflows/order//order'])
      );
    });
  });

  describe('findUnregisteredWorkflows', () => {
    it('finds nothing when the workflow build did not run', async () => {
      writeOutput(
        'app/api/order/route.js',
        assignment('workflow//./workflows/order//order')
      );

      await expect(find()).resolves.toEqual([]);
    });

    it('finds nothing when every referenced workflow is registered', async () => {
      writeManifest(['workflow//./workflows/order//order']);
      writeOutput(
        'app/api/order/route.js',
        assignment('workflow//./workflows/order//order')
      );

      await expect(find()).resolves.toEqual([]);
    });

    it('reports a workflow the app can start but the build never registered', async () => {
      writeManifest(['workflow//./workflows/order//order']);
      writeOutput(
        'app/api/mail/route.js',
        assignment('workflow//./workflows/mail//mail')
      );

      await expect(find()).resolves.toEqual([
        {
          workflowId: 'workflow//./workflows/mail//mail',
          files: ['app/api/mail/route.js'],
        },
      ]);
    });

    it('lists every output file naming the workflow, sorted, walking nested directories', async () => {
      writeManifest([]);
      const reference = assignment('workflow//./workflows/mail//mail');
      writeOutput('pages/api/trigger.js', reference);
      writeOutput('chunks/572.js', reference);
      writeOutput('app/api/mail/route.js', reference);

      await expect(find()).resolves.toEqual([
        {
          workflowId: 'workflow//./workflows/mail//mail',
          files: [
            'app/api/mail/route.js',
            'chunks/572.js',
            'pages/api/trigger.js',
          ],
        },
      ]);
    });

    it('reads minified single-quoted assignments', async () => {
      writeManifest([]);
      writeOutput('chunks/1.js', `o.workflowId='workflow//./w/order//order'`);

      await expect(find()).resolves.toEqual([
        {
          workflowId: 'workflow//./w/order//order',
          files: ['chunks/1.js'],
        },
      ]);
    });

    it('sorts findings by workflow id', async () => {
      writeManifest([]);
      writeOutput(
        'chunks/1.js',
        assignment('workflow//./workflows/order//order') +
          assignment('workflow//./workflows/mail//mail')
      );

      await expect(find()).resolves.toMatchObject([
        { workflowId: 'workflow//./workflows/mail//mail' },
        { workflowId: 'workflow//./workflows/order//order' },
      ]);
    });

    // Shipped server bundles are not comment-stripped, and the SDK's own JSDoc
    // quotes example ids. Matching any `workflow//…` literal reported those as
    // references to workflows nobody ever wrote.
    it('ignores workflow ids quoted inside comments', async () => {
      writeManifest([]);
      writeOutput(
        'chunks/1.js',
        `/**
 * @param name - The workflow name to parse (e.g., "workflow//./src/jobs/order//processOrder"
 *   or "workflow//mypackage@1.0.0//processOrder").
 */
function parseWorkflowName(name) { return name; }
// see 'workflow//./workflows/order//order' for the shape
`
      );

      await expect(find()).resolves.toEqual([]);
    });

    it('ignores the transform\'s "__internal_workflows" manifest comment', async () => {
      writeManifest([]);
      writeOutput(
        'chunks/1.js',
        '/**__internal_workflows{"workflows":{"order.ts":{"order":{"workflowId":"workflow//./order//order"}}}}*/\n'
      );

      await expect(find()).resolves.toEqual([]);
    });

    it('only scans JavaScript output', async () => {
      writeManifest([]);
      const reference = assignment('workflow//./workflows/mail//mail');
      writeOutput('chunks/1.js.map', reference);
      writeOutput('app/page.js.nft.json', reference);
      writeOutput('build-manifest.json', reference);

      await expect(find()).resolves.toEqual([]);
    });

    it('survives a server directory that was never created', async () => {
      writeManifest([]);
      rmSync(serverDir, { recursive: true, force: true });

      await expect(find()).resolves.toEqual([]);
    });

    // A manifest that could not be written already fails the build where it is
    // created, so there is nothing to add by failing again over one that
    // cannot be read back.
    it('makes no finding from a manifest it cannot parse', async () => {
      mkdirSync(dirname(manifestPath), { recursive: true });
      writeFileSync(manifestPath, '{"workflows": {', 'utf-8');
      writeOutput('chunks/1.js', assignment('workflow//./w//w'));

      await expect(find()).resolves.toEqual([]);
    });

    describe('writtenAfter', () => {
      // A chunk an earlier build left behind can name a workflow the current
      // build no longer has. Reporting it would fail a build over output that
      // is not even part of it.
      const stale = (filePath: string, buildStartedAt: number) => {
        const staleSeconds = (buildStartedAt - 60_000) / 1000;
        utimesSync(filePath, staleSeconds, staleSeconds);
      };

      it('skips output written before the build started', async () => {
        writeManifest([]);
        const buildStartedAt = Date.now();
        const filePath = writeOutput(
          'chunks/1.js',
          assignment('workflow//./workflows/removed//removed')
        );
        stale(filePath, buildStartedAt);

        await expect(
          findUnregisteredWorkflows({
            manifestPath,
            serverDir,
            writtenAfter: buildStartedAt,
          })
        ).resolves.toEqual([]);
      });

      it('still reports output this build wrote', async () => {
        writeManifest([]);
        const buildStartedAt = Date.now() - 60_000;
        writeOutput(
          'chunks/1.js',
          assignment('workflow//./workflows/mail//mail')
        );

        await expect(
          findUnregisteredWorkflows({
            manifestPath,
            serverDir,
            writtenAfter: buildStartedAt,
          })
        ).resolves.toMatchObject([
          { workflowId: 'workflow//./workflows/mail//mail' },
        ]);
      });
    });
  });

  describe('formatUnregisteredWorkflows', () => {
    it('names each workflow and where it is referenced', () => {
      const message = formatUnregisteredWorkflows([
        {
          workflowId: 'workflow//./workflows/mail//mail',
          files: ['app/api/mail/route.js', 'chunks/572.js'],
        },
      ]);

      expect(message).toContain(
        '1 workflow is referenced by this app but not registered in this build'
      );
      expect(message).toContain('workflow//./workflows/mail//mail');
      expect(message).toContain('referenced in app/api/mail/route.js');
      expect(message).toContain('referenced in chunks/572.js');
      expect(message).toContain('WorkflowNotRegisteredError');
    });

    it('pluralizes for more than one workflow', () => {
      const message = formatUnregisteredWorkflows([
        { workflowId: 'workflow//./a//a', files: ['chunks/1.js'] },
        { workflowId: 'workflow//./b//b', files: ['chunks/1.js'] },
      ]);

      expect(message).toContain(
        '2 workflows are referenced by this app but not registered in this build'
      );
    });

    // One unreachable file can hold dozens of workflows that all share a cause.
    it('counts them all but lists only the first ten', () => {
      const message = formatUnregisteredWorkflows(
        Array.from({ length: 13 }, (_unused, index) => ({
          workflowId: `workflow//./w//w${index}`,
          files: ['chunks/1.js'],
        }))
      );

      expect(message).toContain('13 workflows are referenced');
      expect(message).toContain('workflow//./w//w9');
      expect(message).not.toContain('workflow//./w//w10');
      expect(message).toContain('…and 3 more workflows.');
    });
  });
});
