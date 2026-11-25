'use client';

import { useId, useState } from 'react';
import { Button } from '../ui/button';
import { Kbd } from '../ui/kbd';
import {
  Modal,
  ModalActions,
  ModalBody,
  ModalContent,
  ModalHeader,
  ModalTitle,
} from '../ui/modal';

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

export function ResolveHookModal({
  isOpen,
  onClose,
  onSubmit,
  isSubmitting = false,
}: ResolveHookModalProps): React.JSX.Element {
  return (
    <Modal
      open={isOpen}
      onOpenChange={(open) => {
        if (!open && !isSubmitting) onClose();
      }}
    >
      <ModalContent>
        <ResolveHookForm
          onClose={onClose}
          onSubmit={onSubmit}
          isSubmitting={isSubmitting}
        />
      </ModalContent>
    </Modal>
  );
}

function ResolveHookForm({
  onClose,
  onSubmit,
  isSubmitting,
}: Omit<ResolveHookModalProps, 'isOpen'>) {
  const [jsonInput, setJsonInput] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const id = useId();
  const inputId = `${id}-payload`;
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;

    let payload: unknown = null;
    if (jsonInput.trim() !== '') {
      try {
        payload = JSON.parse(jsonInput);
      } catch {
        setParseError('Enter valid JSON, or leave it empty to send null.');
        return;
      }
    }
    void onSubmit(payload);
  };

  const isMacPlatform =
    typeof navigator !== 'undefined' &&
    (
      (navigator as Navigator & { userAgentData?: { platform?: string } })
        .userAgentData?.platform ?? navigator.userAgent
    )
      .toLowerCase()
      .includes('mac');

  return (
    <form onSubmit={handleSubmit}>
      <ModalBody>
        <ModalHeader>
          <ModalTitle>Resolve Hook</ModalTitle>
        </ModalHeader>
        <label
          htmlFor={inputId}
          className="mb-2 block text-label-13 text-gray-900"
        >
          JSON Payload
        </label>
        <p id={descriptionId} className="mb-3">
          Enter a JSON value to send to the hook. Leave it empty to send{' '}
          <code className="rounded bg-gray-alpha-200 px-1 text-label-13-mono text-gray-1000">
            null
          </code>
          .
        </p>
        <textarea
          id={inputId}
          value={jsonInput}
          onChange={(e) => {
            setJsonInput(e.target.value);
            setParseError(null);
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          readOnly={isSubmitting}
          placeholder='{"key": "value"}'
          aria-invalid={parseError ? true : undefined}
          aria-describedby={
            parseError ? `${descriptionId} ${errorId}` : descriptionId
          }
          className="block h-40 w-full resize-none rounded-md border border-gray-alpha-400 bg-background-100 px-3 py-2 text-copy-13-mono text-gray-1000 outline-none placeholder:text-gray-700 focus-visible:shadow-[var(--ds-focus-ring)] aria-invalid:border-red-700"
        />
        {parseError && (
          <p id={errorId} className="mt-2 text-copy-13 text-red-800">
            {parseError}
          </p>
        )}
        <p className="mt-2 flex items-center gap-1 text-label-13 text-gray-700">
          Press
          <Kbd variant="outline">{isMacPlatform ? '⌘' : 'Ctrl'}</Kbd>
          <Kbd variant="outline">Enter</Kbd>
          to submit
        </p>
      </ModalBody>
      <ModalActions>
        <Button
          variant="secondary"
          size="small"
          onClick={onClose}
          disabled={isSubmitting}
        >
          Cancel
        </Button>
        <Button type="submit" size="small" loading={isSubmitting}>
          Resolve Hook
        </Button>
      </ModalActions>
    </form>
  );
}
