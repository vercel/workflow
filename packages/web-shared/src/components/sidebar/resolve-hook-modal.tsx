'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { useId, useRef, useState } from 'react';
import { cn } from '../../lib/cn';
import { Button } from '../ui/button';
import { Kbd } from '../ui/kbd';
import { Spinner } from '../ui/spinner';

interface ResolveHookModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback when the modal should be closed */
  onClose: () => void;
  /** Callback when the form is submitted with the parsed JSON payload */
  onSubmit: (payload: unknown) => Promise<void>;
  /** Whether the submission is in progress */
  isSubmitting?: boolean;
}

// Hoisted and deduped by React 19, so hosts that don't load this package's
// stylesheet still get the enter animation.
// `scale` is animated on its own so it composes with the centring translate.
const DIALOG_KEYFRAMES = `@keyframes wf-dialog-overlay-in{from{opacity:0}to{opacity:1}}@keyframes wf-dialog-content-in{from{opacity:0;scale:.96}to{opacity:1;scale:1}}`;

function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform ?? navigator.userAgent;
  return platform.toLowerCase().includes('mac');
}

/**
 * Parses the textarea contents. An empty field sends `null`.
 */
export function parseHookPayload(
  input: string
): { ok: true; payload: unknown } | { ok: false } {
  if (input.trim() === '') return { ok: true, payload: null };
  try {
    return { ok: true, payload: JSON.parse(input) };
  } catch {
    return { ok: false };
  }
}

/**
 * Modal for resolving a hook with a JSON payload.
 *
 * Focus is trapped while open, moves to the payload field on open and
 * returns to the trigger on close. Escape, the backdrop and Cancel close it,
 * except while a submission is in flight.
 */
export function ResolveHookModal({
  isOpen,
  onClose,
  onSubmit,
  isSubmitting = false,
}: ResolveHookModalProps): React.JSX.Element | null {
  return (
    <Dialog.Root
      open={isOpen}
      onOpenChange={(open) => {
        if (!open && !isSubmitting) onClose();
      }}
    >
      <Dialog.Portal>
        <style href="wf-dialog" precedence="default">
          {DIALOG_KEYFRAMES}
        </style>
        <Dialog.Overlay className="fixed inset-0 z-[300] bg-black/50 motion-safe:animate-[wf-dialog-overlay-in_300ms_cubic-bezier(0.175,0.885,0.32,1.1)]" />
        {/* Content unmounts on close, so the form's state resets with it. */}
        <ResolveHookForm
          onClose={onClose}
          onSubmit={onSubmit}
          isSubmitting={isSubmitting}
        />
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ResolveHookForm({
  onClose,
  onSubmit,
  isSubmitting,
}: Omit<ResolveHookModalProps, 'isOpen'> & { isSubmitting: boolean }) {
  const [jsonInput, setJsonInput] = useState('');
  const [parseError, setParseError] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fieldId = useId();
  const hintId = useId();
  const errorId = useId();

  const submit = async () => {
    if (isSubmitting) return;
    const parsed = parseHookPayload(jsonInput);
    if (!parsed.ok) {
      setParseError(true);
      textareaRef.current?.focus();
      return;
    }
    try {
      await onSubmit(parsed.payload);
    } catch {
      // The caller reports failures (for example with a toast). Keep the
      // modal open with the payload intact so it can be fixed and resent.
    }
  };

  return (
    <Dialog.Content
      className="fixed top-1/2 left-1/2 z-[300] flex max-h-[min(800px,80vh)] w-[540px] max-w-[calc(100vw-20px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl bg-background-100 text-gray-1000 shadow-[var(--ds-shadow-modal)] outline-none motion-safe:animate-[wf-dialog-content-in_300ms_cubic-bezier(0.175,0.885,0.32,1.1)]"
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        textareaRef.current?.focus();
      }}
    >
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain p-6">
          <Dialog.Title className="m-0 text-heading-20 text-gray-1000">
            Resolve Hook
          </Dialog.Title>
          <Dialog.Description className="mt-2 mb-5 text-copy-14 text-gray-900">
            Send a JSON value to the hook. Leave the field empty to send{' '}
            <code className="text-copy-13-mono text-gray-1000">null</code>.
          </Dialog.Description>

          <label
            htmlFor={fieldId}
            className="mb-2 block text-label-13 text-gray-900"
          >
            Payload
          </label>
          <textarea
            ref={textareaRef}
            id={fieldId}
            value={jsonInput}
            onChange={(e) => {
              setJsonInput(e.target.value);
              setParseError(false);
            }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                void submit();
              }
            }}
            disabled={isSubmitting}
            placeholder='{"approved": true}'
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-invalid={parseError || undefined}
            aria-describedby={parseError ? `${errorId} ${hintId}` : hintId}
            className={cn(
              'box-border h-40 w-full resize-none rounded-md border-0 bg-background-100 px-3 py-2.5 text-label-13-mono text-gray-1000 outline-none transition-shadow duration-150 placeholder:text-gray-700',
              'shadow-[0_0_0_1px_var(--ds-gray-alpha-400)] hover:shadow-[0_0_0_1px_var(--ds-gray-alpha-500)] focus:shadow-[0_0_0_1px_var(--ds-gray-alpha-600),0_0_0_4px_var(--ds-gray-alpha-300)]',
              'disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-700',
              parseError &&
                'shadow-[0_0_0_1px_var(--ds-red-800),0_0_0_4px_var(--ds-red-300)] hover:shadow-[0_0_0_1px_var(--ds-red-800),0_0_0_4px_var(--ds-red-300)] focus:shadow-[0_0_0_1px_var(--ds-red-800),0_0_0_4px_var(--ds-red-300)]'
            )}
          />
          {parseError && (
            <p id={errorId} className="mt-2 mb-0 text-copy-13 text-red-800">
              Couldn’t parse the payload as JSON. Fix it, or clear the field to
              send <code className="text-copy-13-mono">null</code>.
            </p>
          )}
          <p
            id={hintId}
            className="mt-2 mb-0 flex items-center gap-1 text-copy-13 text-gray-900"
          >
            Press
            <Kbd variant="outline">{isMacPlatform() ? '⌘' : 'Ctrl'}</Kbd>
            <Kbd variant="outline">Enter</Kbd>
            to send
          </p>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-4 bg-background-200 p-3 shadow-[0_-1px_0_0_var(--ds-gray-alpha-400)]">
          <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" aria-busy={isSubmitting || undefined}>
            {isSubmitting && <Spinner size={16} color="currentColor" />}
            Send Payload
          </Button>
        </div>
      </form>
    </Dialog.Content>
  );
}
