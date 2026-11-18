'use client';

import { Lock, LockOpen } from 'lucide-react';
import { Button } from './button';

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
 * Decrypt/Decrypted button: a small secondary `Button` with a lock prefix.
 * Three states: idle, decrypting (the spinner takes the lock's place) and
 * decrypted (green success, inert).
 */
export function DecryptButton({
  decrypted = false,
  loading = false,
  disabled = false,
  disabledReason,
  onClick,
}: DecryptButtonProps) {
  return (
    <Button
      variant="secondary"
      size="small"
      onClick={decrypted ? undefined : onClick}
      loading={loading}
      disabled={decrypted || disabled}
      title={disabled ? disabledReason : undefined}
      prefix={decrypted ? <LockOpen /> : <Lock />}
      // Decrypted is a success state rather than an unavailable one, so it
      // keeps the green fill instead of the disabled gray.
      className={
        decrypted
          ? 'disabled:cursor-default disabled:bg-green-100 disabled:text-green-900 disabled:[--themed-border:_var(--ds-green-400)] disabled:hover:bg-green-100'
          : undefined
      }
    >
      {decrypted ? 'Decrypted' : 'Decrypt'}
    </Button>
  );
}
