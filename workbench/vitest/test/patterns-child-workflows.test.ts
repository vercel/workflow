import { describe, expect, it } from 'vitest';
import { start } from 'workflow/api';
import {
  parentAllSettled,
  parentCatchesChildFailure,
} from '../workflows/drivers/child-workflows-drivers.js';
import { processDocumentBatch } from '../workflows/patterns/child-workflows-example.js';

describe('child-workflows', () => {
  it('startAndWait fans out over children and returns each value in order', async () => {
    const run = await start(processDocumentBatch, [
      ['doc-1', 'doc-2', 'doc-3'],
    ]);
    const result = await run.returnValue;

    expect(result.processed).toBe(3);
    expect(result.results.map((r: any) => r.documentId)).toEqual([
      'doc-1',
      'doc-2',
      'doc-3',
    ]);
    for (const entry of result.results as { summary: string }[]) {
      expect(entry.summary).toMatch(/^Summary: analysis of \d+ chars$/);
    }
  });

  it("a failing child rejects the parent's startAndWait with the child's error", async () => {
    const run = await start(parentCatchesChildFailure, ['boom']);
    const result = await run.returnValue;

    expect(result).toEqual({ caught: true, message: 'child boom failed' });
  });

  it('Promise.allSettled isolates one failing child among three', async () => {
    const run = await start(parentAllSettled, [['c1', 'c2', 'c3'], 'c2']);
    const result = await run.returnValue;

    expect(result).toEqual([
      { status: 'fulfilled', value: { id: 'c1', ok: true } },
      { status: 'rejected', message: 'child c2 failed' },
      { status: 'fulfilled', value: { id: 'c3', ok: true } },
    ]);
  });
});
