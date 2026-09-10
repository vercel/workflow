import { describe, expect, test } from 'vitest';
import {
  classifyRebuild,
  createSourceSnapshotFromSource,
  extractImportSignature,
  pinBaselinesAcrossFullRebuild,
  type SourceSnapshot,
  stripCommentsFromSource,
} from './watch-rebuild.js';

const detectWorkflowPatterns = (source: string) => ({
  hasDirective:
    source.includes("'use workflow'") ||
    source.includes('"use workflow"') ||
    source.includes("'use step'") ||
    source.includes('"use step"'),
  hasSerde: /Symbol\.for\(['"]workflow-(?:serialize|deserialize)['"]\)/.test(
    source
  ),
});

describe('watch-rebuild source snapshots', () => {
  test('ignores imports inside line and block comments', () => {
    const source = stripCommentsFromSource(`
import * as active from './workflows/active';
// import * as commentedLine from './workflows/commented-line';
/*
import * as commentedBlock from './workflows/commented-block';
*/
`);

    expect(extractImportSignature(source)).toBe('./workflows/active');
  });

  test('does not treat regex literals as comments', () => {
    const source = stripCommentsFromSource(`
const commentStartChars = /[/*]/;
const protocol = /https?:\\/\\//;
import * as active from './workflows/active';
`);

    expect(extractImportSignature(source)).toBe('./workflows/active');
  });

  test('ignores workflow definitions inside comments', () => {
    const snapshot = createSourceSnapshotFromSource(
      `
// export async function commentedWorkflow() { 'use workflow'; }
/*
export async function commentedStep() { 'use step'; }
*/
export async function realWorkflow() {
  'use workflow';
}
`,
      detectWorkflowPatterns
    );

    expect(snapshot.definitionSignature).toBe('workflow:realWorkflow');
    expect(snapshot.hasDirective).toBe(true);
  });

  test('commenting out a registry import requires full rediscovery', async () => {
    const registryFile = '/app/_workflows.ts';
    const workflowFile = '/app/workflows/1_simple.ts';
    const pageFile = '/app/app/page.tsx';
    const initialRegistrySource = `import * as workflow_1_simple from './workflows/1_simple';

export const allWorkflows = {
  'workflows/1_simple.ts': workflow_1_simple,
} as const;
`;
    const sources = new Map<string, string>([
      [registryFile, initialRegistrySource],
    ]);
    const sourceSnapshots = new Map<string, SourceSnapshot>([
      [
        registryFile,
        createSourceSnapshotFromSource(
          initialRegistrySource,
          detectWorkflowPatterns
        ),
      ],
    ]);

    sources.set(
      registryFile,
      `// import * as workflow_1_simple from './workflows/1_simple';

export const allWorkflows = {
  'workflows/1_simple.ts': workflow_1_simple,
} as const;
`
    );

    await expect(
      classifyRebuild({
        discoveredEntries: {
          discoveredSteps: new Set(),
          discoveredWorkflows: new Set([workflowFile]),
          discoveredSerdeFiles: new Set(),
          discoveredFiles: new Set([pageFile, registryFile, workflowFile]),
        },
        fileChanges: {
          addedFiles: [],
          modifiedFiles: [registryFile],
          removedFiles: [],
        },
        inputFiles: [pageFile],
        parentHasChild: () => false,
        readSnapshot: async (file) =>
          createSourceSnapshotFromSource(
            sources.get(file) ?? '',
            detectWorkflowPatterns
          ),
        sourceSnapshots,
      })
    ).resolves.toEqual({ kind: 'full' });
  });

  test('modified registry import without previous snapshot requires full rediscovery', async () => {
    const registryFile = '/app/_workflows.ts';
    const stepFile = '/app/workflows/dev-test-step-change.ts';
    const registrySource = `import './workflows/dev-test-step-change';

export const allWorkflows = {} as const;
`;
    const sources = new Map<string, string>([[registryFile, registrySource]]);

    await expect(
      classifyRebuild({
        discoveredEntries: {
          discoveredSteps: new Set(),
          discoveredWorkflows: new Set(),
          discoveredSerdeFiles: new Set(),
          discoveredFiles: new Set([registryFile]),
        },
        fileChanges: {
          addedFiles: [stepFile],
          modifiedFiles: [registryFile],
          removedFiles: [],
        },
        inputFiles: [registryFile],
        parentHasChild: () => false,
        readSnapshot: async (file) =>
          createSourceSnapshotFromSource(
            sources.get(file) ?? '',
            detectWorkflowPatterns
          ),
        sourceSnapshots: new Map(),
      })
    ).resolves.toEqual({ kind: 'full' });
  });

  test('an edit landing during a full rebuild is not absorbed into the baseline', async () => {
    // Reproduces the flow-route HMR race: a step definition is added to an
    // already-discovered step file while a full rebuild is in flight. The
    // post-rebuild baseline refresh reads the file from disk (post-edit), so
    // without reconciliation the queued watcher event diffs the edit against
    // itself and classifies as a no-op — the added step never reaches the
    // manifest.
    const stepFile = '/app/workflows/hmr-fuzz-step.ts';
    const pageFile = '/app/app/page.tsx';
    const preBuildSource = `export async function hmrFuzzStep() {
  'use step';
  return 'step-value';
}
`;
    const postEditSource = `export async function hmrFuzzStep() {
  'use step';
  return 'step-value';
}

export async function hmrFuzzAddedStep() {
  'use step';
  return 'added-step';
}
`;
    const discoveredEntries = {
      discoveredSteps: new Set([stepFile]),
      discoveredWorkflows: new Set<string>(),
      discoveredSerdeFiles: new Set<string>(),
      discoveredFiles: new Set([pageFile, stepFile]),
    };
    const sources = new Map<string, string>([
      [stepFile, preBuildSource],
      [pageFile, ''],
    ]);
    const readSnapshot = async (file: string) =>
      createSourceSnapshotFromSource(
        sources.get(file) ?? '',
        detectWorkflowPatterns
      );

    const sourceSnapshots = new Map<string, SourceSnapshot>();

    // Full rebuild: the helper captures what the build reads before invoking
    // the rebuild; the edit lands mid-rebuild and the post-rebuild refresh
    // reads it from disk.
    await pinBaselinesAcrossFullRebuild({
      discoveredEntries,
      inputFiles: [pageFile],
      readSnapshot,
      sourceSnapshots,
      rebuild: async () => {
        sources.set(stepFile, postEditSource);
        sourceSnapshots.set(stepFile, await readSnapshot(stepFile));
        sourceSnapshots.set(pageFile, await readSnapshot(pageFile));
      },
    });

    // The queued watcher event for the edit must still trigger a rebuild.
    await expect(
      classifyRebuild({
        discoveredEntries,
        fileChanges: {
          addedFiles: [],
          modifiedFiles: [stepFile],
          removedFiles: [],
        },
        inputFiles: [pageFile],
        parentHasChild: () => false,
        readSnapshot,
        sourceSnapshots,
      })
    ).resolves.toEqual({ kind: 'full' });
  });

  test('a duplicate watcher event landing during a full rebuild stays a no-op', async () => {
    // Watchers routinely emit several events for one edit, and the edit that
    // triggered a full rebuild is itself a source of such stragglers landing
    // mid-rebuild. The straggler carries the same content the rebuild
    // consumed, so it must diff equal against the pinned pre-build baseline
    // and classify as 'none' — evicting the baseline instead cascades into
    // back-to-back full rebuilds.
    const stepFile = '/app/workflows/hmr-fuzz-step.ts';
    const pageFile = '/app/app/page.tsx';
    const source = `export async function hmrFuzzStep() {
  'use step';
  return 'step-value';
}
`;
    const discoveredEntries = {
      discoveredSteps: new Set([stepFile]),
      discoveredWorkflows: new Set<string>(),
      discoveredSerdeFiles: new Set<string>(),
      discoveredFiles: new Set([pageFile, stepFile]),
    };
    const sources = new Map<string, string>([
      [stepFile, source],
      [pageFile, ''],
    ]);
    const readSnapshot = async (file: string) =>
      createSourceSnapshotFromSource(
        sources.get(file) ?? '',
        detectWorkflowPatterns
      );

    // Full rebuild (triggered by the edit that wrote `source`): the helper's
    // capture reads that same content before the rebuild, and the refresh
    // reads it again after.
    const sourceSnapshots = new Map<string, SourceSnapshot>();
    await pinBaselinesAcrossFullRebuild({
      discoveredEntries,
      inputFiles: [pageFile],
      readSnapshot,
      sourceSnapshots,
      rebuild: async () => {
        sourceSnapshots.set(stepFile, await readSnapshot(stepFile));
        sourceSnapshots.set(pageFile, await readSnapshot(pageFile));
      },
    });

    // The baseline survives (pinned, not evicted), so the queued duplicate
    // classifies as a no-op instead of another full rebuild.
    expect(sourceSnapshots.has(stepFile)).toBe(true);
    const decision = await classifyRebuild({
      discoveredEntries,
      fileChanges: {
        addedFiles: [],
        modifiedFiles: [stepFile],
        removedFiles: [],
      },
      inputFiles: [pageFile],
      parentHasChild: () => false,
      readSnapshot,
      sourceSnapshots,
    });
    expect(decision.kind).toBe('none');
  });

  test('a file created mid-rebuild that the build missed still forces a follow-up rebuild', async () => {
    // A file the rebuild never discovered has no baseline after the
    // post-rebuild refresh either, so its queued add event classifies
    // conservatively — no eviction machinery required.
    const stepFile = '/app/workflows/newly-created-step.ts';
    const pageFile = '/app/app/page.tsx';
    const source = `export async function newStep() {
  'use step';
  return 'new-step';
}
`;
    const sources = new Map<string, string>([
      [stepFile, source],
      [pageFile, ''],
    ]);
    const readSnapshot = async (file: string) =>
      createSourceSnapshotFromSource(
        sources.get(file) ?? '',
        detectWorkflowPatterns
      );

    // The build that just finished never saw stepFile: it is in neither the
    // discovered entries nor the refreshed baseline.
    const sourceSnapshots = new Map<string, SourceSnapshot>();
    await pinBaselinesAcrossFullRebuild({
      discoveredEntries: {
        discoveredSteps: new Set<string>(),
        discoveredWorkflows: new Set<string>(),
        discoveredSerdeFiles: new Set<string>(),
        discoveredFiles: new Set([pageFile]),
      },
      inputFiles: [pageFile],
      readSnapshot,
      sourceSnapshots,
      rebuild: async () => {
        sourceSnapshots.set(pageFile, await readSnapshot(pageFile));
      },
    });

    await expect(
      classifyRebuild({
        discoveredEntries: {
          discoveredSteps: new Set<string>(),
          discoveredWorkflows: new Set<string>(),
          discoveredSerdeFiles: new Set<string>(),
          discoveredFiles: new Set([pageFile]),
        },
        fileChanges: {
          addedFiles: [stepFile],
          modifiedFiles: [],
          removedFiles: [],
        },
        inputFiles: [pageFile],
        parentHasChild: () => false,
        readSnapshot,
        sourceSnapshots,
      })
    ).resolves.toEqual({ kind: 'full' });
  });

  test('ignores stale add events for already snapshotted files', async () => {
    const stepFile = '/app/workflows/hmr-fuzz-step.ts';
    const pageFile = '/app/app/page.tsx';
    const stepSource = `export async function hmrFuzzStep() {
  'use step';
  return 'step-value';
}
`;
    const sourceSnapshots = new Map<string, SourceSnapshot>([
      [
        stepFile,
        createSourceSnapshotFromSource(stepSource, detectWorkflowPatterns),
      ],
    ]);

    const decision = await classifyRebuild({
      discoveredEntries: {
        discoveredSteps: new Set([stepFile]),
        discoveredWorkflows: new Set(),
        discoveredSerdeFiles: new Set(),
        discoveredFiles: new Set([pageFile, stepFile]),
      },
      fileChanges: {
        addedFiles: [stepFile],
        modifiedFiles: [],
        removedFiles: [],
      },
      inputFiles: [pageFile],
      parentHasChild: () => false,
      readSnapshot: async () =>
        createSourceSnapshotFromSource(stepSource, detectWorkflowPatterns),
      sourceSnapshots,
    });

    expect(decision.kind).toBe('none');
  });
});
