'use client';

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
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="resolve-hook-modal-title"
    >
      {/* Backdrop — matches Geist dialog ::backdrop */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.7)',
        }}
        onClick={isSubmitting ? undefined : onClose}
      />

      {/* Modal card — matches Geist dialog.geist-dialog */}
      <div
        style={{
          position: 'relative',
          zIndex: 10,
          width: 480,
          maxWidth: 'calc(100% - 32px)',
          borderRadius: 12,
          border: 'none',
          boxShadow: 'var(--ds-shadow-menu)',
          background: 'var(--ds-background-100)',
          color: 'var(--ds-gray-1000)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 24px',
          }}
        >
          <h2
            id="resolve-hook-modal-title"
            style={{
              margin: 0,
              fontSize: 16,
              fontWeight: 600,
              color: 'var(--ds-gray-1000)',
            }}
          >
            Resolve Hook
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            aria-label="Close modal"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 4,
              borderRadius: 6,
              border: 'none',
              background: 'transparent',
              color: 'var(--ds-gray-900)',
              cursor: isSubmitting ? 'not-allowed' : 'pointer',
              opacity: isSubmitting ? 0.5 : 1,
              transition: 'background 0.15s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--ds-gray-alpha-200)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
            }}
          >
            <X style={{ width: 16, height: 16 }} />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit}>
          <div style={{ padding: '0 24px 16px' }}>
            <label
              htmlFor="json-payload"
              style={{
                display: 'block',
                fontSize: 14,
                fontWeight: 500,
                marginBottom: 6,
                color: 'var(--ds-gray-1000)',
              }}
            >
              JSON Payload
            </label>
            <p
              style={{
                fontSize: 13,
                marginBottom: 12,
                marginTop: 0,
                color: 'var(--ds-gray-900)',
                lineHeight: 1.5,
              }}
            >
              Enter a JSON value to send to the hook. Leave empty to send{' '}
              <code
                style={{
                  padding: '2px 6px',
                  borderRadius: 4,
                  fontSize: 12,
                  fontFamily:
                    'var(--font-mono, ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace)',
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
              style={{
                width: '100%',
                height: 160,
                padding: '8px 12px',
                fontFamily:
                  'var(--font-mono, ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace)',
                fontSize: 13,
                lineHeight: 1.5,
                borderRadius: 8,
                border: `1px solid ${parseError ? 'var(--ds-red-700)' : 'var(--ds-gray-alpha-400)'}`,
                color: 'var(--ds-gray-1000)',
                background: 'var(--ds-background-100)',
                outline: 'none',
                resize: 'none',
                opacity: isSubmitting ? 0.5 : 1,
                cursor: isSubmitting ? 'not-allowed' : 'text',
                boxSizing: 'border-box',
              }}
            />
            {parseError && (
              <p
                style={{
                  marginTop: 8,
                  fontSize: 13,
                  color: 'var(--ds-red-900)',
                  margin: '8px 0 0',
                }}
              >
                {parseError}
              </p>
            )}
            <p
              style={{
                marginTop: 8,
                fontSize: 12,
                color: 'var(--ds-gray-800)',
                margin: '8px 0 0',
              }}
            >
              Press{' '}
              <kbd
                style={{
                  padding: '2px 5px',
                  borderRadius: 4,
                  fontSize: 11,
                  fontFamily:
                    'var(--font-mono, ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace)',
                  background: 'var(--ds-gray-alpha-200)',
                  border: '1px solid var(--ds-gray-alpha-400)',
                }}
              >
                {isMacPlatform ? '⌘' : 'Ctrl'}
                +Enter
              </kbd>{' '}
              to submit
            </p>
          </div>

          {/* Footer */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 8,
              padding: '12px 24px',
              borderTop: '1px solid var(--ds-gray-alpha-400)',
            }}
          >
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              style={{
                padding: '8px 16px',
                fontSize: 14,
                fontWeight: 500,
                borderRadius: 8,
                border: '1px solid var(--ds-gray-alpha-400)',
                background: 'var(--ds-background-100)',
                color: 'var(--ds-gray-1000)',
                cursor: isSubmitting ? 'not-allowed' : 'pointer',
                opacity: isSubmitting ? 0.5 : 1,
                transition: 'background 0.15s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--ds-gray-alpha-100)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'var(--ds-background-100)';
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void submitPayload()}
              disabled={isSubmitting}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '8px 16px',
                fontSize: 14,
                fontWeight: 500,
                borderRadius: 8,
                border: 'none',
                background: 'var(--ds-gray-1000)',
                color: 'var(--ds-background-100)',
                cursor: isSubmitting ? 'not-allowed' : 'pointer',
                opacity: isSubmitting ? 0.5 : 1,
                transition: 'opacity 0.15s',
              }}
              onMouseEnter={(e) => {
                if (!isSubmitting) e.currentTarget.style.opacity = '0.9';
              }}
              onMouseLeave={(e) => {
                if (!isSubmitting) e.currentTarget.style.opacity = '1';
              }}
            >
              <Send style={{ width: 14, height: 14 }} />
              {isSubmitting ? 'Sending...' : 'Send Payload'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
