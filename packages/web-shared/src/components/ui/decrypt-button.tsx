'use client';

import { STATUS_TONES } from '../../lib/status';
import { Spinner } from './spinner';

/** Decrypting is a positive action outcome, so the done state is blue. */
const DONE = STATUS_TONES.positive.hue;

const STYLES = `.wf-decrypt-btn{appearance:none;-webkit-appearance:none;border:none;display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 10px;border-radius:6px;font-size:14px;font-weight:500;line-height:20px;cursor:pointer;white-space:nowrap;gap:6px;transition:background 150ms}.wf-decrypt-idle{color:var(--ds-gray-1000);background:var(--ds-background-100);box-shadow:0 0 0 1px var(--ds-gray-400)}.wf-decrypt-idle:hover{background:var(--ds-gray-alpha-200)}.wf-decrypt-btn:disabled{cursor:not-allowed;opacity:.5}.wf-decrypt-done{color:var(--ds-${DONE}-900);background:var(--ds-${DONE}-100);box-shadow:0 0 0 1px var(--ds-${DONE}-400);cursor:default}`;

interface DecryptButtonProps {
  /** Whether an encryption key has been obtained (decryption is active). */
  decrypted?: boolean;
  /** Whether the key is currently being fetched. */
  loading?: boolean;
  /** Whether decryption is unavailable. */
  disabled?: boolean;
  /** Explains why decryption is unavailable. */
  disabledReason?: string;
  /** Called when the user clicks to initiate decryption. */
  onClick?: () => void;
}

/**
 * Decrypt/Decrypted button using Geist secondary style.
 * Three states: idle (secondary gray), decrypting (spinner), decrypted (blue positive outcome).
 */
export function DecryptButton({
  decrypted = false,
  loading = false,
  disabled = false,
  disabledReason,
  onClick,
}: DecryptButtonProps) {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      <button
        type="button"
        onClick={decrypted ? undefined : onClick}
        disabled={decrypted || loading || disabled}
        title={disabled ? disabledReason : undefined}
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
