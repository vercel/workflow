import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  CopyableDataBlock,
  EncryptedDataBlock,
  serializeForClipboard,
} from '../src/components/sidebar/copyable-data-block.js';
import {
  DecryptClickContext,
  type DecryptClickContextValue,
} from '../src/components/ui/data-inspector.js';

/**
 * `serializeForClipboard` is the helper behind the copy button on the JSON-style
 * data viewer (`CopyableDataBlock`). It decides what text lands on the clipboard
 * when a user copies a step's input/output/error payload, so these tests pin the
 * formatting contract: strings stay verbatim, primitives stringify, and objects
 * become pretty-printed JSON with a defensive fallback for un-serializable values.
 */
describe('serializeForClipboard', () => {
  it('returns strings verbatim without quoting them', () => {
    expect(serializeForClipboard('hello world')).toBe('hello world');
    // Strings that happen to be JSON must not be double-encoded.
    expect(serializeForClipboard('{"a":1}')).toBe('{"a":1}');
    expect(serializeForClipboard('')).toBe('');
  });

  it('stringifies numeric, boolean, and null primitives', () => {
    expect(serializeForClipboard(42)).toBe('42');
    expect(serializeForClipboard(0)).toBe('0');
    expect(serializeForClipboard(-1.5)).toBe('-1.5');
    expect(serializeForClipboard(Number.NaN)).toBe('NaN');
    expect(serializeForClipboard(true)).toBe('true');
    expect(serializeForClipboard(false)).toBe('false');
    expect(serializeForClipboard(null)).toBe('null');
  });

  it('pretty-prints objects as two-space-indented JSON', () => {
    const value = { input: 'x', count: 2, nested: { ok: true } };
    expect(serializeForClipboard(value)).toBe(JSON.stringify(value, null, 2));
    // Sanity-check the formatting is actually multi-line and indented.
    expect(serializeForClipboard(value)).toContain('\n  "input": "x"');
  });

  it('pretty-prints arrays as two-space-indented JSON', () => {
    const value = [1, 'two', { three: 3 }];
    expect(serializeForClipboard(value)).toBe(JSON.stringify(value, null, 2));
  });

  it('falls back to String() when JSON.stringify throws (circular refs)', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;

    expect(serializeForClipboard(circular)).toBe('[object Object]');
  });

  it('falls back to String() for BigInt values JSON cannot encode', () => {
    expect(serializeForClipboard(10n)).toBe('10');
  });

  it('passes undefined through (JSON.stringify yields no string)', () => {
    // Documents the current behavior: undefined is neither a handled primitive
    // nor JSON-serializable, so the helper returns undefined as-is.
    expect(serializeForClipboard(undefined)).toBeUndefined();
  });
});

describe('CopyableDataBlock', () => {
  it('renders a labelled copy button for the data viewer', () => {
    const markup = renderToStaticMarkup(
      createElement(CopyableDataBlock, { data: { input: 'value' } })
    );

    expect(markup).toContain('aria-label="Copy data"');
  });

  it('renders without throwing for a variety of payload shapes', () => {
    const payloads: unknown[] = [
      'a plain string',
      1234,
      null,
      { nested: { deeply: [1, 2, 3] } },
      [{ id: 'a' }, { id: 'b' }],
    ];

    for (const data of payloads) {
      expect(() =>
        renderToStaticMarkup(createElement(CopyableDataBlock, { data }))
      ).not.toThrow();
    }
  });
});

describe('EncryptedDataBlock', () => {
  it('shows a static Encrypted badge when no decrypt context is provided', () => {
    const markup = renderToStaticMarkup(createElement(EncryptedDataBlock));

    expect(markup).toContain('Encrypted');
    // The blurred placeholder previews the encrypted shape to the user.
    expect(markup).toContain('[encrypted]');
    expect(markup).not.toContain('Decrypt');
  });

  it('renders an enabled Decrypt button when a decrypt context is present', () => {
    const ctx: DecryptClickContextValue = {
      onDecrypt: () => {},
      isDecrypting: false,
    };

    const markup = renderToStaticMarkup(
      createElement(
        DecryptClickContext.Provider,
        { value: ctx },
        createElement(EncryptedDataBlock)
      )
    );

    expect(markup).toContain('Decrypt');
    // The `disabled:`-prefixed Tailwind classes are always present, so assert on
    // the actual `disabled` attribute instead of a loose substring match.
    expect(markup).not.toContain('disabled=""');
  });

  it('disables the Decrypt button while decryption is in progress', () => {
    const ctx: DecryptClickContextValue = {
      onDecrypt: () => {},
      isDecrypting: true,
    };

    const markup = renderToStaticMarkup(
      createElement(
        DecryptClickContext.Provider,
        { value: ctx },
        createElement(EncryptedDataBlock)
      )
    );

    expect(markup).toContain('Decrypt');
    expect(markup).toContain('disabled=""');
  });
});
