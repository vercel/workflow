import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  classifyRebuild,
  createRebuildScheduler,
  createSourceSnapshotFromSource,
  extractImportSignature,
  type SourceSnapshot,
  stripCommentsFromSource,
} from './watch-rebuild.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('watch-rebuild scheduling', () => {
  test('merges changes until filesystem writes become quiet', async () => {
    vi.useFakeTimers();
    const rebuild = vi.fn(async () => {});
    const schedule = createRebuildScheduler(rebuild, () => {});

    schedule({
      kind: 'files',
      files: ['/app/workflow.ts'],
    });
    await vi.advanceTimersByTimeAsync(99);
    schedule({
      kind: 'files',
      files: ['/app/helper.ts'],
    });
    await vi.advanceTimersByTimeAsync(99);

    expect(rebuild).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(rebuild).toHaveBeenCalledWith({
      kind: 'files',
      files: ['/app/workflow.ts', '/app/helper.ts'],
    });
  });

  test('collapses full rebuild requests while a rebuild runs', async () => {
    vi.useFakeTimers();
    const firstBuild = Promise.withResolvers<void>();
    const fullBuild = Promise.withResolvers<void>();
    const idle = Promise.withResolvers<void>();
    const requests: string[] = [];
    const onIdle = vi.fn(idle.resolve);
    const schedule = createRebuildScheduler(async (request) => {
      requests.push(request.kind);
      if (requests.length === 1) {
        await firstBuild.promise;
      } else {
        fullBuild.resolve();
      }
    }, onIdle);

    schedule({ kind: 'full' });
    await vi.advanceTimersByTimeAsync(100);

    schedule({ kind: 'full' });
    schedule({ kind: 'full' });
    await vi.advanceTimersByTimeAsync(100);
    expect(onIdle).not.toHaveBeenCalled();
    firstBuild.resolve();
    await fullBuild.promise;
    await idle.promise;

    expect(requests).toEqual(['full', 'full']);
    expect(onIdle).toHaveBeenCalledOnce();
  });
});

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
        files: [registryFile],
        inputFiles: [pageFile],
        parentHasChild: () => false,
        readSnapshot: async (file) =>
          createSourceSnapshotFromSource(
            sources.get(file) ?? '',
            detectWorkflowPatterns
          ),
        sourceSnapshots,
      })
    ).resolves.toMatchObject({ kind: 'full' });
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
        files: [stepFile, registryFile],
        inputFiles: [registryFile],
        parentHasChild: () => false,
        readSnapshot: async (file) =>
          createSourceSnapshotFromSource(
            sources.get(file) ?? '',
            detectWorkflowPatterns
          ),
        sourceSnapshots: new Map(),
      })
    ).resolves.toMatchObject({ kind: 'full' });
  });

  test('suppresses duplicate notifications for an already-consumed write', async () => {
    const workflowFile = '/app/workflows/example.ts';
    const source = `export async function example() {
  'use workflow';
}
`;
    // Same content AND same mtime: a second watcher event for the same
    // write. Watchers routinely emit several events per edit.
    const snapshot = createSourceSnapshotFromSource(
      source,
      detectWorkflowPatterns,
      1000
    );

    await expect(
      classifyRebuild({
        discoveredEntries: {
          discoveredSteps: new Set(),
          discoveredWorkflows: new Set([workflowFile]),
          discoveredSerdeFiles: new Set(),
          discoveredFiles: new Set([workflowFile]),
        },
        files: [workflowFile],
        inputFiles: [workflowFile],
        parentHasChild: () => false,
        readSnapshot: async () => ({ ...snapshot }),
        sourceSnapshots: new Map([[workflowFile, snapshot]]),
      })
    ).resolves.toEqual({ kind: 'duplicate' });
  });

  test('fully rebuilds byte-identical rewrites of relevant files', async () => {
    const workflowFile = '/app/workflows/example.ts';
    const source = `export async function example() {
  'use workflow';
}
`;
    // Same content but a NEWER mtime: a distinct write whose interim states
    // an in-flight build may have consumed. Stays a conservative
    // invalidation.
    const previousSnapshot = createSourceSnapshotFromSource(
      source,
      detectWorkflowPatterns,
      1000
    );
    const rewrittenSnapshot = createSourceSnapshotFromSource(
      source,
      detectWorkflowPatterns,
      2000
    );

    await expect(
      classifyRebuild({
        discoveredEntries: {
          discoveredSteps: new Set(),
          discoveredWorkflows: new Set([workflowFile]),
          discoveredSerdeFiles: new Set(),
          discoveredFiles: new Set([workflowFile]),
        },
        files: [workflowFile],
        inputFiles: [workflowFile],
        parentHasChild: () => false,
        readSnapshot: async () => rewrittenSnapshot,
        sourceSnapshots: new Map([[workflowFile, previousSnapshot]]),
      })
    ).resolves.toMatchObject({ kind: 'full' });
  });

  test('carries classifier reads on full decisions to seed new-file baselines', async () => {
    const addedStepFile = '/app/workflows/added-step.ts';
    const snapshot = createSourceSnapshotFromSource(
      `export async function addedStep() {
  'use step';
}
`,
      detectWorkflowPatterns,
      1000
    );

    await expect(
      classifyRebuild({
        discoveredEntries: {
          discoveredSteps: new Set(),
          discoveredWorkflows: new Set(),
          discoveredSerdeFiles: new Set(),
          discoveredFiles: new Set(),
        },
        files: [addedStepFile],
        inputFiles: [],
        parentHasChild: () => false,
        readSnapshot: async () => snapshot,
        sourceSnapshots: new Map(),
      })
    ).resolves.toEqual({
      kind: 'full',
      snapshots: new Map([[addedStepFile, snapshot]]),
    });
  });

  test('tracks irrelevant files so their duplicate notifications suppress', async () => {
    const unrelatedFile = '/app/scripts/unrelated.ts';
    const snapshot = createSourceSnapshotFromSource(
      'export const unrelated = true;\n',
      detectWorkflowPatterns,
      1000
    );
    const sourceSnapshots = new Map<string, SourceSnapshot>();
    const discoveredEntries = {
      discoveredSteps: new Set<string>(),
      discoveredWorkflows: new Set<string>(),
      discoveredSerdeFiles: new Set<string>(),
      discoveredFiles: new Set<string>(),
    };

    const firstDecision = await classifyRebuild({
      discoveredEntries,
      files: [unrelatedFile],
      inputFiles: [],
      parentHasChild: () => false,
      readSnapshot: async () => snapshot,
      sourceSnapshots,
    });
    expect(firstDecision).toEqual({
      kind: 'skip',
      snapshots: new Map([[unrelatedFile, snapshot]]),
    });
    if (firstDecision.kind === 'skip') {
      for (const [file, value] of firstDecision.snapshots) {
        sourceSnapshots.set(file, value);
      }
    }

    await expect(
      classifyRebuild({
        discoveredEntries,
        files: [unrelatedFile],
        inputFiles: [],
        parentHasChild: () => false,
        readSnapshot: async () => ({ ...snapshot }),
        sourceSnapshots,
      })
    ).resolves.toEqual({ kind: 'duplicate' });
  });

  test('drops duplicates from a batch while rebuilding real changes', async () => {
    const helperFile = '/app/workflows/helper.ts';
    const workflowFile = '/app/workflows/workflow.ts';
    const workflowSource = `export async function example() {
  'use workflow';
}
`;
    const workflowSnapshot = createSourceSnapshotFromSource(
      workflowSource,
      detectWorkflowPatterns,
      1000
    );
    const previousHelperSnapshot = createSourceSnapshotFromSource(
      "export const value = 'before';\n",
      detectWorkflowPatterns,
      1000
    );
    const nextHelperSnapshot = createSourceSnapshotFromSource(
      "export const value = 'after';\n",
      detectWorkflowPatterns,
      2000
    );

    await expect(
      classifyRebuild({
        discoveredEntries: {
          discoveredSteps: new Set(),
          discoveredWorkflows: new Set([workflowFile]),
          discoveredSerdeFiles: new Set(),
          discoveredFiles: new Set([helperFile, workflowFile]),
        },
        files: [workflowFile, helperFile],
        inputFiles: [workflowFile],
        parentHasChild: (parent, child) =>
          parent === workflowFile && child === helperFile,
        readSnapshot: async (file) =>
          file === workflowFile ? { ...workflowSnapshot } : nextHelperSnapshot,
        sourceSnapshots: new Map([
          [workflowFile, workflowSnapshot],
          [helperFile, previousHelperSnapshot],
        ]),
      })
    ).resolves.toEqual({
      kind: 'hot',
      refreshStepRegistrations: false,
      snapshots: new Map([[helperFile, nextHelperSnapshot]]),
    });
  });

  test('rebuilds relevant files without snapshots', async () => {
    const helperFile = '/app/workflows/helper.ts';

    await expect(
      classifyRebuild({
        discoveredEntries: {
          discoveredSteps: new Set(),
          discoveredWorkflows: new Set(),
          discoveredSerdeFiles: new Set(),
          discoveredFiles: new Set([helperFile]),
        },
        files: [helperFile],
        inputFiles: [],
        parentHasChild: () => false,
        readSnapshot: async () =>
          createSourceSnapshotFromSource(
            "export const value = 'helper';\n",
            detectWorkflowPatterns
          ),
        sourceSnapshots: new Map(),
      })
    ).resolves.toMatchObject({ kind: 'full' });
  });

  test('fully rebuilds every directive file change', async () => {
    const stepFile = '/app/workflows/step.ts';
    const previousSnapshot = createSourceSnapshotFromSource(
      `export let example = async () => {
  'use step';
  return 'before';
};
`,
      detectWorkflowPatterns
    );
    const nextSnapshot = createSourceSnapshotFromSource(
      `export let example = async () => {
  'use step';
  return 'after';
};
`,
      detectWorkflowPatterns
    );

    await expect(
      classifyRebuild({
        discoveredEntries: {
          discoveredSteps: new Set([stepFile]),
          discoveredWorkflows: new Set(),
          discoveredSerdeFiles: new Set(),
          discoveredFiles: new Set([stepFile]),
        },
        files: [stepFile],
        inputFiles: [],
        parentHasChild: () => false,
        readSnapshot: async () => nextSnapshot,
        sourceSnapshots: new Map([[stepFile, previousSnapshot]]),
      })
    ).resolves.toMatchObject({ kind: 'full' });
  });

  test('rebuilds new files that can introduce graph entries', async () => {
    const routeFile = '/app/app/new/route.ts';

    await expect(
      classifyRebuild({
        discoveredEntries: {
          discoveredSteps: new Set(),
          discoveredWorkflows: new Set(),
          discoveredSerdeFiles: new Set(),
          discoveredFiles: new Set(),
        },
        files: [routeFile],
        inputFiles: [],
        parentHasChild: () => false,
        readSnapshot: async () =>
          createSourceSnapshotFromSource(
            "import './workflow';\n",
            detectWorkflowPatterns
          ),
        sourceSnapshots: new Map(),
      })
    ).resolves.toMatchObject({ kind: 'full' });
  });

  test('hot rebuilds body changes used by workflows', async () => {
    const helperFile = '/app/workflows/helper.ts';
    const workflowFile = '/app/workflows/workflow.ts';
    const previousHelperSnapshot = createSourceSnapshotFromSource(
      "export const value = 'before';\n",
      detectWorkflowPatterns
    );
    const nextHelperSnapshot = createSourceSnapshotFromSource(
      "export const value = 'after';\n",
      detectWorkflowPatterns
    );
    await expect(
      classifyRebuild({
        discoveredEntries: {
          discoveredSteps: new Set(),
          discoveredWorkflows: new Set([workflowFile]),
          discoveredSerdeFiles: new Set(),
          discoveredFiles: new Set([helperFile, workflowFile]),
        },
        files: [helperFile],
        inputFiles: [workflowFile],
        parentHasChild: (parent, child) =>
          parent === workflowFile && child === helperFile,
        readSnapshot: async () => nextHelperSnapshot,
        sourceSnapshots: new Map([[helperFile, previousHelperSnapshot]]),
      })
    ).resolves.toEqual({
      kind: 'hot',
      refreshStepRegistrations: false,
      snapshots: new Map([[helperFile, nextHelperSnapshot]]),
    });
  });
});
