import { RuntimeDecryptionError } from '@workflow/errors';
import { describe, expect, it } from 'vitest';
import { type CryptoKey, decrypt, encrypt, importKey } from './encryption.js';

const RAW_KEY = new Uint8Array(32).fill(7);
const OTHER_RAW_KEY = new Uint8Array(32).fill(8);
const SHORT_RAW_KEY = new Uint8Array(16).fill(7);

async function getKey(): Promise<CryptoKey> {
  return importKey(RAW_KEY);
}

async function getOtherKey(): Promise<CryptoKey> {
  return importKey(OTHER_RAW_KEY);
}

async function captureError(action: () => unknown): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to fail');
}

describe('encryption', () => {
  describe('round-trip', () => {
    it('decrypts synchronously on Node', async () => {
      const key = await getKey();
      const plaintext = new TextEncoder().encode('hello, workflow');
      const ciphertext = await encrypt(key, plaintext);

      // Ciphertext is longer than plaintext: 12-byte nonce + 16-byte GCM tag.
      expect(ciphertext.byteLength).toBe(plaintext.byteLength + 12 + 16);

      const decoded = decrypt(key, ciphertext);
      expect(decoded).not.toBeInstanceOf(Promise);
      expect(decoded).toBeInstanceOf(Uint8Array);
      expect(new TextDecoder().decode(decoded as Uint8Array)).toBe(
        'hello, workflow'
      );
    });
  });

  describe('importKey', () => {
    it('rejects keys that are not exactly 32 bytes', async () => {
      await expect(importKey(SHORT_RAW_KEY)).rejects.toThrow(
        /must be exactly 32 bytes, got 16/
      );
    });
  });

  describe('decrypt failure cases', () => {
    it('throws RuntimeDecryptionError when input is shorter than the GCM envelope', async () => {
      const key = await getKey();
      // 12-byte nonce + 16-byte tag = 28 bytes minimum. 10 bytes is too short.
      const tooShort = new Uint8Array(10).fill(0);
      const error = await captureError(() => decrypt(key, tooShort));
      expect(RuntimeDecryptionError.is(error)).toBe(true);
      expect(error).toMatchObject({
        message: expect.stringMatching(/Encrypted data too short/),
        context: { operation: 'decrypt', byteLength: 10 },
      });
    });

    it('throws RuntimeDecryptionError (not a bare OperationError) on auth-tag failure', async () => {
      const key = await getKey();
      const plaintext = new TextEncoder().encode('hello, workflow');
      const ciphertext = await encrypt(key, plaintext);

      // Corrupt the last byte of the GCM auth tag — guaranteed tag verification failure.
      const tampered = new Uint8Array(ciphertext);
      tampered[tampered.length - 1] ^= 0xff;

      const error = await captureError(() => decrypt(key, tampered));
      expect(RuntimeDecryptionError.is(error)).toBe(true);
      expect(error).toMatchObject({
        cause: expect.anything(),
        context: {
          operation: 'decrypt',
          byteLength: tampered.byteLength,
        },
      });
    });

    it('throws RuntimeDecryptionError when the wrong key is used', async () => {
      const writerKey = await getKey();
      const readerKey = await getOtherKey();
      const ciphertext = await encrypt(
        writerKey,
        new TextEncoder().encode('secret')
      );

      const error = await captureError(() => decrypt(readerKey, ciphertext));
      expect(RuntimeDecryptionError.is(error)).toBe(true);
      expect(error).toMatchObject({ cause: expect.anything() });
    });

    it('keeps RuntimeDecryptionError on synchronous auth failure', async () => {
      const key = await getKey();
      const ciphertext = await encrypt(
        key,
        new TextEncoder().encode('tamper me')
      );
      ciphertext[ciphertext.length - 1] ^= 0xff;

      expect(() => decrypt(key, ciphertext)).toThrowError(
        RuntimeDecryptionError
      );
    });

    it('does not record a formatPrefix at the low-level layer', async () => {
      // This function only ever sees the stripped AES payload
      // (`[nonce][ciphertext+tag]`), never the outer `encr` envelope marker.
      // Capturing the first bytes here would record nonce bytes and be
      // misleading, so the low-level layer records only operation/byteLength.
      // The serialization layer attaches the real envelope prefix.
      const key = await getKey();
      const bogus = new Uint8Array(28).fill(0x41); // 28 bytes, passes length check
      const error = await captureError(() => decrypt(key, bogus));
      expect(RuntimeDecryptionError.is(error)).toBe(true);
      expect(error).toMatchObject({
        context: { operation: 'decrypt', byteLength: 28 },
      });
      expect(error).not.toMatchObject({
        context: { formatPrefix: expect.anything() },
      });
    });
  });

  describe('encrypt failure cases', () => {
    it('throws RuntimeDecryptionError when the underlying crypto call fails', async () => {
      // Importing the key with only `decrypt` usage makes any subsequent
      // encrypt() call fail inside subtle.encrypt with an
      // InvalidAccessError. This exercises the encryption-path catch.
      const decryptOnly = await importKey(RAW_KEY, ['decrypt']);
      const error = await encrypt(
        decryptOnly,
        new TextEncoder().encode('nope')
      ).catch((e) => e);
      expect(RuntimeDecryptionError.is(error)).toBe(true);
      expect(error.context).toMatchObject({
        operation: 'encrypt',
        byteLength: 4,
      });
    });
  });
});
