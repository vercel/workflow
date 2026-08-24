import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  applyBundlePatch,
  selectWorkflowCode,
  splitLines,
  type WorkflowCode,
} from './workflow-code.js';

describe('selectWorkflowCode', () => {
  it('preserves the legacy shared and per-workflow forms', () => {
    const cache = new Map<string, string>();

    expect(selectWorkflowCode('shared code', 'workflow-a', cache)).toBe(
      'shared code'
    );
    expect(
      selectWorkflowCode(
        { 'workflow-a': 'code a', 'workflow-b': 'code b' },
        'workflow-b',
        cache
      )
    ).toBe('code b');
  });

  it('selects and caches a gzip-compressed shard by workflow ID', () => {
    const compressed = gzipSync('workflow shard').toString('base64');
    const shards: WorkflowCode = {
      bundles: { 'bundle-0': compressed },
      workflowBundles: {
        'workflow-a': 'bundle-0',
        'workflow-b': 'bundle-0',
      },
      encoding: 'gzip-base64',
    };
    const cache = new Map<string, string>();

    expect(selectWorkflowCode(shards, 'workflow-b', cache)).toBe(
      'workflow shard'
    );
    expect(cache).toEqual(new Map([['bundle-0', 'workflow shard']]));
    expect(selectWorkflowCode(shards, 'missing', cache)).toBeUndefined();
  });
});

describe('splitLines and applyBundlePatch', () => {
  it('round-trips text with and without a trailing newline', () => {
    for (const text of ['', 'a', 'a\n', 'a\nb', 'a\nb\n', '\n\n']) {
      expect(splitLines(text).join('')).toBe(text);
    }
  });

  it('splices delete and insert ops at line positions', () => {
    const reference = splitLines('shared1\nunique-ref\nshared2\nshared3\n');
    expect(
      applyBundlePatch(reference, [
        { start: 1, deleteCount: 1, lines: ['unique-target\nextra\n'] },
      ])
    ).toBe('shared1\nunique-target\nextra\nshared2\nshared3\n');
  });
});

describe('selectWorkflowCode with delta-encoded shards', () => {
  it('reconstructs a patched shard from the reference and caches it', () => {
    const referenceCode = 'prefix\nref-workflow\nsuffix\n';
    const targetCode = 'prefix\ntarget-workflow\nsuffix\n';
    const shards: WorkflowCode = {
      bundles: { 'bundle-0': gzipSync(referenceCode).toString('base64') },
      workflowBundles: { 'workflow-ref': 'bundle-0', 'workflow-b': 'bundle-1' },
      encoding: 'gzip-base64',
      reference: 'bundle-0',
      patches: {
        'bundle-1': [
          { start: 1, deleteCount: 1, lines: ['target-workflow\n'] },
        ],
      },
    };
    const cache = new Map<string, string>();

    expect(selectWorkflowCode(shards, 'workflow-b', cache)).toBe(targetCode);
    expect(cache.get('bundle-1')).toBe(targetCode);
    expect(selectWorkflowCode(shards, 'workflow-ref', cache)).toBe(
      referenceCode
    );
    expect(selectWorkflowCode(shards, 'missing', cache)).toBeUndefined();
  });
});
