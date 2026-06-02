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

describe('encryption', () => {
  describe('round-trip', () => {
    it('encrypt() + decrypt() returns the original plaintext', async () => {
      const key = await getKey();
      const plaintext = new TextEncoder().encode('hello, workflow');
      const ciphertext = await encrypt(key, plaintext);

      // Ciphertext is longer than plaintext: 12-byte nonce + 16-byte GCM tag.
      expect(ciphertext.byteLength).toBe(plaintext.byteLength + 12 + 16);

      const decoded = await decrypt(key, ciphertext);
      expect(new TextDecoder().decode(decoded)).toBe('hello, workflow');
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
      const error = await decrypt(key, tooShort).catch((e) => e);
      expect(RuntimeDecryptionError.is(error)).toBe(true);
      expect(error.message).toMatch(/Encrypted data too short/);
      expect(error.context).toMatchObject({
        operation: 'decrypt',
        byteLength: 10,
      });
    });

    it('throws RuntimeDecryptionError (not a bare OperationError) on auth-tag failure', async () => {
      // GCM auth-tag verification failure surfaces from Node's Web
      // Crypto API as `OperationError: The operation failed for an
      // operation-specific reason at AESCipherJob.onDone`. The
      // encryption module must rewrap this as a RuntimeDecryptionError.
      const key = await getKey();
      const plaintext = new TextEncoder().encode('hello, workflow');
      const ciphertext = await encrypt(key, plaintext);

      // Corrupt the last byte of the GCM auth tag — guaranteed tag verification failure.
      const tampered = new Uint8Array(ciphertext);
      tampered[tampered.length - 1] ^= 0xff;

      const error = await decrypt(key, tampered).catch((e) => e);
      expect(RuntimeDecryptionError.is(error)).toBe(true);
      expect(error.cause).toBeDefined();
      // The original DOMException carries name OperationError on Node 20+,
      // which is what the wrapping is meant to capture as cause.
      const cause = error.cause as { name?: string };
      expect(cause?.name).toBe('OperationError');
      expect(error.context).toMatchObject({
        operation: 'decrypt',
        byteLength: tampered.byteLength,
      });
    });

    it('throws RuntimeDecryptionError when the wrong key is used', async () => {
      const writerKey = await getKey();
      const readerKey = await getOtherKey();
      const ciphertext = await encrypt(
        writerKey,
        new TextEncoder().encode('secret')
      );

      const error = await decrypt(readerKey, ciphertext).catch((e) => e);
      expect(RuntimeDecryptionError.is(error)).toBe(true);
      // Wrong key → auth tag mismatch → same OperationError as ciphertext corruption.
      const cause = error.cause as { name?: string };
      expect(cause?.name).toBe('OperationError');
    });

    it('does not record a formatPrefix at the low-level layer', async () => {
      // This function only ever sees the stripped AES payload
      // (`[nonce][ciphertext+tag]`), never the outer `encr` envelope marker.
      // Capturing the first bytes here would record nonce bytes and be
      // misleading, so the low-level layer records only operation/byteLength.
      // The serialization layer attaches the real envelope prefix.
      const key = await getKey();
      const bogus = new Uint8Array(28).fill(0x41); // 28 bytes, passes length check
      const error = await decrypt(key, bogus).catch((e) => e);
      expect(RuntimeDecryptionError.is(error)).toBe(true);
      expect(error.context).toMatchObject({
        operation: 'decrypt',
        byteLength: 28,
      });
      expect(error.context.formatPrefix).toBeUndefined();
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
