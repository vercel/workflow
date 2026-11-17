'use client';

import { Lock } from 'lucide-react';
import { type ReactNode, useContext } from 'react';
import { DecryptClickContext } from './data-inspector';
import { DecryptButton } from './decrypt-button';
import { Note, NoteAction, NoteContent } from './note';

/**
 * Shown in place of a value whose data has passed its retention window.
 */
export function ExpiredDataNote({
  children = 'This data has expired and is no longer available.',
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <Note variant="secondary" size="small" className={className}>
      <NoteContent>{children}</NoteContent>
    </Note>
  );
}

/**
 * Shown in place of a value that is still sealed with the run's key. Offers
 * the Decrypt action when a `DecryptClickContext` is provided.
 */
export function EncryptedDataNote({ className }: { className?: string }) {
  const decrypt = useContext(DecryptClickContext);
  return (
    <Note
      variant="secondary"
      size="small"
      icon={<Lock size={14} aria-hidden />}
      className={className}
    >
      <NoteContent>Encrypted with this run’s key.</NoteContent>
      {decrypt ? (
        <NoteAction>
          <DecryptButton
            loading={decrypt.isDecrypting}
            disabled={decrypt.isDecryptDisabled}
            disabledReason={decrypt.decryptDisabledReason}
            onClick={decrypt.onDecrypt}
          />
        </NoteAction>
      ) : null}
    </Note>
  );
}
