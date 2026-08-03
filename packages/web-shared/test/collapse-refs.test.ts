import { describe, expect, it } from 'vitest';
import {
  collapseRefs,
  isBytesDisplay,
} from '../src/components/ui/data-inspector.js';

/**
 * `collapseRefs` is the single typed-array detection path used by
 * `DataInspector`. AI agent stream chunks are commonly hydrated as
 * `Uint8Array` values either directly or nested in plain objects / Map / Set
 * (e.g. `{ delta: new Uint8Array(...) }`). These tests guard against the
 * detection silently regressing.
 */

function readBytesDisplayText(value: unknown): string {
  if (!isBytesDisplay(value)) {
    throw new Error('expected BytesDisplay marker');
  }
  const desc = Object.getOwnPropertyDescriptor(value, 'text');
  return desc?.value as string;
}

function readBytesDisplaySourceType(value: unknown): string | undefined {
  if (!isBytesDisplay(value)) return undefined;
  const desc = Object.getOwnPropertyDescriptor(value, 'decodedFrom');
  return (desc?.value as { type: string } | undefined)?.type;
}

describe('collapseRefs typed-array handling', () => {
  it('decodes a top-level Uint8Array as UTF-8 text', () => {
    const chunk = new TextEncoder().encode('hello world');
    const result = collapseRefs(chunk);

    expect(isBytesDisplay(result)).toBe(true);
    expect(readBytesDisplayText(result)).toBe('hello world');
    expect(readBytesDisplaySourceType(result)).toBe('Uint8Array');
  });

  it('falls back to a compact summary for binary typed arrays', () => {
    const chunk = new Uint8Array([0xff, 0xfe, 0xfd]);
    const result = collapseRefs(chunk);

    expect(isBytesDisplay(result)).toBe(true);
    expect(readBytesDisplayText(result)).toBe('Uint8Array(3) [255, 254, 253]');
    expect(readBytesDisplaySourceType(result)).toBeUndefined();
  });

  it('decodes typed arrays nested in plain objects', () => {
    const chunk = new TextEncoder().encode('AI says hi');
    const result = collapseRefs({ delta: chunk }) as Record<string, unknown>;

    expect(isBytesDisplay(result.delta)).toBe(true);
    expect(readBytesDisplayText(result.delta)).toBe('AI says hi');
  });

  it('decodes typed arrays nested in arrays', () => {
    const chunk = new TextEncoder().encode('streamed');
    const result = collapseRefs([chunk]) as unknown[];

    expect(isBytesDisplay(result[0])).toBe(true);
    expect(readBytesDisplayText(result[0])).toBe('streamed');
  });

  it('decodes typed arrays nested in Map values', () => {
    const chunk = new TextEncoder().encode('map value');
    const result = collapseRefs(new Map([['delta', chunk]]));

    expect(result).toBeInstanceOf(Map);
    const value = (result as Map<string, unknown>).get('delta');
    expect(isBytesDisplay(value)).toBe(true);
    expect(readBytesDisplayText(value)).toBe('map value');
  });

  it('decodes typed arrays nested in Set entries', () => {
    const chunk = new TextEncoder().encode('set value');
    const result = collapseRefs(new Set([chunk]));

    expect(result).toBeInstanceOf(Set);
    const [value] = Array.from(result as Set<unknown>);
    expect(isBytesDisplay(value)).toBe(true);
    expect(readBytesDisplayText(value)).toBe('set value');
  });

  it('handles non-Uint8Array typed array views', () => {
    // Use values that are guaranteed to decode as invalid UTF-8 so we exercise
    // the summary fallback path. 0xff80 in little-endian is an unpaired
    // surrogate-leading byte sequence rejected by `TextDecoder({ fatal: true })`.
    const chunk = new Int16Array([-128, -1, -128]);
    const result = collapseRefs(chunk);

    expect(isBytesDisplay(result)).toBe(true);
    expect(readBytesDisplayText(result)).toMatch(/^Int16Array\(3\) \[/);
  });

  it('does not treat DataView as a bytes display target', () => {
    const buf = new Uint8Array([0x68, 0x69]).buffer;
    const view = new DataView(buf);
    const result = collapseRefs(view);

    expect(isBytesDisplay(result)).toBe(false);
    expect(result).toBe(view);
  });

  it('passes primitives through unchanged', () => {
    expect(collapseRefs('plain text')).toBe('plain text');
    expect(collapseRefs(42)).toBe(42);
    expect(collapseRefs(null)).toBe(null);
    expect(collapseRefs(undefined)).toBe(undefined);
  });
});
