import { decode, encode } from '@workflow/world-vercel/run-id';
import { monotonicFactory } from 'ulid';
import { describe, expect, it } from 'vitest';
import {
  regionalWebhookToken,
  resolveNewHookRegion,
  tagHookUlid,
  webhookTokenRegion,
} from './hook-region.js';

const ulid = monotonicFactory();
const regional = { hookRegions: true } as const;

describe('resolveNewHookRegion', () => {
  const cle1Run = `wrun_${encode(ulid(), 'cle1')}`;

  it('uses an explicit region', () => {
    expect(
      resolveNewHookRegion({
        region: 'fra1',
        isWebhook: false,
        runId: cle1Run,
        capabilities: regional,
      })
    ).toBe('fra1');
    expect(
      resolveNewHookRegion({
        region: 'fra1',
        isWebhook: true,
        runId: cle1Run,
        capabilities: regional,
      })
    ).toBe('fra1');
  });

  it("stores a webhook in its run's region by default", () => {
    expect(
      resolveNewHookRegion({
        region: undefined,
        isWebhook: true,
        runId: cle1Run,
        capabilities: regional,
      })
    ).toBe('cle1');
    // Untagged (legacy) runs live in iad1.
    expect(
      resolveNewHookRegion({
        region: undefined,
        isWebhook: true,
        runId: `wrun_${ulid()}`,
        capabilities: regional,
      })
    ).toBe('iad1');
    // An undecodable run ID leaves the webhook in the default region.
    expect(
      resolveNewHookRegion({
        region: undefined,
        isWebhook: true,
        runId: 'wrun_test',
        capabilities: regional,
      })
    ).toBeUndefined();
  });

  it('leaves a createHook() hook without a region in the default region', () => {
    expect(
      resolveNewHookRegion({
        region: undefined,
        isWebhook: false,
        runId: cle1Run,
        capabilities: regional,
      })
    ).toBeUndefined();
  });

  it('ignores region on Worlds without hookRegions', () => {
    for (const capabilities of [undefined, {}]) {
      expect(
        resolveNewHookRegion({
          region: 'fra1',
          isWebhook: true,
          runId: cle1Run,
          capabilities,
        })
      ).toBeUndefined();
      // Not even validated: the option means nothing there.
      expect(
        resolveNewHookRegion({
          region: 'nope',
          isWebhook: false,
          runId: cle1Run,
          capabilities,
        })
      ).toBeUndefined();
    }
  });

  it('rejects an unknown region', () => {
    for (const region of ['nope1', 'unknown', '', 'IAD1']) {
      expect(() =>
        resolveNewHookRegion({
          region,
          isWebhook: false,
          runId: cle1Run,
          capabilities: regional,
        })
      ).toThrow(/unknown `region`/);
    }
  });
});

describe('tagHookUlid', () => {
  it('region-tags the ULID with the run-ID encoding', () => {
    const raw = ulid();
    const tagged = tagHookUlid(raw, 'fra1');
    expect(tagged).not.toBe(raw);
    expect(decode(tagged)).toMatchObject({ tagged: true, region: 'fra1' });
    expect(tagHookUlid(raw, 'fra1')).toBe(tagged);
  });
});

describe('webhook tokens', () => {
  it('round-trips the region', () => {
    const token = regionalWebhookToken('cle1', 'V1StGXR8_Z5jdHi6B-myT');
    expect(token).toBe('wh.cle1.V1StGXR8_Z5jdHi6B-myT');
    expect(webhookTokenRegion(token)).toBe('cle1');
  });

  it('reads no region from legacy or malformed tokens', () => {
    for (const token of [
      'V1StGXR8_Z5jdHi6B-myT',
      'wh.',
      'wh.cle1',
      'wh.nope1.abc',
      'wh.unknown.abc',
      'xwh.cle1.abc',
    ]) {
      expect(webhookTokenRegion(token)).toBeUndefined();
    }
  });
});
