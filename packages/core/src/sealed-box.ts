import { RuntimeDecryptionError, WorkflowRuntimeError } from '@workflow/errors';
import {
  decrypt as aesGcmDecrypt,
  encrypt as aesGcmEncrypt,
  type CryptoKey,
  NONCE_LENGTH,
  TAG_BYTES,
} from './encryption.js';

/**
 * Browser-compatible sealed-box (asymmetric) encryption for cross-run writes.
 *
 * ## Why this exists
 *
 * The symmetric `encr` path requires the writer to hold the recipient run's
 * key — which also grants decrypt capability. For *cross-run* writes (a hook
 * resumption targeting another run, or a child workflow writing into a
 * parent's forwarded `WritableStream`) that is more authority than the writer
 * needs, and obtaining the symmetric key across a deployment boundary costs a
 * round trip to the Vercel API.
 *
 * A sealed box fixes both: the writer needs only the recipient's **public**
 * key, which is not secret and therefore travels on the run entity (and in
 * stream descriptors) at no cost. "Encrypt-only" stops being an honor-system
 * convention enforced by `importKey(raw, ['encrypt'])` and becomes a
 * cryptographic guarantee — a writer holding just the public key provably
 * cannot read anything.
 *
 * ## Key hierarchy
 *
 * Both keys descend from the same per-run key material `K` that
 * `World.getEncryptionKeyForRun()` already returns today, so nothing about
 * key acquisition, the World interface, or the Vercel API changes:
 *
 * ```
 * K  (32 bytes, per-run, = HKDF(VERCEL_DEPLOYMENT_KEY, "projectId|runId"))
 * ├── AES-256 key = K used directly            → 'encr' envelopes (unchanged)
 * └── X25519 scalar = HKDF(K, SCALAR_INFO)     → 'encp' envelopes
 *     └── public key = X25519 basepoint · scalar   (published, not secret)
 * ```
 *
 * `K` is therefore both an AEAD key and a key-derivation key. This is sound:
 * AES-GCM never exposes its key, and HKDF-SHA256 output is computationally
 * independent of the AES keystream. A strict reading of NIST SP 800-108
 * prefers these roles be separated, but `K`'s direct AES use is fixed by
 * backward compatibility with every `encr` payload already written.
 *
 * ## Construction
 *
 * An ECIES-style sealed box using the same primitives as HPKE (RFC 9180)
 * base mode with DHKEM(X25519, HKDF-SHA256) and AES-256-GCM, but without the
 * full `LabeledExtract`/`LabeledExpand` suite-ID ceremony:
 *
 * ```
 * ephemeral    = X25519 keypair, freshly generated per encryption context
 * sharedSecret = X25519(ephemeralPrivate, recipientPublic)
 * contentKey   = HKDF-SHA256(
 *                  ikm  = sharedSecret,
 *                  salt = zeros(32),
 *                  info = CONTENT_KEY_INFO ‖ ephemeralPublic ‖ recipientPublic,
 *                )
 * ```
 *
 * Binding both public keys into `info` is the security-critical part (it is
 * HPKE's `kem_context`): it prevents key-substitution/unknown-key-share
 * attacks in which an adversary replays a ciphertext as though it had been
 * sealed to a different recipient. Deviating from strict RFC 9180 framing is
 * a deliberate, documented choice — the envelope is versioned via its format
 * prefix and the HKDF labels below, so a conformant profile can be added
 * later as a new version without touching existing payloads.
 *
 * Wire format (the `encp` format prefix is attached by the serialization
 * layer, not by this module):
 *
 * ```
 * [ephemeral public key (32 bytes)][nonce (12 bytes)][ciphertext + GCM tag (16 bytes)]
 * ```
 *
 * ## Nonce discipline
 *
 * One-shot {@link seal} generates a fresh ephemeral keypair — and therefore a
 * fresh content key — for every call, so nonce reuse is impossible.
 *
 * Callers that amortize the KEM across many frames via {@link encapsulate}
 * take on nonce discipline themselves, because the content key then outlives a
 * single message. Two rules apply:
 *
 * 1. Every frame MUST use a fresh random nonce (which `aesGcmEncrypt` does).
 *    Never a counter: a counter restarts at zero after a stream reconnect or a
 *    durable replay, reusing `(contentKey, nonce)` — which under AES-GCM leaks
 *    the plaintext XOR of the two frames and the GCM auth subkey.
 * 2. A writer must not inherit a previous incarnation's content key, so
 *    {@link encapsulate} is re-run per writer instance.
 *
 * Nothing in this module enforces either rule; it is the streaming caller's
 * contract.
 */

/** Length of an X25519 private scalar and public key, in bytes. */
const X25519_KEY_LENGTH = 32;

/** Length of the AES-256 content key derived from the shared secret. */
const CONTENT_KEY_LENGTH = 32;

/**
 * HKDF `info` label for deriving the per-run X25519 scalar from the per-run
 * key material.
 *
 * Versioned and namespaced so that any future derivation from the same `K`
 * (a second keypair, a MAC key, a different curve) can never collide with
 * this one.
 */
const SCALAR_INFO = 'workflow/encp/x25519/v1';

/**
 * HKDF `info` prefix for deriving the AES-256-GCM content key from an X25519
 * shared secret. The ephemeral and recipient public keys are appended to this
 * label to form the full `info` (HPKE's `kem_context`).
 */
const CONTENT_KEY_INFO = 'workflow/encp/aes256gcm/v1';

/**
 * DER prefix for an RFC 8410 `PrivateKeyInfo` wrapping a raw X25519 scalar.
 *
 * Web Crypto cannot import a raw X25519 private key (`importKey('raw', ...)`
 * is only defined for public keys on the Secure Curves algorithms), so a
 * derived scalar has to be wrapped in PKCS#8 before it can be used. The
 * structure is fully determined for a 32-byte X25519 key:
 *
 * ```
 * SEQUENCE (46 bytes)                         30 2e
 *   INTEGER 0                                 02 01 00
 *   SEQUENCE (5 bytes)                        30 05
 *     OBJECT IDENTIFIER 1.3.101.110 (X25519)  06 03 2b 65 6e
 *   OCTET STRING (34 bytes)                   04 22
 *     OCTET STRING (32 bytes)                 04 20
 *       <scalar>
 * ```
 */
const PKCS8_X25519_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04,
  0x22, 0x04, 0x20,
]);

const infoEncoder = new TextEncoder();

/**
 * A per-run X25519 keypair, derived from the run's key material.
 *
 * Callers should derive this once per run and memoize it alongside the
 * symmetric key — derivation costs several Web Crypto round trips.
 */
export interface RunKeyPair {
  /** Raw 32-byte X25519 private scalar. Secret. */
  readonly scalar: Uint8Array;
  /** Raw 32-byte X25519 public key. Safe to publish. */
  readonly publicKey: Uint8Array;
}

function assertKeyMaterialLength(runKeyMaterial: Uint8Array): void {
  if (runKeyMaterial.byteLength !== CONTENT_KEY_LENGTH) {
    throw new WorkflowRuntimeError(
      `Run key material must be exactly ${CONTENT_KEY_LENGTH} bytes, got ${runKeyMaterial.byteLength}`
    );
  }
}

function assertPublicKeyLength(publicKey: Uint8Array, label: string): void {
  if (publicKey.byteLength !== X25519_KEY_LENGTH) {
    throw new WorkflowRuntimeError(
      `${label} must be exactly ${X25519_KEY_LENGTH} bytes, got ${publicKey.byteLength}`
    );
  }
}

/**
 * Derive the per-run X25519 keypair from the run's 32-byte key material.
 *
 * Deterministic: the same key material always yields the same keypair, which
 * is what lets the owning deployment re-derive its private scalar on demand
 * (from `VERCEL_DEPLOYMENT_KEY`) instead of storing it anywhere.
 *
 * @param runKeyMaterial - The 32 bytes returned by `World.getEncryptionKeyForRun()`
 * @returns The run's X25519 scalar and public key
 */
export async function deriveRunKeyPair(
  runKeyMaterial: Uint8Array
): Promise<RunKeyPair> {
  assertKeyMaterialLength(runKeyMaterial);

  const hkdfKey = await globalThis.crypto.subtle.importKey(
    'raw',
    runKeyMaterial,
    'HKDF',
    false,
    ['deriveBits']
  );

  // Zero salt is acceptable per RFC 5869 §3.1: the IKM here is itself HKDF
  // output (or a high-entropy BYOK value), so it is already uniform. The
  // `info` label provides domain separation.
  const scalarBits = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: infoEncoder.encode(SCALAR_INFO),
    },
    hkdfKey,
    X25519_KEY_LENGTH * 8
  );
  const scalar = new Uint8Array(scalarBits);

  // Any 32-byte string is a valid X25519 scalar (the low/high bits are
  // clamped during scalar multiplication), so the HKDF output needs no
  // rejection sampling.
  const publicKey = await derivePublicKeyFromScalar(scalar);
  return { scalar, publicKey };
}

/**
 * Recover the raw public key for a scalar.
 *
 * Web Crypto exposes no scalar-multiplication primitive, so the scalar is
 * imported as a PKCS#8 private key and its public half read back out of the
 * JWK export (`x`), which the Secure Curves spec defines as the base64url
 * raw public key.
 */
async function derivePublicKeyFromScalar(
  scalar: Uint8Array
): Promise<Uint8Array> {
  const privateKey = await importScalar(scalar, /* extractable */ true);
  const jwk = await globalThis.crypto.subtle.exportKey('jwk', privateKey);
  if (!jwk.x) {
    throw new WorkflowRuntimeError(
      'X25519 JWK export did not include a public key component ("x")'
    );
  }
  const publicKey = base64UrlToBytes(jwk.x);
  // Guard the one step in this module that trusts an external encoding. A
  // short or malformed value here would otherwise flow onward and fail much
  // later, inside key agreement, with a far less obvious message.
  if (publicKey.byteLength !== X25519_KEY_LENGTH) {
    throw new WorkflowRuntimeError(
      `X25519 JWK export produced a ${publicKey.byteLength}-byte public key, expected ${X25519_KEY_LENGTH}`
    );
  }
  return publicKey;
}

async function importScalar(
  scalar: Uint8Array,
  extractable: boolean
): Promise<CryptoKey> {
  const pkcs8 = new Uint8Array(PKCS8_X25519_PREFIX.length + scalar.byteLength);
  pkcs8.set(PKCS8_X25519_PREFIX, 0);
  pkcs8.set(scalar, PKCS8_X25519_PREFIX.length);
  return globalThis.crypto.subtle.importKey(
    'pkcs8',
    pkcs8,
    { name: 'X25519' },
    extractable,
    ['deriveBits']
  );
}

function importPublicKey(publicKey: Uint8Array): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    'raw',
    publicKey,
    { name: 'X25519' },
    /* extractable */ true,
    // Public keys carry no usages for X25519 — the private key does the
    // deriving; the public key is only ever an argument to it.
    []
  );
}

const BASE64_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const BASE64URL_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Encode bytes as standard (padded) base64.
 *
 * Hand-rolled for the same reason as {@link base64UrlToBytes}: this module
 * runs in the browser (o11y decryption) and inside the workflow VM, so neither
 * `Buffer` nor `btoa` can be assumed. Used for the wire encoding of run public
 * keys, matching the base64 convention already used for `VERCEL_DEPLOYMENT_KEY`
 * and the `run-key` API response.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;

    out += BASE64_CHARS[(b0 >> 2) & 0x3f];
    out += BASE64_CHARS[((b0 & 0x03) << 4) | ((b1 >> 4) & 0x0f)];
    out +=
      i + 1 < bytes.length
        ? BASE64_CHARS[((b1 & 0x0f) << 2) | ((b2 >> 6) & 0x03)]
        : '=';
    out += i + 2 < bytes.length ? BASE64_CHARS[b2 & 0x3f] : '=';
  }
  return out;
}

/**
 * Decode standard base64 (padding optional) to bytes.
 *
 * Returns `undefined` for malformed input rather than throwing: callers decode
 * public keys that arrive from storage or over the wire, where a corrupt value
 * should degrade to "this run has no usable public key" (and fall back to the
 * symmetric path) rather than crash a resumption.
 *
 * Validation is strict, because a lenient decoder is worse than a throwing one
 * here — silently returning a short or truncated key makes a corrupt value look
 * *present*, so the caller seals to garbage instead of taking the fallback.
 * Rejected: characters outside the alphabet, a length that cannot describe a
 * whole number of bytes (`length % 4 === 1`), padding anywhere but the end, and
 * a final quantum whose unused low bits are not zero.
 */
export function base64ToBytes(value: string): Uint8Array | undefined {
  // Strip trailing padding, then require what remains to be padding-free.
  let end = value.length;
  while (end > 0 && value[end - 1] === '=') end--;
  const body = value.slice(0, end);
  if (body.includes('=')) return undefined;

  // 4 chars -> 3 bytes; 3 -> 2; 2 -> 1. A remainder of 1 encodes no byte.
  if (body.length % 4 === 1) return undefined;
  // Padding, when present, must bring the total to a multiple of 4.
  if (end !== value.length && value.length % 4 !== 0) return undefined;

  let accumulator = 0;
  let bitCount = 0;
  const bytes: number[] = [];

  for (let i = 0; i < body.length; i++) {
    const index = BASE64_CHARS.indexOf(body[i]);
    if (index === -1) return undefined;
    accumulator = (accumulator << 6) | index;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((accumulator >> bitCount) & 0xff);
    }
  }

  // Leftover bits belong to no byte and must be zero in canonical base64.
  if (bitCount > 0 && (accumulator & ((1 << bitCount) - 1)) !== 0) {
    return undefined;
  }

  return new Uint8Array(bytes);
}

/**
 * Decode a base64url string (JWK encoding) to bytes.
 *
 * Hand-rolled rather than using `atob` or `Buffer`: this module also runs
 * inside the workflow VM, whose global surface is deliberately minimal and
 * does not include either. The inputs here are fixed-size JWK key components,
 * so a compact decoder is sufficient — it accepts unpadded base64url only,
 * which is what RFC 7515 §2 mandates for JWK members.
 */
function base64UrlToBytes(value: string): Uint8Array {
  let accumulator = 0;
  let bitCount = 0;
  const bytes: number[] = [];

  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === '=') break;
    const index = BASE64URL_CHARS.indexOf(char);
    if (index === -1) {
      throw new WorkflowRuntimeError(
        `Invalid base64url character "${char}" in X25519 JWK key component`
      );
    }
    accumulator = (accumulator << 6) | index;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((accumulator >> bitCount) & 0xff);
    }
  }

  return new Uint8Array(bytes);
}

/**
 * Derive the AES-256-GCM content key from an X25519 shared secret, binding
 * it to both public keys (HPKE's `kem_context`).
 */
async function deriveContentKey(
  sharedSecret: Uint8Array,
  ephemeralPublicKey: Uint8Array,
  recipientPublicKey: Uint8Array,
  usages: ReadonlyArray<'encrypt' | 'decrypt'>
): Promise<CryptoKey> {
  const label = infoEncoder.encode(CONTENT_KEY_INFO);
  const info = new Uint8Array(
    label.length + ephemeralPublicKey.length + recipientPublicKey.length
  );
  info.set(label, 0);
  info.set(ephemeralPublicKey, label.length);
  info.set(recipientPublicKey, label.length + ephemeralPublicKey.length);

  const hkdfKey = await globalThis.crypto.subtle.importKey(
    'raw',
    sharedSecret,
    'HKDF',
    false,
    ['deriveBits']
  );
  const contentKeyBits = await globalThis.crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info },
    hkdfKey,
    CONTENT_KEY_LENGTH * 8
  );

  return globalThis.crypto.subtle.importKey(
    'raw',
    new Uint8Array(contentKeyBits),
    'AES-GCM',
    false,
    // `KeyUsage` is a DOM-lib type that is not in scope under `es2022`; the
    // parameter type is a strict subset of it, so this cast is sound.
    usages as ('encrypt' | 'decrypt')[]
  );
}

/**
 * The writer half of the KEM: generate an ephemeral keypair and derive a
 * content key for a recipient's public key.
 *
 * Use this when many payloads share one KEM operation — i.e. stream frames.
 * The returned `contentKey` can only encrypt, so a stream writer provably
 * cannot read the recipient run's data even by mistake.
 *
 * **Callers own nonce discipline.** Encrypt each frame with a fresh random
 * nonce, and call this function again for every new connection attempt or
 * replay so that a restarted writer never reuses a content key. For one-shot
 * payloads prefer {@link seal}, which handles this automatically.
 *
 * @param recipientPublicKey - The recipient run's raw 32-byte X25519 public key
 * @returns The ephemeral public key to publish alongside the ciphertext, and
 *   the encrypt-only content key
 */
export async function encapsulate(recipientPublicKey: Uint8Array): Promise<{
  ephemeralPublicKey: Uint8Array;
  contentKey: CryptoKey;
}> {
  assertPublicKeyLength(recipientPublicKey, 'Recipient public key');

  let recipientKey: CryptoKey;
  try {
    recipientKey = await importPublicKey(recipientPublicKey);
  } catch (cause) {
    throw new WorkflowRuntimeError(
      `Invalid X25519 recipient public key: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    );
  }

  const ephemeral = (await globalThis.crypto.subtle.generateKey(
    { name: 'X25519' },
    /* extractable */ true,
    ['deriveBits']
  )) as { privateKey: CryptoKey; publicKey: CryptoKey };

  const ephemeralPublicKey = new Uint8Array(
    await globalThis.crypto.subtle.exportKey('raw', ephemeral.publicKey)
  );

  let sharedSecretBits: ArrayBuffer;
  try {
    sharedSecretBits = await globalThis.crypto.subtle.deriveBits(
      { name: 'X25519', public: recipientKey },
      ephemeral.privateKey,
      X25519_KEY_LENGTH * 8
    );
  } catch (cause) {
    // Web Crypto throws OperationError when the shared secret is all-zero,
    // which happens exactly when the recipient public key is a low-order
    // point. This is the platform giving us HPKE's contributory-behavior
    // check for free.
    throw new WorkflowRuntimeError(
      'X25519 key agreement failed: the recipient public key is not a valid ' +
        'curve point (low-order point or corrupted key material)',
      { cause }
    );
  }

  const contentKey = await deriveContentKey(
    new Uint8Array(sharedSecretBits),
    ephemeralPublicKey,
    recipientPublicKey,
    ['encrypt']
  );

  return { ephemeralPublicKey, contentKey };
}

/**
 * The recipient half of the KEM: recover the content key for a sealed
 * payload from the run's own keypair and the sender's ephemeral public key.
 *
 * @param keyPair - The recipient run's keypair, from {@link deriveRunKeyPair}
 * @param ephemeralPublicKey - The sender's raw 32-byte X25519 public key,
 *   read from the head of the sealed envelope
 * @returns A decrypt-only content key
 */
export async function decapsulate(
  keyPair: RunKeyPair,
  ephemeralPublicKey: Uint8Array
): Promise<CryptoKey> {
  if (ephemeralPublicKey.byteLength !== X25519_KEY_LENGTH) {
    throw new RuntimeDecryptionError(
      `Sealed payload has a malformed ephemeral public key: expected ${X25519_KEY_LENGTH} bytes, got ${ephemeralPublicKey.byteLength}`,
      {
        context: {
          operation: 'decrypt',
          byteLength: ephemeralPublicKey.byteLength,
        },
      }
    );
  }

  let sharedSecretBits: ArrayBuffer;
  try {
    const [privateKey, senderKey] = await Promise.all([
      importScalar(keyPair.scalar, /* extractable */ false),
      importPublicKey(ephemeralPublicKey),
    ]);
    sharedSecretBits = await globalThis.crypto.subtle.deriveBits(
      { name: 'X25519', public: senderKey },
      privateKey,
      X25519_KEY_LENGTH * 8
    );
  } catch (cause) {
    throw new RuntimeDecryptionError(
      `X25519 key agreement failed while opening a sealed payload: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        cause,
        context: {
          operation: 'decrypt',
          byteLength: ephemeralPublicKey.byteLength,
        },
      }
    );
  }

  return deriveContentKey(
    new Uint8Array(sharedSecretBits),
    ephemeralPublicKey,
    keyPair.publicKey,
    ['decrypt']
  );
}

/**
 * Seal a payload to a run's public key.
 *
 * Each call performs its own KEM operation, so every sealed payload gets an
 * independent content key — nonce reuse across calls is impossible by
 * construction.
 *
 * @param recipientPublicKey - The recipient run's raw 32-byte X25519 public key
 * @param data - Plaintext to seal
 * @param aad - Optional additional authenticated data, covered by the GCM tag
 *   but not encrypted. Callers pass the recipient's `projectId|runId` so a
 *   sealed payload cannot be replayed against a different run.
 * @returns `[ephemeral public key (32)][nonce (12)][ciphertext + tag]`
 */
export async function seal(
  recipientPublicKey: Uint8Array,
  data: Uint8Array,
  aad?: Uint8Array
): Promise<Uint8Array> {
  const { ephemeralPublicKey, contentKey } =
    await encapsulate(recipientPublicKey);
  const encrypted = await aesGcmEncrypt(contentKey, data, aad);

  const result = new Uint8Array(
    ephemeralPublicKey.byteLength + encrypted.byteLength
  );
  result.set(ephemeralPublicKey, 0);
  result.set(encrypted, ephemeralPublicKey.byteLength);
  return result;
}

/**
 * Open a payload sealed to this run's public key.
 *
 * @param keyPair - The recipient run's keypair, from {@link deriveRunKeyPair}
 * @param sealed - `[ephemeral public key (32)][nonce (12)][ciphertext + tag]`
 * @param aad - The exact additional authenticated data passed to {@link seal}
 * @returns The decrypted plaintext
 */
export async function open(
  keyPair: RunKeyPair,
  sealed: Uint8Array,
  aad?: Uint8Array
): Promise<Uint8Array> {
  // Ephemeral public key + AES-GCM nonce + AES-GCM tag.
  const minLength = X25519_KEY_LENGTH + NONCE_LENGTH + TAG_BYTES;
  if (sealed.byteLength < minLength) {
    throw new RuntimeDecryptionError(
      `Sealed payload too short: expected at least ${minLength} bytes, got ${sealed.byteLength}`,
      { context: { operation: 'decrypt', byteLength: sealed.byteLength } }
    );
  }

  const ephemeralPublicKey = sealed.subarray(0, X25519_KEY_LENGTH);
  const encrypted = sealed.subarray(X25519_KEY_LENGTH);
  const contentKey = await decapsulate(keyPair, ephemeralPublicKey);
  return aesGcmDecrypt(contentKey, encrypted, aad);
}

/**
 * A writer-side session that amortizes one KEM operation across many sealed
 * payloads — use it for streams, where one-shot {@link seal} would perform a
 * fresh keygen + ECDH + HKDF for every frame.
 *
 * Safety rests on two properties:
 *
 * - Every payload still gets a **fresh random nonce** from `aesGcmEncrypt`, so
 *   sharing the content key does not risk `(key, nonce)` reuse. (A counter
 *   would: it restarts at zero whenever a writer restarts.)
 * - The session is bound to one writer instance. A reconnect or a durable
 *   replay constructs a new session, so a restarted writer never inherits a
 *   previous incarnation's content key.
 *
 * The envelope layout is byte-identical to {@link seal}, so a reader cannot
 * tell which was used and needs no matching session.
 */
export function createSealSession(
  recipientPublicKey: Uint8Array,
  aad?: Uint8Array
): { seal(data: Uint8Array): Promise<Uint8Array> } {
  let encapsulation:
    | Promise<{ ephemeralPublicKey: Uint8Array; contentKey: CryptoKey }>
    | undefined;

  return {
    async seal(data: Uint8Array): Promise<Uint8Array> {
      // Lazily, so constructing a session for a stream that is never written
      // to costs nothing.
      encapsulation ??= encapsulate(recipientPublicKey);
      const { ephemeralPublicKey, contentKey } = await encapsulation;
      const encrypted = await aesGcmEncrypt(contentKey, data, aad);

      const result = new Uint8Array(
        ephemeralPublicKey.byteLength + encrypted.byteLength
      );
      result.set(ephemeralPublicKey, 0);
      result.set(encrypted, ephemeralPublicKey.byteLength);
      return result;
    },
  };
}

/**
 * A reader-side session that caches decapsulation per sender.
 *
 * The mirror of {@link createSealSession}: because every frame from one writer
 * carries the same ephemeral public key, this turns an ECDH per frame into an
 * ECDH per writer. Correctness does not depend on the writer having used a
 * session — a stream of independently sealed payloads simply misses the cache
 * on each new ephemeral key.
 *
 * The cache is keyed by the ephemeral public key and holds one entry, which is
 * the common case (one writer per stream). A second writer evicts the first
 * rather than growing without bound.
 */
export function createOpenSession(
  keyPair: RunKeyPair,
  aad?: Uint8Array
): { open(sealed: Uint8Array): Promise<Uint8Array> } {
  let cachedSender: string | undefined;
  let cachedKey: Promise<CryptoKey> | undefined;

  return {
    async open(sealed: Uint8Array): Promise<Uint8Array> {
      const minLength = X25519_KEY_LENGTH + NONCE_LENGTH + TAG_BYTES;
      if (sealed.byteLength < minLength) {
        throw new RuntimeDecryptionError(
          `Sealed payload too short: expected at least ${minLength} bytes, got ${sealed.byteLength}`,
          { context: { operation: 'decrypt', byteLength: sealed.byteLength } }
        );
      }

      const ephemeralPublicKey = sealed.subarray(0, X25519_KEY_LENGTH);
      const encrypted = sealed.subarray(X25519_KEY_LENGTH);

      const sender = keyCacheId(ephemeralPublicKey);
      if (sender !== cachedSender || !cachedKey) {
        cachedSender = sender;
        cachedKey = decapsulate(keyPair, ephemeralPublicKey);
      }

      let contentKey: CryptoKey;
      try {
        contentKey = await cachedKey;
      } catch (error) {
        // Do not let one bad frame poison the cache for subsequent frames.
        cachedSender = undefined;
        cachedKey = undefined;
        throw error;
      }

      return aesGcmDecrypt(contentKey, encrypted, aad);
    },
  };
}

/** Stable cache key for a 32-byte public key. */
function keyCacheId(publicKey: Uint8Array): string {
  let id = '';
  for (let i = 0; i < publicKey.length; i++) {
    id += publicKey[i].toString(16).padStart(2, '0');
  }
  return id;
}

/**
 * Build the additional authenticated data that binds a sealed payload to a
 * specific run.
 *
 * Mirrors the `info` used for symmetric per-run key derivation so the two
 * schemes agree on what "this run" means.
 *
 * Note that the sealed-box construction already binds a payload to its
 * recipient without any AAD: the content key is derived over
 * `ephemeralPublicKey ‖ recipientPublicKey`, and a recipient public key is
 * unique per (deployment key × project × run). Replaying a sealed payload at
 * a different run therefore fails at key agreement regardless. AAD is
 * available for callers that want an additional, KDF-independent binding —
 * both sides must supply byte-identical values or the payload will not open.
 */
export function runAad(projectId: string, runId: string): Uint8Array {
  return infoEncoder.encode(`${projectId}|${runId}`);
}

/**
 * Decode a run's published public key, validating both encoding and length.
 *
 * Returns `undefined` when the value is absent, not valid base64, or not
 * exactly 32 bytes. Callers treat that as "this run has no usable public key"
 * and fall back to the symmetric path, so a corrupt or truncated stored value
 * degrades to the pre-existing behavior instead of failing a resumption.
 */
export function decodeRunPublicKey(
  value: string | undefined
): Uint8Array | undefined {
  if (!value) return undefined;
  const bytes = base64ToBytes(value);
  if (!bytes || bytes.byteLength !== X25519_KEY_LENGTH) return undefined;
  return bytes;
}
