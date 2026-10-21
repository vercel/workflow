import { decode, encode } from '@workflow/world-vercel/run-id';
import { monotonicFactory } from 'ulid';
import { describe, expect, it } from 'vitest';
import {
  newHookRegion,
  regionalWebhookToken,
  tagHookUlid,
  webhookTokenRegion,
} from './hook-region.js';

const ulid = monotonicFactory();
const regional = { hookRegions: true } as const;

describe('newHookRegion', () => {
  const cle1Run = `wrun_${encode(ulid(), 'cle1')}`;

  it("stores a webhook in its run's region", () => {
    expect(
      newHookRegion({ isWebhook: true, runId: cle1Run, capabilities: regional })
    ).toBe('cle1');
    // Untagged (legacy) runs live in iad1.
    expect(
      newHookRegion({
        isWebhook: true,
        runId: `wrun_${ulid()}`,
        capabilities: regional,
      })
    ).toBe('iad1');
    // An undecodable run ID leaves the webhook in the default region.
    expect(
      newHookRegion({
        isWebhook: true,
        runId: 'wrun_test',
        capabilities: regional,
      })
    ).toBeUndefined();
  });

  it('leaves a createHook() hook in the default region', () => {
    expect(
      newHookRegion({
        isWebhook: false,
        runId: cle1Run,
        capabilities: regional,
      })
    ).toBeUndefined();
  });

  it('stores everything in the default region on Worlds without hookRegions', () => {
    for (const capabilities of [undefined, {}]) {
      expect(
        newHookRegion({ isWebhook: true, runId: cle1Run, capabilities })
      ).toBeUndefined();
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
