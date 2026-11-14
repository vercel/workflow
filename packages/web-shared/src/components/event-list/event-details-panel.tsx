'use client';

import { type Event, getEventDataRefFields } from '@workflow/world';
import { Lock } from 'lucide-react';
import { useContext, useEffect, useMemo, useState } from 'react';
import { cn } from '../../lib/cn';
import {
  type EventListRow,
  hasEncryptedValues,
  parseEventDate,
  type TimingSegment,
} from '../../lib/event-list-model';
import { formatDurationPrecise } from '../../lib/utils';
import {
  AttrSetEventBlock,
  DetailMonoKeyValueRow,
} from '../sidebar/attributes-block';
import { serializeForClipboard } from '../sidebar/copyable-data-block';
import { CopyButton } from '../trace-viewer/components/copy-button';
import { DetailPanelShell } from '../trace-viewer/components/detail-panel-shell';
import type { DetailPanelWidth } from '../trace-viewer/components/use-detail-panel-width';
import { Collapsible } from '../ui/collapsible';
import { DataInspector, DecryptClickContext } from '../ui/data-inspector';
import { DecryptButton } from '../ui/decrypt-button';
import {
  ErrorStackBlock,
  isStructuredError,
  type StructuredErrorRecord,
} from '../ui/error-stack-block';
import { Skeleton } from '../ui/skeleton';

/**
 * Event types whose eventData contains an error field with a StructuredError.
 */
const ERROR_EVENT_TYPES = new Set([
  'step_failed',
  'step_retrying',
  'run_failed',
]);

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
 * Extracts a structured error from event data, if present.
 * Returns the error object to render with ErrorStackBlock, or null if not applicable.
 */
function extractStructuredError(
  data: unknown,
  eventType?: string
): StructuredErrorRecord | null {
  if (!eventType || !ERROR_EVENT_TYPES.has(eventType)) return null;
  if (data == null || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  // Check the nested `error` field first (the StructuredError)
  if (isStructuredError(record.error)) return record.error;
  // Some error formats put the message/stack at the top level of eventData.
  if (isStructuredError(record)) return record;
  return null;
}

const SEGMENT_COLOR: Record<TimingSegment['kind'], string> = {
  queued: 'bg-gray-400',
  failed: 'bg-amber-700',
  backoff: 'bg-amber-300',
  ok: 'bg-green-700',
  running: 'bg-blue-700',
};

function PayloadView({
  data,
  eventType,
  encrypted,
}: {
  data: unknown;
  eventType: string;
  /** Still sealed with the run's key. */
  encrypted: boolean;
}) {
  const decrypt = useContext(DecryptClickContext);
  const cleaned = useMemo(() => deepParseJson(data), [data]);
  if (encrypted && decrypt) {
    return (
      <Collapsible defaultOpen label="Payload">
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
      </Collapsible>
    );
  }
  return (
    <Collapsible
      defaultOpen
      label="Payload"
      actions={
        <CopyButton
          copyText={serializeForClipboard(cleaned)}
          ariaLabel="Copy payload"
          className="flex h-6 w-6 items-center justify-center rounded-md p-0 hover:bg-gray-alpha-200"
        />
      }
    >
      {eventType === 'attr_set' ? (
        <AttrSetEventBlock data={cleaned} />
      ) : (
        <div className="overflow-x-auto">
          <DataInspector data={cleaned} />
        </div>
      )}
    </Collapsible>
  );
}

function TimingBreakdown({ segments }: { segments: TimingSegment[] }) {
  return (
    <div className="flex flex-col gap-2">
      <div
        aria-hidden
        className="flex h-2 gap-0.5 overflow-hidden rounded-full"
      >
        {segments.map((segment, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
            key={i}
            className={cn(
              'h-full min-w-1 basis-0',
              SEGMENT_COLOR[segment.kind]
            )}
            style={{ flexGrow: segment.ms }}
          />
        ))}
      </div>
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {segments.map((segment, i) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
            key={i}
            className="flex items-center gap-1.5 text-label-14"
          >
            <span className="flex size-4 shrink-0 items-center justify-center">
              <span
                aria-hidden
                className={cn(
                  'block size-2.5 rounded-full',
                  SEGMENT_COLOR[segment.kind]
                )}
              />
            </span>
            <span className="text-gray-900">{segment.label}</span>
            <span className="tabular-nums text-gray-1000">
              {formatDurationPrecise(segment.ms)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface EventDetailsBodyProps {
  row: EventListRow;
  /** The step's queued, attempt and backoff breakdown; empty for other events. */
  segments: TimingSegment[];
  onLoadEventData?: (event: Event) => Promise<unknown | null>;
  cachedEventData: unknown | null;
  onCacheEventData: (eventId: string, data: unknown) => void;
  encryptionKey?: Uint8Array;
}

/**
 * The selected event's metrics, error, payload and identifiers. Holds the
 * payload load state and section toggles, so it is keyed per event.
 */
function EventDetailsBody({
  row,
  segments,
  onLoadEventData,
  cachedEventData,
  onCacheEventData,
  encryptionKey,
}: EventDetailsBodyProps) {
  const { event } = row;
  // Inline eventData is complete only when the event type has no ref fields
  // (list endpoints strip input/result/error/payload) or there is no loader.
  const inlineIsComplete =
    event.eventData != null &&
    (!onLoadEventData || getEventDataRefFields(event.eventType).length === 0);
  const [data, setData] = useState<unknown | null>(
    cachedEventData ?? (inlineIsComplete ? event.eventData : null)
  );
  const [loading, setLoading] = useState(
    data === null && !!onLoadEventData && !!event.correlationId
  );
  const [loadError, setLoadError] = useState<string | null>(null);

  // Load (or reload once decryption is available) the full payload.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload only when the event or key changes
  useEffect(() => {
    if (!onLoadEventData || (inlineIsComplete && !encryptionKey)) return;
    if (data !== null && !encryptionKey) return;
    let cancelled = false;
    setLoadError(null);
    if (data === null) setLoading(true);
    onLoadEventData(event)
      .then((loaded) => {
        if (cancelled || loaded == null) return;
        setData(loaded);
        onCacheEventData(event.eventId, loaded);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(
          err instanceof Error ? err.message : 'Failed to load event details'
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [event.eventId, encryptionKey]);

  const timingTotal = segments.reduce((sum, s) => sum + s.ms, 0);
  const occurredAt = parseEventDate(event.occurredAt);
  const createdAt = new Date(event.createdAt);
  const structuredError = extractStructuredError(data, event.eventType);

  return (
    <div className="@container px-4">
      {/* Start and since-start are already in the selected row; Timing adds
          the step's breakdown, or the duration for other events. */}
      {timingTotal > 0 ? (
        <Collapsible
          defaultOpen
          label="Timing"
          actions={
            <span className="text-label-13 tabular-nums text-gray-900">
              {formatDurationPrecise(timingTotal)} total
            </span>
          }
        >
          <TimingBreakdown segments={segments} />
        </Collapsible>
      ) : row.durationMs !== undefined ? (
        <Collapsible defaultOpen label="Timing">
          <DetailMonoKeyValueRow
            label="Duration"
            value={formatDurationPrecise(row.durationMs)}
          />
        </Collapsible>
      ) : null}

      {structuredError ? (
        <Collapsible defaultOpen label="Error">
          <ErrorStackBlock value={structuredError} />
        </Collapsible>
      ) : null}

      {data != null ? (
        <PayloadView
          data={data}
          eventType={event.eventType}
          encrypted={!encryptionKey && hasEncryptedValues(data)}
        />
      ) : loading || loadError ? (
        <Collapsible defaultOpen label="Payload">
          {loadError ? (
            <div className="rounded-md border border-red-400 bg-red-100 px-2 py-1.5 text-copy-13-mono text-red-1000">
              {loadError}
            </div>
          ) : (
            <div className="flex flex-col gap-2 py-1">
              <Skeleton className="h-3" style={{ width: '70%' }} />
              <Skeleton className="h-3" style={{ width: '45%' }} />
            </div>
          )}
        </Collapsible>
      ) : null}

      <Collapsible defaultOpen label="Identifiers">
        <div className="flex flex-col">
          <DetailMonoKeyValueRow
            label="Event ID"
            value={event.eventId}
            copyText={event.eventId}
          />
          {event.correlationId ? (
            <DetailMonoKeyValueRow
              label="Correlation ID"
              value={event.correlationId}
              copyText={event.correlationId}
            />
          ) : null}
          <DetailMonoKeyValueRow
            label="Created"
            value={createdAt.toLocaleString()}
          />
          {occurredAt ? (
            <DetailMonoKeyValueRow
              label="Occurred"
              value={occurredAt.toLocaleString()}
            />
          ) : null}
        </div>
      </Collapsible>
    </div>
  );
}

const EVENT_DETAIL_PANEL_ID = 'event-detail-panel';

export interface EventDetailsPanelProps extends EventDetailsBodyProps {
  /** From `useDetailPanelWidth` in the list, which outlives the panel. */
  width: DetailPanelWidth;
  onPrev?: () => void;
  onNext?: () => void;
  onClose: () => void;
}

/**
 * Right-hand details for the selected event. Stays mounted while the
 * selection moves; only the body is keyed per event.
 */
export function EventDetailsPanel({
  width,
  onPrev,
  onNext,
  onClose,
  ...body
}: EventDetailsPanelProps) {
  const { row } = body;
  const { event } = row;
  return (
    <DetailPanelShell
      id={EVENT_DETAIL_PANEL_ID}
      width={width}
      itemLabel="event"
      title={
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-mono text-label-12 font-normal text-gray-900">
            {event.eventType}
          </span>
          <span className="truncate text-label-16 font-semibold">
            {row.name || event.eventType}
          </span>
        </span>
      }
      onPrev={onPrev}
      onNext={onNext}
      onClose={onClose}
    >
      <EventDetailsBody key={event.eventId} {...body} />
    </DetailPanelShell>
  );
}
