import { describe, expect, it } from 'vitest';
import {
  looksLikeWorkflowIdSearchInput,
  parseExactWorkflowSearchId,
} from '../src/lib/exact-event-search-id.js';

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

  it('normalizes lowercase ULID bodies to uppercase', () => {
    expect(
      parseExactWorkflowSearchId('step_01ksg94dwmwzrqbk04d3gs2caq')
    ).toEqual({
      kind: 'step',
      id: 'step_01KSG94DWMWZRQBK04D3GS2CAQ',
    });
  });

  it('trims leading and trailing whitespace', () => {
    const id = 'evnt_01KSG94CMGCPMC3PPACDCJR9AQ';
    expect(parseExactWorkflowSearchId(`  ${id}  `)).toEqual({
      kind: 'event',
      id,
    });
  });

  it('rejects partial IDs and run IDs', () => {
    expect(parseExactWorkflowSearchId('step_01KSG94')).toBeNull();
    expect(parseExactWorkflowSearchId('wait_01KSG94')).toBeNull();
    expect(parseExactWorkflowSearchId('hook_01KSG94')).toBeNull();
    expect(parseExactWorkflowSearchId('evnt_01KSG94')).toBeNull();
    expect(
      parseExactWorkflowSearchId('wrun_01KSG94CFWFBPBYWW3PX7SF73W')
    ).toBeNull();
  });

  it('rejects IDs with illegal Crockford characters or wrong length', () => {
    expect(
      parseExactWorkflowSearchId('step_01ISG94DWMWZRQBK04D3GS2CAQ')
    ).toBeNull();
    expect(
      parseExactWorkflowSearchId('step_01KSG94DWMWZRQBK04D3GS2CA')
    ).toBeNull();
    expect(
      parseExactWorkflowSearchId('step_01KSG94DWMWZRQBK04D3GS2CAQQ')
    ).toBeNull();
  });
});

describe('looksLikeWorkflowIdSearchInput', () => {
  it('matches known workflow ID prefixes', () => {
    expect(looksLikeWorkflowIdSearchInput('step_01KSG94')).toBe(true);
    expect(looksLikeWorkflowIdSearchInput('wrun_01KSG94')).toBe(true);
    expect(looksLikeWorkflowIdSearchInput('EVNT_01KSG94')).toBe(true);
  });

  it('does not match free-text search input', () => {
    expect(looksLikeWorkflowIdSearchInput('parseInvoice')).toBe(false);
    expect(looksLikeWorkflowIdSearchInput('step_started')).toBe(false);
  });
});
