'use client';

import { getEventDataRefFields } from '@workflow/world';
import { Lock } from 'lucide-react';
import { useContext, useMemo } from 'react';
import { cn } from '../../lib/cn';
import { hasEncryptedValues } from '../../lib/event-list-model';
import { hasEncryptedFields, isExpiredMarker } from '../../lib/hydration';
import { AttrSetEventBlock } from '../sidebar/attributes-block';
import {
  CopyableDataBlock,
  EncryptedDataBlock,
  serializeForClipboard,
} from '../sidebar/copyable-data-block';
import { CopyButton } from '../trace-viewer/components/copy-button';
import { Collapsible } from '../ui/collapsible';
import { DataInspector, DecryptClickContext } from '../ui/data-inspector';
import { DecryptButton } from '../ui/decrypt-button';
import { ErrorCard } from '../ui/error-card';
import {
  ErrorStackBlock,
  isStructuredError,
  type StructuredErrorRecord,
} from '../ui/error-stack-block';
import { Skeleton } from '../ui/skeleton';
import type { EventPayloadState } from './use-event-payload';

/** Recursively parse stringified JSON values so escaped slashes / quotes are cleaned up */
function deepParseJson(value: unknown): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"'))
    ) {
      try {
        return deepParseJson(JSON.parse(trimmed));
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(deepParseJson);
  }
  if (value !== null && typeof value === 'object') {
    // Preserve objects with custom constructors (e.g., encrypted markers,
    // class instance refs); don't destructure them into plain objects
    if (value.constructor !== Object) {
      return value;
    }
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = deepParseJson(v);
    }
    return result;
  }
  return value;
}

/**
 * The StructuredError an error event (one whose ref fields include `error`)
 * carries, or null. Checks the nested `error` field first, then the top level
 * for legacy payloads that put the message and stack there.
 */
function extractStructuredError(
  data: unknown,
  eventType: string
): StructuredErrorRecord | null {
  if (!getEventDataRefFields(eventType).includes('error')) return null;
  if (data == null || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  if (isStructuredError(record.error)) return record.error;
  if (isStructuredError(record)) return record;
  return null;
}

/**
 * Check if an eventData object has only expired marker values in ref/payload
 * fields for this event type (see {@link getEventDataRefFields}). Other keys
 * (e.g. `resumeAt`, `stepName`) are ignored.
 */
function hasOnlyExpiredFields(data: unknown, eventType: string): boolean {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return false;
  }
  const record = data as Record<string, unknown>;
  const refKeys = getEventDataRefFields(eventType);
  const presentKeys = refKeys.filter((k) => k in record);
  return (
    presentKeys.length > 0 &&
    presentKeys.every((k) => isExpiredMarker(record[k]))
  );
}

/**
 * Renders event data, using ErrorStackBlock for error events that contain a
 * structured error, and CopyableDataBlock otherwise.
 */
function EventDataBlock({
  eventType,
  data,
}: {
  eventType: string;
  data: unknown;
}) {
  // Expired data: show a message instead of the raw stub.
  // Check both the top-level eventData and nested sub-fields (result, input, etc.)
  // since the server stubs each ref field independently.
  if (isExpiredMarker(data) || hasOnlyExpiredFields(data, eventType)) {
    return (
      <div
        className="flex items-center gap-1.5 rounded-md border px-3 py-2 text-label-12"
        style={{
          borderColor: 'var(--ds-gray-300)',
          backgroundColor: 'var(--ds-gray-100)',
          color: 'var(--ds-gray-700)',
        }}
      >
        <span className="font-medium">Data expired</span>
      </div>
    );
  }

  if (hasEncryptedFields({ eventType, eventData: data })) {
    return <EncryptedDataBlock />;
  }

  // Attribute changes: render the changed keys and the writer instead of
  // the raw JSON payload.
  if (eventType === 'attr_set') {
    return <AttrSetEventBlock data={data} />;
  }

  const structuredError = extractStructuredError(data, eventType);
  if (structuredError) {
    return <ErrorStackBlock value={structuredError} />;
  }

  // For non-error events or errors without a stack, fall back to the
  // generic JSON viewer.
  return <CopyableDataBlock data={data} />;
}

function PayloadSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <Skeleton className="h-3" style={{ width: '70%' }} />
      <Skeleton className="h-3" style={{ width: '45%' }} />
    </div>
  );
}

function LoadErrorCard({
  error,
  className,
}: {
  error: string;
  className?: string;
}) {
  return (
    <ErrorCard
      title="Failed to load event data"
      details={error}
      className={className}
    />
  );
}

/** The body of the Events tab's Payload section once a payload is loaded. */
function PayloadBody({
  data,
  eventType,
  sealed,
}: {
  data: unknown;
  eventType: string;
  sealed: boolean;
}) {
  const decrypt = useContext(DecryptClickContext);
  if (sealed && decrypt) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-gray-alpha-400 bg-gray-100 py-1.5 pl-3 pr-1.5">
        <Lock className="h-4 w-4 shrink-0 text-gray-900" />
        <span className="min-w-0 flex-1 text-copy-13 text-gray-900">
          Encrypted with this run’s key.
        </span>
        <DecryptButton
          loading={decrypt.isDecrypting}
          disabled={decrypt.isDecryptDisabled}
          disabledReason={decrypt.decryptDisabledReason}
          onClick={decrypt.onDecrypt}
        />
      </div>
    );
  }
  if (eventType === 'attr_set') {
    return <AttrSetEventBlock data={data} />;
  }
  return (
    <div className="overflow-x-auto">
      <DataInspector data={data} />
    </div>
  );
}

/** The Events tab's Error and Payload sections. */
function PayloadSections({
  eventType,
  payload: { data, loading, error },
  encryptionKey,
}: {
  eventType: string;
  payload: EventPayloadState;
  encryptionKey?: Uint8Array;
}) {
  const decrypt = useContext(DecryptClickContext);
  const cleaned = useMemo(() => deepParseJson(data), [data]);
  const structuredError = extractStructuredError(data, eventType);
  const hasData = data != null;
  // Still sealed with the run's key, and Decrypt is on offer.
  const sealed =
    hasData && !encryptionKey && hasEncryptedValues(data) && !!decrypt;

  return (
    <>
      {structuredError ? (
        <Collapsible defaultOpen label="Error">
          <ErrorStackBlock value={structuredError} />
        </Collapsible>
      ) : null}

      {hasData || loading || error ? (
        <Collapsible
          defaultOpen
          label="Payload"
          actions={
            hasData && !sealed ? (
              <CopyButton
                copyText={serializeForClipboard(cleaned)}
                ariaLabel="Copy payload"
                className="flex h-6 w-6 items-center justify-center rounded-md p-0 hover:bg-gray-alpha-200"
              />
            ) : undefined
          }
        >
          {error ? (
            <LoadErrorCard error={error} className={hasData ? 'mb-2' : ''} />
          ) : null}
          {hasData ? (
            <PayloadBody data={cleaned} eventType={eventType} sealed={sealed} />
          ) : error ? null : (
            <PayloadSkeleton className="py-1" />
          )}
        </Collapsible>
      ) : null}
    </>
  );
}

/**
 * One event's payload with its load state, from {@link useEventPayload}: a
 * skeleton while the first load runs, the load error, and the payload.
 *
 * - `card`: the body of a sidebar event card, with no section headers.
 * - `section`: the Events tab's details panel, as Error and Payload sections.
 */
export function EventPayloadSection({
  eventType,
  payload,
  variant,
  encryptionKey,
}: {
  eventType: string;
  payload: EventPayloadState;
  variant: 'card' | 'section';
  /** Decryption is active, so encrypted values no longer offer Decrypt. */
  encryptionKey?: Uint8Array;
}) {
  if (variant === 'section') {
    return (
      <PayloadSections
        eventType={eventType}
        payload={payload}
        encryptionKey={encryptionKey}
      />
    );
  }

  const { data, loading, error } = payload;
  return (
    <>
      {loading && data == null ? <PayloadSkeleton className="p-3" /> : null}
      {error ? <LoadErrorCard error={error} className="mt-2" /> : null}
      {data != null ? (
        <div className="[&>div]:border-none [&>div]:rounded-none">
          <EventDataBlock eventType={eventType} data={data} />
        </div>
      ) : null}
    </>
  );
}
