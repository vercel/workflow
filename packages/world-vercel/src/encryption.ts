/**
 * Vercel-specific key management for workflow encryption.
 *
 * This module handles:
 * - HKDF key derivation (deployment key + projectId + runId → per-run key)
 * - Cross-deployment key retrieval via the Vercel API
 *
 * The actual AES-GCM encrypt/decrypt operations are in @workflow/core/encryption
 * which is browser-compatible. This module is Node.js only (uses node:crypto
 * for HKDF and the Vercel API for key retrieval).
 */

import { webcrypto } from 'node:crypto';
import { getVercelOidcToken } from '@vercel/oidc';

const KEY_BYTES = 32; // 256 bits = 32 bytes (AES-256)

/**
 * Derive a per-run AES-256 encryption key using HKDF-SHA256.
 *
 * The derivation uses `projectId|runId` as the HKDF info parameter,
 * ensuring that each run has a unique encryption key even when sharing
 * the same deployment key.
 *
 * @param deploymentKey - Raw 32-byte deployment key
 * @param projectId - Vercel project ID for context isolation
 * @param runId - Workflow run ID for per-run key isolation
 * @returns Raw 32-byte AES-256 key
 */
export async function deriveRunKey(
  deploymentKey: Uint8Array,
  projectId: string,
  runId: string
): Promise<Uint8Array> {
  if (deploymentKey.length !== KEY_BYTES) {
    throw new Error(
      `Invalid deployment key length: expected ${KEY_BYTES} bytes for AES-256, got ${deploymentKey.length} bytes`
    );
  }
  if (!projectId || typeof projectId !== 'string') {
    throw new Error('projectId must be a non-empty string');
  }

  const baseKey = await webcrypto.subtle.importKey(
    'raw',
    deploymentKey,
    'HKDF',
    false,
    ['deriveBits']
  );

  const info = new TextEncoder().encode(`${projectId}|${runId}`);

  // Zero salt is acceptable per RFC 5869 Section 3.1 when the input key
  // material has high entropy (as is the case with our random deployment key).
  // The `info` parameter provides per-run context separation.
  const derivedBits = await webcrypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
      info,
    },
    baseKey,
    KEY_BYTES * 8 // bits
  );

  return new Uint8Array(derivedBits);
}

/**
 * Fetch the per-run encryption key from the Vercel API.
 *
 * The API performs HKDF-SHA256 derivation server-side, so the raw
 * deployment key never leaves the API boundary. The returned key
 * is ready-to-use for AES-GCM encrypt/decrypt operations.
 *
 * Uses OIDC token authentication (for cross-deployment runtime calls like
 * resumeHook) or falls back to VERCEL_TOKEN (for external tooling like o11y).
 *
 * @param deploymentId - The deployment ID that holds the base key material
 * @param projectId - The project ID for HKDF context isolation
 * @param runId - The workflow run ID for per-run key derivation
 * @param options.token - Auth token (from config). Falls back to OIDC or VERCEL_TOKEN.
 * @returns Derived 32-byte per-run AES-256 key
 */
export async function fetchRunKey(
  deploymentId: string,
  projectId: string,
  runId: string,
  options?: {
    /** Auth token (from config). Falls back to OIDC or VERCEL_TOKEN. */
    token?: string;
  }
): Promise<Uint8Array> {
  // Authenticate via provided token (CLI/config), OIDC token (runtime),
  // or VERCEL_TOKEN env var (external tooling)
  const oidcToken = await getVercelOidcToken().catch(() => null);
  const token = options?.token ?? oidcToken ?? process.env.VERCEL_TOKEN;
  if (!token) {
    throw new Error(
      'Cannot fetch run key: no OIDC token or VERCEL_TOKEN available'
    );
  }

  const params = new URLSearchParams({ projectId, runId });
  const response = await fetch(
    `https://api.vercel.com/v1/workflow/run-key/${deploymentId}?${params}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(
      `Failed to fetch run key for ${runId} (deployment ${deploymentId}): HTTP ${response.status}`
    );
  }

  const data = (await response.json()) as { key: string };
  return Uint8Array.from(Buffer.from(data.key, 'base64'));
}
