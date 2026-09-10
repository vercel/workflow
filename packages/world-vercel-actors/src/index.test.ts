import { describe, expect, it } from 'vitest';
import { affinityHeaders } from './index.js';

describe('affinity delivery configuration', () => {
  it('requires the supplied header name and sends the exact run id', () => {
    expect(affinityHeaders('wrun_123', 'x-test-affinity')).toEqual({ 'x-test-affinity': 'wrun_123' });
    expect(() => affinityHeaders('wrun_123', '')).toThrow(/platform affinity header/);
  });
  it('does not allow configuration to replace authentication or HTTP framing', () => {
    for (const header of ['Authorization', 'Host', 'Content-Length', 'Content-Type', 'bad\nheader']) {
      expect(() => affinityHeaders('wrun_123', header)).toThrow();
    }
  });
});
