import { describe, expect, it } from 'vitest';
import { parseHookPayload } from '../src/components/sidebar/resolve-hook-modal.js';

describe('parseHookPayload', () => {
  it('sends null for an empty or whitespace-only field', () => {
    expect(parseHookPayload('')).toEqual({ ok: true, payload: null });
    expect(parseHookPayload('  \n\t ')).toEqual({ ok: true, payload: null });
  });

  it('parses JSON objects, arrays and primitives', () => {
    expect(parseHookPayload('{"approved": true}')).toEqual({
      ok: true,
      payload: { approved: true },
    });
    expect(parseHookPayload('[1, 2]')).toEqual({ ok: true, payload: [1, 2] });
    expect(parseHookPayload('"yes"')).toEqual({ ok: true, payload: 'yes' });
    expect(parseHookPayload('false')).toEqual({ ok: true, payload: false });
    expect(parseHookPayload('null')).toEqual({ ok: true, payload: null });
  });

  it('rejects input that is not valid JSON', () => {
    expect(parseHookPayload('{approved: true}')).toEqual({ ok: false });
    expect(parseHookPayload("'single quotes'")).toEqual({ ok: false });
    expect(parseHookPayload('{"a": 1')).toEqual({ ok: false });
  });
});
