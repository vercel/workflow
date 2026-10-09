/**
 * Per-run encryption keys: HKDF-SHA256 over a Worker secret, with the run id
 * as context, the same construction `@workflow/world-vercel` uses with its
 * deployment key. Core encrypts run payloads with the key and, because a run
 * has one, also encrypts VM snapshots (it refuses to store them unencrypted).
 *
 * The secret is `WORKFLOW_ENCRYPTION_SECRET` (base64, 32 bytes). Without it
 * the World returns no key and data is stored unencrypted.
 */
import type { WorkflowRun } from '@workflow/world';

function secretBytes(): Uint8Array<ArrayBuffer> | undefined {
  const raw = process.env.WORKFLOW_ENCRYPTION_SECRET;
  if (!raw) return undefined;
  const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  if (bytes.length !== 32) {
    throw new Error('WORKFLOW_ENCRYPTION_SECRET must be 32 bytes of base64');
  }
  return bytes;
}

export async function getEncryptionKeyForRun(
  run: WorkflowRun | string
): Promise<Uint8Array | undefined> {
  const secret = secretBytes();
  if (!secret) return undefined;
  const runId = typeof run === 'string' ? run : run.runId;
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: new TextEncoder().encode(`workflow-cloudflare|${runId}`),
    },
    base,
    256
  );
  return new Uint8Array(bits);
}
