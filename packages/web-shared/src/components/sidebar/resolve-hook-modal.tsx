'use client';

import clsx from 'clsx';
import { Send, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

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
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={isSubmitting ? undefined : onClose}
      />

      {/* Modal content */}
      <div
        className={clsx(
          'relative z-10 w-full max-w-lg mx-4',
          'bg-background text-foreground rounded-lg shadow-xl',
          'border border-border'
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2
            id="resolve-hook-modal-title"
            className="text-lg font-semibold text-foreground"
          >
            Resolve Hook
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className={clsx(
              'p-1 rounded-md transition-colors',
              'text-muted-foreground hover:text-foreground',
              'hover:bg-muted',
              'disabled:opacity-50 disabled:cursor-not-allowed'
            )}
            aria-label="Close modal"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit}>
          <div className="px-4 py-4">
            <label
              htmlFor="json-payload"
              className="block text-sm font-medium text-foreground mb-2"
            >
              JSON Payload
            </label>
            <p className="text-xs text-muted-foreground mb-3">
              Enter a JSON value to send to the hook. Leave empty to send{' '}
              <code className="px-1 py-0.5 bg-muted rounded text-xs">null</code>
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
              className={clsx(
                'w-full h-40 px-3 py-2 font-mono text-sm',
                'text-foreground',
                'bg-background',
                'border rounded-md',
                'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background',
                'disabled:opacity-50 disabled:cursor-not-allowed',
                'placeholder:text-muted-foreground',
                parseError ? 'border-destructive' : 'border-input'
              )}
            />
            {parseError && (
              <p className="mt-2 text-sm text-destructive">{parseError}</p>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className={clsx(
                'px-4 py-2 text-sm font-medium rounded-md transition-colors',
                'bg-secondary text-secondary-foreground',
                'hover:bg-secondary/80',
                'disabled:opacity-50 disabled:cursor-not-allowed'
              )}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void submitPayload()}
              disabled={isSubmitting}
              className={clsx(
                'flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-md transition-colors',
                'bg-primary text-primary-foreground hover:bg-primary/90',
                'disabled:opacity-50 disabled:cursor-not-allowed'
              )}
            >
              <Send className="h-4 w-4" />
              {isSubmitting ? 'Sending...' : 'Send Payload'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
