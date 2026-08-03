'use client';

import { Send, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/cn';

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

/**
 * Modal component for resolving a hook by entering a JSON payload.
 *
 * Styled to match the Geist design-system dialog component used in the
 * Vercel dashboard so it looks native when rendered inside `front`.
 */
export function ResolveHookModal({
  isOpen,
  onClose,
  onSubmit,
  isSubmitting = false,
}: ResolveHookModalProps): React.JSX.Element | null {
  const [jsonInput, setJsonInput] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus the textarea when the modal opens
  useEffect(() => {
    if (isOpen && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isOpen]);

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setJsonInput('');
      setParseError(null);
    }
  }, [isOpen]);

  // Handle escape key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen && !isSubmitting) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isSubmitting, onClose]);

  const submitPayload = useCallback(async () => {
    setParseError(null);

    // Parse the JSON input
    let payload: unknown;
    try {
      // Allow empty string as null payload
      if (jsonInput.trim() === '') {
        payload = null;
      } else {
        payload = JSON.parse(jsonInput);
      }
    } catch {
      setParseError('Invalid JSON. Please check your input.');
      return;
    }

    await onSubmit(payload);
  }, [jsonInput, onSubmit]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      void submitPayload();
    },
    [submitPayload]
  );

  const isMacPlatform =
    typeof navigator !== 'undefined' &&
    (
      (navigator as Navigator & { userAgentData?: { platform?: string } })
        .userAgentData?.platform ?? navigator.userAgent
    )
      .toLowerCase()
      .includes('mac');

  // Handle Cmd/Ctrl + Enter to submit
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !isSubmitting) {
        e.preventDefault();
        handleSubmit(e as unknown as React.FormEvent);
      }
    },
    [handleSubmit, isSubmitting]
  );

  if (!isOpen) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="resolve-hook-modal-title"
    >
      {/* Backdrop — matches Geist dialog ::backdrop */}
      <div
        className="absolute inset-0 bg-black/70"
        onClick={isSubmitting ? undefined : onClose}
      />

      {/* Modal card — matches Geist dialog.geist-dialog */}
      <div className="relative z-10 w-[480px] max-w-[calc(100%_-_32px)] overflow-hidden !border-none bg-background-100 text-gray-1000 material-menu">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4">
          <h2
            id="resolve-hook-modal-title"
            className="m-0 font-semibold text-base text-gray-1000"
          >
            Resolve Hook
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            aria-label="Close modal"
            className="flex cursor-pointer items-center justify-center rounded-md !border-none !bg-transparent p-1 text-gray-900 transition-colors hover:!bg-gray-alpha-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit}>
          <div className="px-6 pb-4">
            <label
              htmlFor="json-payload"
              className="mb-1.5 block font-medium text-gray-1000 text-sm"
            >
              JSON Payload
            </label>
            <p className="mt-0 mb-3 text-[13px] text-gray-900 leading-[1.5]">
              Enter a JSON value to send to the hook. Leave empty to send{' '}
              <code className="rounded bg-gray-alpha-200 px-1.5 py-0.5 font-mono text-gray-1000 text-xs">
                null
              </code>
              .
            </p>
            <textarea
              ref={textareaRef}
              id="json-payload"
              value={jsonInput}
              onChange={(e) => {
                setJsonInput(e.target.value);
                setParseError(null);
              }}
              onKeyDown={handleKeyDown}
              disabled={isSubmitting}
              placeholder='{"key": "value"}'
              className={cn(
                'box-border h-40 w-full resize-none rounded-lg border bg-background-100 px-3 py-2 font-mono text-[13px] text-gray-1000 leading-[1.5] outline-none disabled:cursor-not-allowed disabled:opacity-50',
                parseError ? 'border-red-700' : 'border-gray-alpha-400'
              )}
            />
            {parseError && (
              <p className="mt-2 mb-0 text-[13px] text-red-900">{parseError}</p>
            )}
            <p className="mt-2 mb-0 text-gray-800 text-xs">
              Press{' '}
              <kbd className="rounded border border-gray-alpha-400 bg-gray-alpha-200 px-[5px] py-0.5 font-mono text-[11px]">
                {isMacPlatform ? '⌘' : 'Ctrl'}
                +Enter
              </kbd>{' '}
              to submit
            </p>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 border-gray-alpha-400 border-t px-6 py-3">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="cursor-pointer rounded-lg border border-gray-alpha-400 bg-background-100 px-4 py-2 font-medium text-gray-1000 text-sm transition-colors hover:bg-gray-alpha-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void submitPayload()}
              disabled={isSubmitting}
              className="flex cursor-pointer items-center gap-1.5 rounded-lg !border-none bg-gray-1000 px-4 py-2 font-medium text-background-100 text-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:opacity-50"
            >
              <Send className="size-3.5" />
              {isSubmitting ? 'Sending...' : 'Send Payload'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
