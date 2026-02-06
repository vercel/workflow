import { decrypt, encrypt } from '@workflow/core/encryption';
import { describe, expect, it } from 'vitest';
import { deriveRunKey } from './encryption.js';

const testProjectId = 'prj_test123';
const testRunId = 'wrun_abc123';
// 32 bytes for AES-256
const testDeploymentKey = new Uint8Array([
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c,
  0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19,
  0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
]);

describe('deriveRunKey', () => {
  it('should derive a 32-byte key', async () => {
    const key = await deriveRunKey(testDeploymentKey, testProjectId, testRunId);
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.byteLength).toBe(32);
  });

  it('should derive the same key for the same inputs', async () => {
    const key1 = await deriveRunKey(
      testDeploymentKey,
      testProjectId,
      testRunId
    );
    const key2 = await deriveRunKey(
      testDeploymentKey,
      testProjectId,
      testRunId
    );
    expect(key1).toEqual(key2);
  });

  it('should derive different keys for different runIds', async () => {
    const key1 = await deriveRunKey(
      testDeploymentKey,
      testProjectId,
      'wrun_run1'
    );
    const key2 = await deriveRunKey(
      testDeploymentKey,
      testProjectId,
      'wrun_run2'
    );
    expect(key1).not.toEqual(key2);
  });

  it('should derive different keys for different projectIds', async () => {
    const key1 = await deriveRunKey(
      testDeploymentKey,
      'prj_project1',
      testRunId
    );
    const key2 = await deriveRunKey(
      testDeploymentKey,
      'prj_project2',
      testRunId
    );
    expect(key1).not.toEqual(key2);
  });

  it('should derive different keys for different deployment keys', async () => {
    const otherKey = new Uint8Array(32);
    crypto.getRandomValues(otherKey);

    const key1 = await deriveRunKey(
      testDeploymentKey,
      testProjectId,
      testRunId
    );
    const key2 = await deriveRunKey(otherKey, testProjectId, testRunId);
    expect(key1).not.toEqual(key2);
  });

  it('should throw for invalid key length', async () => {
    await expect(
      deriveRunKey(new Uint8Array(16), testProjectId, testRunId)
    ).rejects.toThrow('expected 32 bytes for AES-256, got 16 bytes');
  });

  it('should throw for empty projectId', async () => {
    await expect(
      deriveRunKey(testDeploymentKey, '', testRunId)
    ).rejects.toThrow('projectId must be a non-empty string');
  });
});

describe('deriveRunKey + core encrypt/decrypt round-trip', () => {
  it('should encrypt and decrypt data correctly', async () => {
    const key = await deriveRunKey(testDeploymentKey, testProjectId, testRunId);
    const plaintext = new TextEncoder().encode('Hello, World!');

    const encrypted = await encrypt(key, plaintext);
    const decrypted = await decrypt(key, encrypted);

    expect(decrypted).toEqual(plaintext);
    expect(new TextDecoder().decode(decrypted)).toBe('Hello, World!');
  });

  it('should encrypt and decrypt empty data', async () => {
    const key = await deriveRunKey(testDeploymentKey, testProjectId, testRunId);
    const plaintext = new Uint8Array(0);

    const encrypted = await encrypt(key, plaintext);
    const decrypted = await decrypt(key, encrypted);

    expect(decrypted).toEqual(plaintext);
  });

  it('should encrypt and decrypt large data', async () => {
    const key = await deriveRunKey(testDeploymentKey, testProjectId, testRunId);
    const plaintext = new Uint8Array(65536);
    crypto.getRandomValues(plaintext);

    const encrypted = await encrypt(key, plaintext);
    const decrypted = await decrypt(key, encrypted);

    expect(decrypted).toEqual(plaintext);
  });

  it('should produce different ciphertext for same data (random nonce)', async () => {
    const key = await deriveRunKey(testDeploymentKey, testProjectId, testRunId);
    const plaintext = new TextEncoder().encode('test');

    const encrypted1 = await encrypt(key, plaintext);
    const encrypted2 = await encrypt(key, plaintext);

    expect(encrypted1).not.toEqual(encrypted2);

    const decrypted1 = await decrypt(key, encrypted1);
    const decrypted2 = await decrypt(key, encrypted2);
    expect(decrypted1).toEqual(plaintext);
    expect(decrypted2).toEqual(plaintext);
  });

  it('should fail to decrypt with a key derived from a different runId', async () => {
    const key1 = await deriveRunKey(
      testDeploymentKey,
      testProjectId,
      'wrun_run1'
    );
    const key2 = await deriveRunKey(
      testDeploymentKey,
      testProjectId,
      'wrun_run2'
    );

    const plaintext = new TextEncoder().encode('sensitive data');
    const encrypted = await encrypt(key1, plaintext);

    await expect(decrypt(key2, encrypted)).rejects.toThrow();
  });

  it('should fail to decrypt tampered ciphertext', async () => {
    const key = await deriveRunKey(testDeploymentKey, testProjectId, testRunId);
    const plaintext = new TextEncoder().encode('test');
    const encrypted = await encrypt(key, plaintext);

    const tampered = new Uint8Array(encrypted);
    tampered[20] ^= 0xff;

    await expect(decrypt(key, tampered)).rejects.toThrow();
  });

  it('should produce raw encrypted data without format prefix', async () => {
    const key = await deriveRunKey(testDeploymentKey, testProjectId, testRunId);
    const plaintext = new TextEncoder().encode('test');

    const encrypted = await encrypt(key, plaintext);

    // Core encrypt produces [nonce][ciphertext], NOT 'encr' prefix
    const prefix = new TextDecoder().decode(encrypted.subarray(0, 4));
    expect(prefix).not.toBe('encr');

    // Minimum size: 12 (nonce) + 16 (auth tag) = 28 bytes
    expect(encrypted.length).toBeGreaterThanOrEqual(28);
  });
});
