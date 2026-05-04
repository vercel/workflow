import { afterEach, describe, expect, it } from 'vitest';
import { shouldUseDeferredBuilder } from './builder.js';
import { parseEnvironmentFlag } from './environment-flag.js';

const originalLazyDiscoveryEnv = process.env.WORKFLOW_NEXT_LAZY_DISCOVERY;

afterEach(() => {
  if (originalLazyDiscoveryEnv === undefined) {
    delete process.env.WORKFLOW_NEXT_LAZY_DISCOVERY;
  } else {
    process.env.WORKFLOW_NEXT_LAZY_DISCOVERY = originalLazyDiscoveryEnv;
  }
});

describe('shouldUseDeferredBuilder', () => {
  it('treats WORKFLOW_NEXT_LAZY_DISCOVERY=0 as disabled', () => {
    process.env.WORKFLOW_NEXT_LAZY_DISCOVERY = '0';

    expect(shouldUseDeferredBuilder('16.2.1')).toBe(false);
  });

  it('treats WORKFLOW_NEXT_LAZY_DISCOVERY=false as disabled', () => {
    process.env.WORKFLOW_NEXT_LAZY_DISCOVERY = 'false';

    expect(shouldUseDeferredBuilder('16.2.1')).toBe(false);
  });

  it('treats WORKFLOW_NEXT_LAZY_DISCOVERY=off as disabled', () => {
    process.env.WORKFLOW_NEXT_LAZY_DISCOVERY = 'off';

    expect(parseEnvironmentFlag(process.env.WORKFLOW_NEXT_LAZY_DISCOVERY)).toBe(
      false
    );
    expect(shouldUseDeferredBuilder('16.2.1')).toBe(false);
  });

  it('enables deferred mode for compatible versions when the env is enabled', () => {
    process.env.WORKFLOW_NEXT_LAZY_DISCOVERY = '1';

    expect(shouldUseDeferredBuilder('16.2.1')).toBe(true);
  });
});
