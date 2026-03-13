'use client';

import { Spinner } from './spinner';

const STYLES = `.wf-decrypt-btn{appearance:none;-webkit-appearance:none;border:none;display:inline-flex;align-items:center;justify-content:center;height:40px;padding:0 12px;border-radius:6px;font-size:14px;font-weight:500;line-height:20px;cursor:pointer;white-space:nowrap;gap:6px;transition:background 150ms}.wf-decrypt-idle{color:var(--ds-gray-1000);background:var(--ds-background-100);box-shadow:0 0 0 1px var(--ds-gray-400)}.wf-decrypt-idle:hover{background:var(--ds-gray-alpha-200)}.wf-decrypt-done{color:var(--ds-green-900);background:var(--ds-green-100);box-shadow:0 0 0 1px var(--ds-green-400);cursor:default}`;

interface DecryptButtonProps {
  /** Whether an encryption key has been obtained (decryption is active). */
  decrypted?: boolean;
  /** Whether the key is currently being fetched. */
  loading?: boolean;
  /** Called when the user clicks to initiate decryption. */
  onClick?: () => void;
}

/**
 * Decrypt/Decrypted button using Geist secondary style.
 * Three states: idle (secondary gray), decrypting (spinner), decrypted (green success).
 */
export function DecryptButton({
  decrypted = false,
  loading = false,
  onClick,
}: DecryptButtonProps) {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      <button
        type="button"
        onClick={decrypted ? undefined : onClick}
        disabled={decrypted || loading}
        className={`wf-decrypt-btn ${decrypted ? 'wf-decrypt-done' : 'wf-decrypt-idle'}`}
      >
        {loading ? (
          <Spinner size={14} />
        ) : decrypted ? (
          <svg
            width={14}
            height={14}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 9.9-1" />
          </svg>
        ) : (
          <svg
            width={14}
            height={14}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        )}
        {loading ? 'Decrypting…' : decrypted ? 'Decrypted' : 'Decrypt'}
      </button>
    </>
  );
}
