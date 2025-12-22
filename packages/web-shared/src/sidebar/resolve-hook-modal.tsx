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

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
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
    },
    [jsonInput, onSubmit]
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
          'bg-white dark:bg-gray-900 rounded-lg shadow-xl',
          'border border-gray-200 dark:border-gray-700'
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <h2
            id="resolve-hook-modal-title"
            className="text-lg font-semibold text-gray-900 dark:text-gray-100"
          >
            Resolve Hook
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className={clsx(
              'p-1 rounded-md transition-colors',
              'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200',
              'hover:bg-gray-100 dark:hover:bg-gray-800',
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
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2"
            >
              JSON Payload
            </label>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
              Enter a JSON value to send to the hook. Leave empty to send{' '}
              <code className="px-1 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-xs">
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
                'w-full h-40 px-3 py-2 font-mono text-sm',
                'bg-gray-50 dark:bg-gray-800',
                'border rounded-md',
                'focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400',
                'disabled:opacity-50 disabled:cursor-not-allowed',
                'placeholder:text-gray-400 dark:placeholder:text-gray-500',
                parseError
                  ? 'border-red-500 dark:border-red-400'
                  : 'border-gray-300 dark:border-gray-600'
              )}
            />
            {parseError && (
              <p className="mt-2 text-sm text-red-600 dark:text-red-400">
                {parseError}
              </p>
            )}
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              Press{' '}
              <kbd className="px-1.5 py-0.5 text-xs bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded">
                ⌘
              </kbd>{' '}
              +{' '}
              <kbd className="px-1.5 py-0.5 text-xs bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded">
                Enter
              </kbd>{' '}
              to submit
            </p>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-gray-200 dark:border-gray-700">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className={clsx(
                'px-4 py-2 text-sm font-medium rounded-md transition-colors',
                'text-gray-700 dark:text-gray-300',
                'bg-gray-100 dark:bg-gray-800',
                'hover:bg-gray-200 dark:hover:bg-gray-700',
                'disabled:opacity-50 disabled:cursor-not-allowed'
              )}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className={clsx(
                'flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md transition-colors',
                'text-white bg-blue-600 hover:bg-blue-700',
                'dark:bg-blue-500 dark:hover:bg-blue-600',
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
