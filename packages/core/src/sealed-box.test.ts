import { RuntimeDecryptionError, WorkflowRuntimeError } from '@workflow/errors';
import { describe, expect, it, vi } from 'vitest';
import {
  decrypt as aesGcmDecrypt,
  encrypt as aesGcmEncrypt,
} from './encryption.js';
import {
  base64ToBytes,
  bytesToBase64,
  decapsulate,
  deriveRunKeyPair,
  encapsulate,
  open,
  type RunKeyPair,
  runAad,
  seal,
} from './sealed-box.js';

const K = new Uint8Array(32).fill(7);
const OTHER_K = new Uint8Array(32).fill(8);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function plaintext(value = 'hello, workflow'): Uint8Array {
  return encoder.encode(value);
}

describe('sealed-box', () => {
  describe('deriveRunKeyPair', () => {
    it('is deterministic for the same run key material', async () => {
      const a = await deriveRunKeyPair(K);
      const b = await deriveRunKeyPair(K);
      expect(a.scalar).toEqual(b.scalar);
      expect(a.publicKey).toEqual(b.publicKey);
    });

    it('derives different keypairs for different run key material', async () => {
      const a = await deriveRunKeyPair(K);
      const b = await deriveRunKeyPair(OTHER_K);
      expect(a.scalar).not.toEqual(b.scalar);
      expect(a.publicKey).not.toEqual(b.publicKey);
    });

    it('produces 32-byte scalars and public keys', async () => {
      const { scalar, publicKey } = await deriveRunKeyPair(K);
      expect(scalar.byteLength).toBe(32);
      expect(publicKey.byteLength).toBe(32);
    });

    it('does not leak the run key material into either half', async () => {
      const { scalar, publicKey } = await deriveRunKeyPair(K);
      expect(scalar).not.toEqual(K);
      expect(publicKey).not.toEqual(K);
      expect(publicKey).not.toEqual(scalar);
    });

    it('validates the length of the JWK-derived public key', async () => {
      // The public key is read out of a JWK export, the one place this module
      // trusts an external encoding. A short value must be rejected here
      // rather than surfacing later inside key agreement.
      const subtle = globalThis.crypto.subtle;
      const realExport = subtle.exportKey.bind(subtle);
      const spy = vi
        .spyOn(subtle, 'exportKey')
        .mockImplementation(async (format: any, key: any) => {
          const jwk = await realExport(format, key);
          if (format === 'jwk') {
            // 31 bytes of base64url instead of 32.
            (jwk as { x?: string }).x = 'A'.repeat(41);
          }
          return jwk;
        });

      try {
        await expect(deriveRunKeyPair(K)).rejects.toThrow(
          /produced a \d+-byte public key, expected 32/
        );
      } finally {
        spy.mockRestore();
      }
    });

    it('rejects run key material that is not exactly 32 bytes', async () => {
      await expect(deriveRunKeyPair(new Uint8Array(16))).rejects.toThrow(
        /must be exactly 32 bytes, got 16/
      );
    });
  });

  describe('seal/open round-trip', () => {
    it('opens a payload sealed to the run public key', async () => {
      const keyPair = await deriveRunKeyPair(K);
      const sealed = await seal(keyPair.publicKey, plaintext());

      // 32-byte ephemeral public key + 12-byte nonce + 16-byte GCM tag.
      expect(sealed.byteLength).toBe(plaintext().byteLength + 32 + 12 + 16);

      const opened = await open(keyPair, sealed);
      expect(decoder.decode(opened)).toBe('hello, workflow');
    });

    it('round-trips empty payloads', async () => {
      const keyPair = await deriveRunKeyPair(K);
      const sealed = await seal(keyPair.publicKey, new Uint8Array(0));
      expect(await open(keyPair, sealed)).toEqual(new Uint8Array(0));
    });

    it('round-trips large payloads', async () => {
      const keyPair = await deriveRunKeyPair(K);
      // `getRandomValues` accepts at most 64KiB per call, so fill in chunks.
      const large = new Uint8Array(128 * 1024);
      for (let offset = 0; offset < large.length; offset += 32 * 1024) {
        globalThis.crypto.getRandomValues(
          large.subarray(offset, offset + 32 * 1024)
        );
      }
      const sealed = await seal(keyPair.publicKey, large);
      expect(await open(keyPair, sealed)).toEqual(large);
    });

    it('produces a distinct ephemeral key and ciphertext on every call', async () => {
      const keyPair = await deriveRunKeyPair(K);
      const a = await seal(keyPair.publicKey, plaintext());
      const b = await seal(keyPair.publicKey, plaintext());

      // Identical plaintext, but the ephemeral public keys (first 32 bytes)
      // and therefore the whole envelope must differ — this is what makes
      // nonce reuse impossible across one-shot seals.
      expect(a.subarray(0, 32)).not.toEqual(b.subarray(0, 32));
      expect(a).not.toEqual(b);
      expect(await open(keyPair, a)).toEqual(await open(keyPair, b));
    });
  });

  describe('encrypt-only guarantee', () => {
    it('gives the sealer a content key that cannot decrypt', async () => {
      const keyPair = await deriveRunKeyPair(K);
      const { contentKey } = await encapsulate(keyPair.publicKey);

      expect(contentKey.usages).toEqual(['encrypt']);

      const encrypted = await aesGcmEncrypt(contentKey, plaintext());
      // Even holding the very content key it just used, the writer cannot
      // reverse the operation: the CryptoKey carries no 'decrypt' usage.
      await expect(aesGcmDecrypt(contentKey, encrypted)).rejects.toThrow(
        RuntimeDecryptionError
      );
    });

    it('gives the recipient a content key that cannot encrypt', async () => {
      const keyPair = await deriveRunKeyPair(K);
      const { ephemeralPublicKey } = await encapsulate(keyPair.publicKey);
      const contentKey = await decapsulate(keyPair, ephemeralPublicKey);

      expect(contentKey.usages).toEqual(['decrypt']);
      await expect(aesGcmEncrypt(contentKey, plaintext())).rejects.toThrow(
        RuntimeDecryptionError
      );
    });

    it('cannot be opened with only the public key (no scalar)', async () => {
      const keyPair = await deriveRunKeyPair(K);
      const sealed = await seal(keyPair.publicKey, plaintext());

      // Simulate a writer that knows only the public key: give `open` a
      // keypair whose "scalar" is the public key. This models the
      // type-confusion hazard where a public key is mistaken for secret
      // key material — it must never yield the plaintext.
      const publicOnly: RunKeyPair = {
        scalar: keyPair.publicKey,
        publicKey: keyPair.publicKey,
      };
      await expect(open(publicOnly, sealed)).rejects.toThrow(
        RuntimeDecryptionError
      );
    });
  });

  describe('key separation', () => {
    it('cannot be opened by a different run', async () => {
      const recipient = await deriveRunKeyPair(K);
      const other = await deriveRunKeyPair(OTHER_K);
      const sealed = await seal(recipient.publicKey, plaintext());

      await expect(open(other, sealed)).rejects.toThrow(RuntimeDecryptionError);
    });

    it('binds the content key to the recipient public key', async () => {
      const recipient = await deriveRunKeyPair(K);
      const other = await deriveRunKeyPair(OTHER_K);
      const sealed = await seal(recipient.publicKey, plaintext());

      // Splice the correct scalar together with the wrong public key. The
      // X25519 agreement still succeeds (the scalar matches the ephemeral
      // key), but the KDF `info` binds both public keys, so the derived
      // content key differs and the GCM tag fails. This is the
      // key-substitution defense.
      const spliced: RunKeyPair = {
        scalar: recipient.scalar,
        publicKey: other.publicKey,
      };
      await expect(open(spliced, sealed)).rejects.toThrow(
        RuntimeDecryptionError
      );
    });
  });

  describe('additional authenticated data', () => {
    it('round-trips when the AAD matches', async () => {
      const keyPair = await deriveRunKeyPair(K);
      const aad = runAad('prj_123', 'wrun_abc');
      const sealed = await seal(keyPair.publicKey, plaintext(), aad);
      expect(decoder.decode(await open(keyPair, sealed, aad))).toBe(
        'hello, workflow'
      );
    });

    it('rejects a payload replayed against a different run', async () => {
      const keyPair = await deriveRunKeyPair(K);
      const sealed = await seal(
        keyPair.publicKey,
        plaintext(),
        runAad('prj_123', 'wrun_abc')
      );

      await expect(
        open(keyPair, sealed, runAad('prj_123', 'wrun_different'))
      ).rejects.toThrow(RuntimeDecryptionError);
    });

    it('rejects a payload whose AAD is dropped', async () => {
      const keyPair = await deriveRunKeyPair(K);
      const sealed = await seal(
        keyPair.publicKey,
        plaintext(),
        runAad('prj_123', 'wrun_abc')
      );

      await expect(open(keyPair, sealed)).rejects.toThrow(
        RuntimeDecryptionError
      );
    });

    it('distinguishes projects with identical run ids', async () => {
      expect(runAad('prj_a', 'wrun_1')).not.toEqual(runAad('prj_b', 'wrun_1'));
    });
  });

  describe('tamper detection', () => {
    it('rejects a flipped ciphertext bit', async () => {
      const keyPair = await deriveRunKeyPair(K);
      const sealed = await seal(keyPair.publicKey, plaintext());
      const tampered = new Uint8Array(sealed);
      tampered[tampered.length - 1] ^= 0x01;

      await expect(open(keyPair, tampered)).rejects.toThrow(
        RuntimeDecryptionError
      );
    });

    it('rejects a swapped ephemeral public key', async () => {
      const keyPair = await deriveRunKeyPair(K);
      const sealed = await seal(keyPair.publicKey, plaintext());
      const other = await seal(keyPair.publicKey, plaintext());

      const tampered = new Uint8Array(sealed);
      tampered.set(other.subarray(0, 32), 0);

      await expect(open(keyPair, tampered)).rejects.toThrow(
        RuntimeDecryptionError
      );
    });

    it('rejects a truncated envelope', async () => {
      const keyPair = await deriveRunKeyPair(K);
      const sealed = await seal(keyPair.publicKey, plaintext());

      await expect(open(keyPair, sealed.subarray(0, 50))).rejects.toThrow(
        /Sealed payload too short/
      );
    });

    it('rejects an envelope that is all ephemeral key and no ciphertext', async () => {
      const keyPair = await deriveRunKeyPair(K);
      await expect(open(keyPair, new Uint8Array(32))).rejects.toThrow(
        /Sealed payload too short/
      );
    });
  });

  describe('malformed public keys', () => {
    it('rejects public keys that are not 32 bytes', async () => {
      await expect(seal(new Uint8Array(31), plaintext())).rejects.toThrow(
        WorkflowRuntimeError
      );
      await expect(seal(new Uint8Array(33), plaintext())).rejects.toThrow(
        /must be exactly 32 bytes, got 33/
      );
    });

    it('rejects low-order public keys', async () => {
      // An all-zero public key is a low-order point: X25519 agreement with it
      // yields an all-zero shared secret, which Web Crypto rejects. Surfacing
      // this as a hard error gives us HPKE's contributory-behavior check.
      await expect(seal(new Uint8Array(32), plaintext())).rejects.toThrow(
        /not a valid curve point/
      );
    });

    it('rejects a malformed ephemeral public key on open', async () => {
      const keyPair = await deriveRunKeyPair(K);
      const sealed = await seal(keyPair.publicKey, plaintext());
      const tampered = new Uint8Array(sealed);
      // Zero out the ephemeral key — a low-order point.
      tampered.fill(0, 0, 32);

      await expect(open(keyPair, tampered)).rejects.toThrow(
        RuntimeDecryptionError
      );
    });
  });

  describe('cross-implementation validation', () => {
    it('derives the same public key as node:crypto for the same scalar', async () => {
      // `derivePublicKeyFromScalar` reads the public half out of a JWK export
      // because Web Crypto exposes no scalar-multiplication primitive. That is
      // subtle enough to be worth checking against an independent
      // implementation: Node's native X25519, reached through the same PKCS#8
      // wrapper. A mismatch would mean we publish public keys that do not
      // correspond to the scalars we decrypt with.
      const { createPrivateKey, createPublicKey } = await import('node:crypto');
      const { scalar, publicKey } = await deriveRunKeyPair(K);

      const pkcs8 = new Uint8Array(16 + 32);
      pkcs8.set(
        [
          0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65,
          0x6e, 0x04, 0x22, 0x04, 0x20,
        ],
        0
      );
      pkcs8.set(scalar, 16);

      const nodePrivate = createPrivateKey({
        key: Buffer.from(pkcs8),
        format: 'der',
        type: 'pkcs8',
      });
      const nodePublicRaw = createPublicKey(nodePrivate).export({
        format: 'jwk',
      }).x as string;

      expect(new Uint8Array(Buffer.from(nodePublicRaw, 'base64url'))).toEqual(
        publicKey
      );
    });
  });

  describe('streaming (amortized KEM)', () => {
    it('encrypts many frames under one encapsulation', async () => {
      const keyPair = await deriveRunKeyPair(K);
      const { ephemeralPublicKey, contentKey } = await encapsulate(
        keyPair.publicKey
      );

      const frames = ['alpha', 'beta', 'gamma'].map((f) => plaintext(f));
      const encrypted = [];
      for (const frame of frames) {
        encrypted.push(await aesGcmEncrypt(contentKey, frame));
      }

      const readerKey = await decapsulate(keyPair, ephemeralPublicKey);
      const decrypted = [];
      for (const frame of encrypted) {
        decrypted.push(decoder.decode(await aesGcmDecrypt(readerKey, frame)));
      }
      expect(decrypted).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('never repeats a (content key, nonce) pair across frames', async () => {
      const keyPair = await deriveRunKeyPair(K);
      const { contentKey } = await encapsulate(keyPair.publicKey);

      // Identical plaintext on every frame: any nonce reuse would show up as
      // byte-identical ciphertext, which under AES-GCM leaks the plaintext
      // XOR and the auth subkey.
      const nonces = new Set<string>();
      for (let i = 0; i < 200; i++) {
        const frame = await aesGcmEncrypt(contentKey, plaintext('same'));
        nonces.add(Array.from(frame.subarray(0, 12)).join(','));
      }
      expect(nonces.size).toBe(200);
    });

    it('derives a fresh content key per encapsulation, so reconnects and replays cannot collide', async () => {
      const keyPair = await deriveRunKeyPair(K);

      // Model a writer that reconnects (or replays) 25 times. Every
      // incarnation must get its own ephemeral key and content key so that
      // restarting frame numbering at zero is harmless.
      const ephemeralKeys = new Set<string>();
      const firstFrames = new Set<string>();
      for (let i = 0; i < 25; i++) {
        const { ephemeralPublicKey, contentKey } = await encapsulate(
          keyPair.publicKey
        );
        ephemeralKeys.add(Array.from(ephemeralPublicKey).join(','));
        const frame = await aesGcmEncrypt(contentKey, plaintext('frame-0'));
        firstFrames.add(Array.from(frame).join(','));
      }
      expect(ephemeralKeys.size).toBe(25);
      expect(firstFrames.size).toBe(25);
    });

    it('cannot decrypt frames from a different encapsulation', async () => {
      const keyPair = await deriveRunKeyPair(K);
      const first = await encapsulate(keyPair.publicKey);
      const second = await encapsulate(keyPair.publicKey);

      const frame = await aesGcmEncrypt(first.contentKey, plaintext());
      const wrongReaderKey = await decapsulate(
        keyPair,
        second.ephemeralPublicKey
      );

      await expect(aesGcmDecrypt(wrongReaderKey, frame)).rejects.toThrow(
        RuntimeDecryptionError
      );
    });
  });
});

describe('base64 helpers', () => {
  it('matches node:crypto Buffer encoding for random byte strings', () => {
    // Hand-rolled because the module must run in the browser and the VM; that
    // makes an independent cross-check worthwhile.
    for (const length of [0, 1, 2, 3, 4, 31, 32, 33, 64, 255]) {
      const bytes = new Uint8Array(length);
      globalThis.crypto.getRandomValues(bytes);
      const expected = Buffer.from(bytes).toString('base64');
      expect(bytesToBase64(bytes)).toBe(expected);
      expect(base64ToBytes(expected)).toEqual(bytes);
    }
  });

  it('round-trips a derived public key', async () => {
    const { publicKey } = await deriveRunKeyPair(K);
    const encoded = bytesToBase64(publicKey);
    // 32 bytes -> 44 base64 chars including padding.
    expect(encoded).toHaveLength(44);
    expect(base64ToBytes(encoded)).toEqual(publicKey);
  });

  it('returns undefined for malformed base64 rather than throwing', () => {
    // A corrupt public key read from storage must degrade to "no usable key"
    // (falling back to the symmetric path), not crash a resumption.
    expect(base64ToBytes('not valid base64!!')).toBeUndefined();
    expect(base64ToBytes('****')).toBeUndefined();
  });

  it('rejects malformed shapes instead of returning a truncated key', () => {
    // A lenient decoder is worse than a throwing one here: silently returning
    // a short key makes a corrupt value look *present*, so the caller seals to
    // garbage rather than taking the symmetric fallback.
    for (const bad of [
      'AAAAA', // length % 4 === 1: the trailing char encodes no byte
      'AA=A', // padding in the middle
      'A=AA',
      'AAA=A', // characters after padding
      'AB', // final quantum with non-zero unused bits
      'AAB',
      'AAAA=', // padding that does not land on a 4-char boundary
    ]) {
      expect(
        base64ToBytes(bad),
        `expected ${bad} to be rejected`
      ).toBeUndefined();
    }
  });

  it('accepts every canonical encoding Buffer produces', () => {
    // Guard against the strictness overshooting into false negatives.
    for (let length = 0; length <= 48; length++) {
      const bytes = new Uint8Array(length);
      globalThis.crypto.getRandomValues(bytes);
      const encoded = Buffer.from(bytes).toString('base64');
      expect(base64ToBytes(encoded), `length ${length}`).toEqual(bytes);
      // Unpadded form must decode identically.
      expect(
        base64ToBytes(encoded.replace(/=+$/, '')),
        `length ${length}`
      ).toEqual(bytes);
    }
  });

  it('tolerates missing padding', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const padded = bytesToBase64(bytes);
    expect(base64ToBytes(padded.replace(/=+$/, ''))).toEqual(bytes);
  });
});
