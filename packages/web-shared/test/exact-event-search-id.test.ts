import { describe, expect, it } from 'vitest';
import { parseExactWorkflowSearchId } from '../src/lib/exact-event-search-id.js';

describe('parseExactWorkflowSearchId', () => {
  it('accepts full step IDs', () => {
    const id = 'step_01KSG94DWMWZRQBK04D3GS2CAQ';
    expect(parseExactWorkflowSearchId(id)).toEqual({
      kind: 'step',
      id,
    });
  });

  it('accepts full wait IDs', () => {
    const id = 'wait_01KSG94DWMWZRQBK04D3GS2CAQ';
    expect(parseExactWorkflowSearchId(id)).toEqual({
      kind: 'wait',
      id,
    });
  });

  it('accepts full hook IDs', () => {
    const id = 'hook_01KSG94DWMWZRQBK04D3GS2CAQ';
    expect(parseExactWorkflowSearchId(id)).toEqual({
      kind: 'hook',
      id,
    });
  });

  it('accepts full event IDs', () => {
    const id = 'evnt_01KSG94CMGCPMC3PPACDCJR9AQ';
    expect(parseExactWorkflowSearchId(id)).toEqual({
      kind: 'event',
      id,
    });
  });

  it('rejects partial IDs', () => {
    expect(parseExactWorkflowSearchId('step_01KSG94')).toBeNull();
    expect(parseExactWorkflowSearchId('wait_01KSG94')).toBeNull();
    expect(parseExactWorkflowSearchId('hook_01KSG94')).toBeNull();
    expect(parseExactWorkflowSearchId('evnt_01KSG94')).toBeNull();
  });

  it('rejects run IDs', () => {
    expect(
      parseExactWorkflowSearchId('wrun_01KSG94CFWFBPBYWW3PX7SF73W')
    ).toBeNull();
  });
});
