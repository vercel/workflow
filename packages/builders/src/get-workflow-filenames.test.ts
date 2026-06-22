import { describe, expect, it } from 'vitest';
import {
  getWorkflowFilenamesFromManifest,
  type WorkflowManifest,
} from './apply-swc-transform.js';

describe('getWorkflowFilenamesFromManifest', () => {
  it('returns an empty array for a manifest with no workflows', () => {
    expect(getWorkflowFilenamesFromManifest({})).toEqual([]);
    expect(getWorkflowFilenamesFromManifest({ workflows: {} })).toEqual([]);
  });

  it('derives filenames from each workflowId module specifier', () => {
    const manifest: WorkflowManifest = {
      workflows: {
        './src/jobs/order.ts': {
          processOrder: {
            workflowId: 'workflow//./src/jobs/order//processOrder',
          },
        },
      },
    };
    expect(getWorkflowFilenamesFromManifest(manifest)).toEqual([
      './src/jobs/order',
    ]);
  });

  it('deduplicates filenames across multiple functions in the same file', () => {
    // Two workflow functions in the same source file share one module
    // specifier, so the precompile target is a single filename — not one per
    // function.
    const manifest: WorkflowManifest = {
      workflows: {
        './src/jobs/order.ts': {
          processOrder: {
            workflowId: 'workflow//./src/jobs/order//processOrder',
          },
          cancelOrder: {
            workflowId: 'workflow//./src/jobs/order//cancelOrder',
          },
        },
      },
    };
    expect(getWorkflowFilenamesFromManifest(manifest)).toEqual([
      './src/jobs/order',
    ]);
  });

  it('returns a sorted set across multiple files', () => {
    const manifest: WorkflowManifest = {
      workflows: {
        './src/b.ts': {
          b: { workflowId: 'workflow//./src/b//b' },
        },
        './src/a.ts': {
          a: { workflowId: 'workflow//./src/a//a' },
        },
      },
    };
    expect(getWorkflowFilenamesFromManifest(manifest)).toEqual([
      './src/a',
      './src/b',
    ]);
  });

  it('falls back to the raw workflowId when it is not a parseable name', () => {
    const manifest: WorkflowManifest = {
      workflows: {
        './src/weird.ts': {
          weird: { workflowId: 'not-a-workflow-name' },
        },
      },
    };
    expect(getWorkflowFilenamesFromManifest(manifest)).toEqual([
      'not-a-workflow-name',
    ]);
  });
});
