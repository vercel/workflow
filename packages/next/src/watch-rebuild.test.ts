import { describe, expect, test } from 'vitest';
import {
  classifyRebuild,
  createSourceSnapshotFromSource,
  extractImportSignature,
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
