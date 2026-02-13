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
        className="absolute inset-0"
        style={{
          background: 'var(--ds-gray-alpha-700)',
          backdropFilter: 'blur(4px)',
        }}
        onClick={isSubmitting ? undefined : onClose}
      />

      {/* Modal content */}
      <div
        className="relative z-10 w-full max-w-lg mx-4 rounded-lg shadow-xl"
        style={{
          background: 'var(--ds-background-100)',
          color: 'var(--ds-gray-1000)',
          border: '1px solid var(--ds-gray-alpha-400)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-3.5"
          style={{ borderBottom: '1px solid var(--ds-gray-alpha-400)' }}
        >
          <h2
            id="resolve-hook-modal-title"
            className="text-base font-semibold"
            style={{ color: 'var(--ds-gray-1000)' }}
          >
            Resolve Hook
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className={clsx(
              'p-1 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed'
            )}
            style={{ color: 'var(--ds-gray-900)' }}
            aria-label="Close modal"
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--ds-gray-alpha-200)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
            }}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit}>
          <div className="px-5 py-4">
            <label
              htmlFor="json-payload"
              className="block text-sm font-medium mb-1.5"
              style={{ color: 'var(--ds-gray-1000)' }}
            >
              JSON Payload
            </label>
            <p className="text-xs mb-3" style={{ color: 'var(--ds-gray-900)' }}>
              Enter a JSON value to send to the hook. Leave empty to send{' '}
              <code
                className="px-1 py-0.5 rounded text-xs font-mono"
                style={{
                  background: 'var(--ds-gray-alpha-200)',
                  color: 'var(--ds-gray-1000)',
                }}
              >
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
              className={clsx(
                'w-full h-40 px-3 py-2 font-mono text-sm rounded-md',
                'focus:outline-none focus:ring-2 focus:ring-offset-1',
                'disabled:opacity-50 disabled:cursor-not-allowed',
                'resize-none'
              )}
              style={
                {
                  color: 'var(--ds-gray-1000)',
                  background: 'var(--ds-background-100)',
                  border: `1px solid ${parseError ? 'var(--ds-red-700)' : 'var(--ds-gray-alpha-400)'}`,
                  // Use a neutral ring color that works in both modes
                  '--tw-ring-color': 'var(--ds-gray-alpha-600)',
                  '--tw-ring-offset-color': 'var(--ds-background-100)',
                } as React.CSSProperties
              }
            />
            {parseError && (
              <p
                className="mt-2 text-xs"
                style={{ color: 'var(--ds-red-900)' }}
              >
                {parseError}
              </p>
            )}
            <p className="mt-2 text-xs" style={{ color: 'var(--ds-gray-800)' }}>
              Press{' '}
              <kbd
                className="px-1 py-0.5 rounded text-[10px] font-mono"
                style={{
                  background: 'var(--ds-gray-alpha-200)',
                  border: '1px solid var(--ds-gray-alpha-400)',
                }}
              >
                {typeof navigator !== 'undefined' &&
                navigator.platform?.includes('Mac')
                  ? '⌘'
                  : 'Ctrl'}
                +Enter
              </kbd>{' '}
              to submit
            </p>
          </div>

          {/* Footer */}
          <div
            className="flex items-center justify-end gap-2 px-5 py-3.5"
            style={{ borderTop: '1px solid var(--ds-gray-alpha-400)' }}
          >
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className={clsx(
                'px-4 py-2 text-sm font-medium rounded-md transition-colors',
                'disabled:opacity-50 disabled:cursor-not-allowed'
              )}
              style={{
                background: 'var(--ds-gray-alpha-200)',
                color: 'var(--ds-gray-1000)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--ds-gray-alpha-300)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'var(--ds-gray-alpha-200)';
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void submitPayload()}
              disabled={isSubmitting}
              className={clsx(
                'flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md transition-colors',
                'disabled:opacity-50 disabled:cursor-not-allowed'
              )}
              style={{
                background: 'var(--ds-gray-1000)',
                color: 'var(--ds-background-100)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.opacity = '0.9';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.opacity = '1';
              }}
            >
              <Send className="h-3.5 w-3.5" />
              {isSubmitting ? 'Sending...' : 'Send Payload'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
