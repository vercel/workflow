import { importKey } from '@workflow/core/encryption';
import { dehydrateStepError } from '@workflow/core/serialization';
import { describe, expect, it } from 'vitest';
import { hydrateResourceIO, isEncryptedRef } from './hydration.js';

describe('hydrateResourceIO', () => {
  it('displays and decrypts encrypted event errors', async () => {
    const rawKey = new Uint8Array(32).fill(7);
    const error = new Error('step failed');
    const encryptedError = await dehydrateStepError(
      error,
      'run_1',
      await importKey(rawKey),
      [],
      globalThis,
      true
    );
    const event = {
      runId: 'run_1',
      eventId: 'event_1',
      eventType: 'step_failed',
      eventData: { error: encryptedError },
    };

    const encrypted = await hydrateResourceIO(event);
    expect(isEncryptedRef(encrypted.eventData.error)).toBe(true);

    const decrypted = await hydrateResourceIO(event, async () => rawKey);
    expect(decrypted.eventData.error).toBeInstanceOf(Error);
    expect(decrypted.eventData.error).toHaveProperty('message', error.message);
  });
});
