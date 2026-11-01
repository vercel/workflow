import { describe, expect, it } from 'vitest';
import { parseWorldCapabilities } from './capabilities.js';

describe('parseWorldCapabilities', () => {
  it('keeps every known capability', () => {
    const capabilities = {
      invoke: true,
      hookRetention: { active: true },
      atomicStartHook: { active: true },
      maxConcurrency: true,
      inBandFence: true,
      hookResumeDedup: false,
      hookForceClaim: true,
      deploymentAffinity: true,
      dynamicWorkflowCode: true,
    };
    expect(parseWorldCapabilities(capabilities)).toEqual(capabilities);
  });

  it('ignores capabilities this build does not know, so a newer peer still parses', () => {
    expect(
      parseWorldCapabilities({
        atomicStartHook: { active: true },
        someFutureCapability: { active: true, mode: 'x' },
      })
    ).toEqual({ atomicStartHook: { active: true } });
  });

  it('reads a malformed field as unsupported without dropping the others', () => {
    expect(
      parseWorldCapabilities({
        hookRetention: { active: 'yes' },
        atomicStartHook: true,
        inBandFence: 'true',
        deploymentAffinity: true,
      })
    ).toEqual({ deploymentAffinity: true });
  });

  it('strips unknown keys inside a known capability', () => {
    expect(
      parseWorldCapabilities({
        atomicStartHook: { active: true, region: 'iad1' },
      })
    ).toEqual({ atomicStartHook: { active: true } });
  });

  it.each([
    undefined,
    null,
    'yes',
    42,
    [true],
  ])('reads %j as no capabilities', (value) => {
    expect(parseWorldCapabilities(value)).toBeUndefined();
  });
});
