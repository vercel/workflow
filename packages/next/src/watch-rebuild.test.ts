import { analyzeWorkflowSource as detectWorkflowPatterns } from '@workflow/builders';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  classifyRebuild,
  createRebuildScheduler,
  createSourceSnapshotFromSource,
  isSourceFile,
  type SourceSnapshot,
  sourceSnapshotsMatch,
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

  test('preserves file changes that arrive during a rebuild', async () => {
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

    schedule({ kind: 'files', files: ['/app/workflow.ts'] });
    await vi.advanceTimersByTimeAsync(100);

    schedule({ kind: 'files', files: ['/app/helper.ts'] });
    await vi.advanceTimersByTimeAsync(100);
    expect(onIdle).not.toHaveBeenCalled();
    firstBuild.resolve();
    await fullBuild.promise;
    await idle.promise;

    expect(requests).toEqual(['files', 'files']);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  test('lets a full rebuild replace pending file changes', async () => {
    vi.useFakeTimers();
    const rebuild = vi.fn(async () => {});
    const schedule = createRebuildScheduler(rebuild, () => {});

    schedule({ kind: 'files', files: ['/app/workflow.ts'] });
    schedule({ kind: 'full' });
    await vi.advanceTimersByTimeAsync(100);

    expect(rebuild).toHaveBeenCalledWith({ kind: 'full' });
  });
});

describe('watch-rebuild source snapshots', () => {
  test('only treats JavaScript and TypeScript files as source', () => {
    expect(isSourceFile('/app/workflow.ts')).toBe(true);
    expect(isSourceFile('/app/workflow.json')).toBe(false);
  });

  test('ignores directives inside comments', () => {
    const snapshot = createSourceSnapshotFromSource(
      `
// export async function commentedWorkflow() { 'use workflow'; }
/*
export async function commentedStep() { 'use step'; }
*/
`,
      detectWorkflowPatterns
    );

    expect(snapshot.hasUseWorkflow).toBe(false);
    expect(snapshot.hasUseStep).toBe(false);
  });

  test('detects files added or changed during a full rebuild', () => {
    const before = createSourceSnapshotFromSource(
      `export const value = 'before';\n`,
      detectWorkflowPatterns
    );
    const after = createSourceSnapshotFromSource(
      `export const value = 'after';\n`,
      detectWorkflowPatterns
    );

    expect(
      sourceSnapshotsMatch(
        new Map([['/app/workflow.ts', before]]),
        new Map([['/app/workflow.ts', after]])
      )
    ).toBe(false);
    expect(
      sourceSnapshotsMatch(
        new Map([['/app/workflow.ts', before]]),
        new Map([
          ['/app/workflow.ts', before],
          ['/app/helper.ts', before],
        ])
      )
    ).toBe(false);
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
    ).resolves.toEqual({ kind: 'full' });
  });

  test('non-source build inputs require full rediscovery', async () => {
    const buildInput = '/app/workflow.json';

    await expect(
      classifyRebuild({
        discoveredEntries: {
          discoveredSteps: new Set(),
          discoveredWorkflows: new Set(),
          discoveredSerdeFiles: new Set(),
          discoveredFiles: new Set([buildInput]),
        },
        files: [buildInput],
        inputFiles: [],
        parentHasChild: () => false,
        readSnapshot: async () => {
          throw new Error('Non-source inputs are not hot rebuilt');
        },
        sourceSnapshots: new Map(),
      })
    ).resolves.toEqual({ kind: 'full' });
  });

  test('skips byte-identical relevant notifications', async () => {
    const workflowFile = '/app/workflows/helper.ts';
    const source = "export const value = 'unchanged';\n";
    const snapshot = createSourceSnapshotFromSource(
      source,
      detectWorkflowPatterns
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
        readSnapshot: async () => snapshot,
        sourceSnapshots: new Map([[workflowFile, snapshot]]),
      })
    ).resolves.toEqual({ kind: 'skip', snapshots: new Map() });
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
    ).resolves.toEqual({ kind: 'full' });
  });

  test('hot rebuilds step body changes', async () => {
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
    ).resolves.toEqual({
      kind: 'hot',
      target: 'steps',
      snapshots: new Map([[stepFile, nextSnapshot]]),
    });
  });

  test('hot rebuilds serde body changes in both contexts', async () => {
    const serdeFile = '/app/workflows/value.ts';
    const previousSnapshot = createSourceSnapshotFromSource(
      `export class Value {
  static [Symbol.for('workflow-serialize')]() { return 'before'; }
}\n`,
      detectWorkflowPatterns
    );
    const nextSnapshot = createSourceSnapshotFromSource(
      `export class Value {
  static [Symbol.for('workflow-serialize')]() { return 'after'; }
}\n`,
      detectWorkflowPatterns
    );

    await expect(
      classifyRebuild({
        discoveredEntries: {
          discoveredSteps: new Set(),
          discoveredWorkflows: new Set(),
          discoveredSerdeFiles: new Set([serdeFile]),
          discoveredFiles: new Set([serdeFile]),
        },
        files: [serdeFile],
        inputFiles: [],
        parentHasChild: () => false,
        readSnapshot: async () => nextSnapshot,
        sourceSnapshots: new Map([[serdeFile, previousSnapshot]]),
      })
    ).resolves.toEqual({
      kind: 'hot',
      target: 'both',
      snapshots: new Map([[serdeFile, nextSnapshot]]),
    });
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
    ).resolves.toEqual({ kind: 'full' });
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
      target: 'workflows',
      snapshots: new Map([[helperFile, nextHelperSnapshot]]),
    });
  });
});
