import { describe, expect, it } from 'vitest';
import {
  hasEncryptedFields,
  hydrateResourceIO,
  isEncryptedMarker,
} from './hydration';

/**
 * A `devl`-prefixed payload, the unencrypted form stored by the SDK. The
 * body is devalue's flattened form: an array whose first element is the
 * root value (enough for the primitives and flat arrays used here).
 */
function devl(value: unknown): Uint8Array {
  const flattened = Array.isArray(value)
    ? [value.map((_, i) => i + 1), ...value]
    : [value];
  const body = new TextEncoder().encode(JSON.stringify(flattened));
  const out = new Uint8Array(4 + body.byteLength);
  out.set(new TextEncoder().encode('devl'), 0);
  out.set(body, 4);
  return out;
}

/** An `encr`-prefixed payload: ciphertext the browser cannot read as-is. */
function encr(): Uint8Array {
  const out = new Uint8Array(4 + 16);
  out.set(new TextEncoder().encode('encr'), 0);
  return out;
}

describe('hydrateResourceIO: dynamicWorkflowCode', () => {
  it("hydrates a dynamic run's code to the source string", () => {
    const code = 'async function workflow() { "use workflow"; }';
    const run = hydrateResourceIO({
      runId: 'wrun_1',
      input: devl(['arg']),
      dynamicWorkflowCode: devl(code),
    });
    expect(run.input).toEqual(['arg']);
    expect(run.dynamicWorkflowCode).toBe(code);
  });

  it('marks encrypted code the same way it marks encrypted input', () => {
    const run = hydrateResourceIO({
      runId: 'wrun_1',
      input: encr(),
      dynamicWorkflowCode: encr(),
    });
    expect(isEncryptedMarker(run.input)).toBe(true);
    expect(isEncryptedMarker(run.dynamicWorkflowCode)).toBe(true);
  });

  it('counts encrypted code toward hasEncryptedFields', () => {
    // With the input already decrypted, the code alone has to keep the
    // Decrypt affordance available.
    const run = hydrateResourceIO({
      runId: 'wrun_1',
      input: devl(['arg']),
      dynamicWorkflowCode: encr(),
    });
    expect(hasEncryptedFields(run)).toBe(true);
  });
});
