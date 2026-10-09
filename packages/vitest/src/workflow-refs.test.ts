import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearWorkflowRefCache,
  MANIFEST_FILENAME,
  readWorkflowRefs,
  selectWorkflowRef,
  type WorkflowRef,
} from './workflow-refs.js';

const tempDirs: string[] = [];

afterEach(async () => {
  clearWorkflowRefCache();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

async function writeManifest(contents: string | object): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'workflow-vitest-refs-'));
  tempDirs.push(dir);
  await writeFile(
    path.join(dir, MANIFEST_FILENAME),
    typeof contents === 'string' ? contents : JSON.stringify(contents)
  );
  return dir;
}

const refs: WorkflowRef[] = [
  {
    name: 'approvalWorkflow',
    file: 'workflows/approval.ts',
    workflowId: 'workflow//./workflows/approval//approvalWorkflow',
  },
  {
    name: 'approvalWorkflow',
    file: 'packages/billing/workflows/approval.ts',
    workflowId:
      'workflow//./packages/billing/workflows/approval//approvalWorkflow',
  },
  {
    name: 'ingestWorkflow',
    file: 'workflows/ingest.ts',
    workflowId: 'workflow//./workflows/ingest//ingestWorkflow',
  },
];

describe('selectWorkflowRef', () => {
  it('matches a unique exported name', () => {
    expect(selectWorkflowRef(refs, 'ingestWorkflow')).toBe(refs[2]);
  });

  it('matches a file-qualified name', () => {
    expect(
      selectWorkflowRef(refs, 'workflows/approval.ts#approvalWorkflow')
    ).toBe(refs[0]);
    expect(
      selectWorkflowRef(
        refs,
        'packages/billing/workflows/approval.ts#approvalWorkflow'
      )
    ).toBe(refs[1]);
  });

  it('matches the file part by path suffix, with or without ./', () => {
    expect(
      selectWorkflowRef(refs, 'billing/workflows/approval.ts#approvalWorkflow')
    ).toBe(refs[1]);
    expect(
      selectWorkflowRef(refs, './workflows/ingest.ts#ingestWorkflow')
    ).toBe(refs[2]);
  });

  it('asks for a file when a name is ambiguous', () => {
    expect(() => selectWorkflowRef(refs, 'approvalWorkflow')).toThrow(
      /matches 2 workflows[\s\S]*workflows\/approval\.ts#approvalWorkflow/
    );
  });

  it('lists the build and suggests near misses when nothing matches', () => {
    expect(() => selectWorkflowRef(refs, 'ingest')).toThrow(
      /Did you mean: workflows\/ingest\.ts#ingestWorkflow\?/
    );
    expect(() => selectWorkflowRef(refs, 'nope')).toThrow(
      /No workflow matching "nope"[\s\S]*Workflows in this build: [\s\S]*ingestWorkflow/
    );
    expect(() => selectWorkflowRef(refs, 'nope')).not.toThrow(/Did you mean/);
  });

  it('reports an empty build rather than pretending there are candidates', () => {
    expect(() => selectWorkflowRef([], 'anything')).toThrow(
      /Workflows in this build: \(none\)/
    );
  });
});

describe('readWorkflowRefs', () => {
  it('flattens the manifest into sorted refs', async () => {
    const outDir = await writeManifest({
      version: '1.0.0',
      steps: { 'workflows/approval.ts': { prepare: { stepId: 'step//x' } } },
      workflows: {
        'workflows/ingest.ts': {
          ingestWorkflow: {
            workflowId: 'workflow//./workflows/ingest//ingestWorkflow',
            graph: { nodes: [], edges: [] },
          },
        },
        'workflows/approval.ts': {
          approvalWorkflow: {
            workflowId: 'workflow//./workflows/approval//approvalWorkflow',
            graph: { nodes: [], edges: [] },
          },
        },
      },
    });

    expect(readWorkflowRefs(outDir)).toEqual([
      {
        name: 'approvalWorkflow',
        file: 'workflows/approval.ts',
        workflowId: 'workflow//./workflows/approval//approvalWorkflow',
      },
      {
        name: 'ingestWorkflow',
        file: 'workflows/ingest.ts',
        workflowId: 'workflow//./workflows/ingest//ingestWorkflow',
      },
    ]);
  });

  it('returns nothing for a build with no workflows', async () => {
    const outDir = await writeManifest({ version: '1.0.0', steps: {} });
    expect(readWorkflowRefs(outDir)).toEqual([]);
  });

  it('points at the plugin when the manifest is missing', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'workflow-vitest-refs-'));
    tempDirs.push(dir);

    expect(() => readWorkflowRefs(dir)).toThrow(
      /Workflow test manifest not found[\s\S]*buildWorkflowTests\(\)/
    );
  });

  it('reports a corrupt manifest', async () => {
    const outDir = await writeManifest('{ not json');
    expect(() => readWorkflowRefs(outDir)).toThrow(/is not valid JSON/);
  });
});
