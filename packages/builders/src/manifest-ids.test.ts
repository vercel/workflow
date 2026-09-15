import { describe, expect, it } from 'vitest';
import type { WorkflowManifest } from './apply-swc-transform.js';
import {
  hashManifestSource,
  type ManifestEntryLocation,
  mergeWorkflowManifest,
} from './manifest-ids.js';

function createMaps() {
  return {
    stepIds: new Map<string, ManifestEntryLocation>(),
    workflowIds: new Map<string, ManifestEntryLocation>(),
  };
}

function stepManifest(filePath: string, name: string, stepId: string) {
  return {
    steps: {
      [filePath]: {
        [name]: { stepId },
      },
    },
  } satisfies WorkflowManifest;
}

function workflowManifest(filePath: string, name: string, workflowId: string) {
  return {
    workflows: {
      [filePath]: {
        [name]: { workflowId },
      },
    },
  } satisfies WorkflowManifest;
}

const PEER_A_FILE =
  'node_modules/.pnpm/pkg@1.0.0_peer-a@1.0.0/node_modules/pkg/dist/steps.js';
const PEER_B_FILE =
  'node_modules/.pnpm/pkg@1.0.0_peer-b@2.0.0/node_modules/pkg/dist/steps.js';
const STEP_ID = 'step//pkg/steps@1.0.0//doWork';
const WORKFLOW_ID = 'workflow//pkg/steps@1.0.0//orchestrate';

describe('mergeWorkflowManifest duplicate ID handling', () => {
  it('throws when two different files emit the same step ID with different contents', () => {
    const { stepIds, workflowIds } = createMaps();
    const target: WorkflowManifest = {};

    mergeWorkflowManifest(
      target,
      stepManifest(PEER_A_FILE, 'doWork', STEP_ID),
      stepIds,
      workflowIds,
      hashManifestSource('export const doWork = 1;')
    );

    expect(() =>
      mergeWorkflowManifest(
        target,
        stepManifest(PEER_B_FILE, 'doWork', STEP_ID),
        stepIds,
        workflowIds,
        hashManifestSource('export const doWork = 2;')
      )
    ).toThrow(/Duplicate workflow step ID/);
  });

  it('deduplicates identical copies of the same module emitting the same step ID', () => {
    const { stepIds, workflowIds } = createMaps();
    const target: WorkflowManifest = {};
    const contentHash = hashManifestSource('export const doWork = 1;');

    mergeWorkflowManifest(
      target,
      stepManifest(PEER_A_FILE, 'doWork', STEP_ID),
      stepIds,
      workflowIds,
      contentHash
    );
    mergeWorkflowManifest(
      target,
      stepManifest(PEER_B_FILE, 'doWork', STEP_ID),
      stepIds,
      workflowIds,
      contentHash
    );

    // The first registration wins in the ID map...
    expect(stepIds.get(STEP_ID)?.filePath).toBe(PEER_A_FILE);
    // ...but both file entries stay in the manifest (both copies register
    // the same ID at runtime, which is harmless for identical code).
    expect(Object.keys(target.steps ?? {})).toEqual([PEER_A_FILE, PEER_B_FILE]);
  });

  it('deduplicates identical copies emitting the same workflow ID', () => {
    const { stepIds, workflowIds } = createMaps();
    const target: WorkflowManifest = {};
    const contentHash = hashManifestSource('export const orchestrate = 1;');

    mergeWorkflowManifest(
      target,
      workflowManifest(PEER_A_FILE, 'orchestrate', WORKFLOW_ID),
      stepIds,
      workflowIds,
      contentHash
    );
    expect(() =>
      mergeWorkflowManifest(
        target,
        workflowManifest(PEER_B_FILE, 'orchestrate', WORKFLOW_ID),
        stepIds,
        workflowIds,
        contentHash
      )
    ).not.toThrow();
    expect(workflowIds.get(WORKFLOW_ID)?.filePath).toBe(PEER_A_FILE);
  });

  it('throws when the same workflow ID comes from different contents', () => {
    const { stepIds, workflowIds } = createMaps();
    const target: WorkflowManifest = {};

    mergeWorkflowManifest(
      target,
      workflowManifest(PEER_A_FILE, 'orchestrate', WORKFLOW_ID),
      stepIds,
      workflowIds,
      hashManifestSource('a')
    );
    expect(() =>
      mergeWorkflowManifest(
        target,
        workflowManifest(PEER_B_FILE, 'orchestrate', WORKFLOW_ID),
        stepIds,
        workflowIds,
        hashManifestSource('b')
      )
    ).toThrow(/Duplicate workflow ID/);
  });

  it('throws when content hashes are unavailable, even for equal names', () => {
    const { stepIds, workflowIds } = createMaps();
    const target: WorkflowManifest = {};

    mergeWorkflowManifest(
      target,
      stepManifest(PEER_A_FILE, 'doWork', STEP_ID),
      stepIds,
      workflowIds
    );
    expect(() =>
      mergeWorkflowManifest(
        target,
        stepManifest(PEER_B_FILE, 'doWork', STEP_ID),
        stepIds,
        workflowIds
      )
    ).toThrow(/Duplicate workflow step ID/);
  });

  it('throws when identical contents map the same ID to different symbol names', () => {
    const { stepIds, workflowIds } = createMaps();
    const target: WorkflowManifest = {};
    const contentHash = hashManifestSource('shared');

    mergeWorkflowManifest(
      target,
      stepManifest(PEER_A_FILE, 'doWork', STEP_ID),
      stepIds,
      workflowIds,
      contentHash
    );
    expect(() =>
      mergeWorkflowManifest(
        target,
        stepManifest(PEER_B_FILE, 'doOtherWork', STEP_ID),
        stepIds,
        workflowIds,
        contentHash
      )
    ).toThrow(/Duplicate workflow step ID/);
  });

  it('allows re-merging the same file without error', () => {
    const { stepIds, workflowIds } = createMaps();
    const target: WorkflowManifest = {};
    const manifest = stepManifest(PEER_A_FILE, 'doWork', STEP_ID);
    const contentHash = hashManifestSource('export const doWork = 1;');

    mergeWorkflowManifest(target, manifest, stepIds, workflowIds, contentHash);
    expect(() =>
      mergeWorkflowManifest(target, manifest, stepIds, workflowIds, contentHash)
    ).not.toThrow();
  });
});
