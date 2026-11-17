'use client';

import type { Event } from '@workflow/world';
import { ChartGantt } from 'lucide-react';
import { cn } from '../../lib/cn';
import {
  type EventListRow,
  parseEventDate,
  type TimingSegment,
} from '../../lib/event-list-model';
import { getEventSpanId } from '../../lib/trace-builder';
import { formatDurationPrecise } from '../../lib/utils';
import { EventIdentifiers } from '../event-details/event-identifiers';
import { EventPayloadSection } from '../event-details/event-payload-section';
import { EventTypeLabel } from '../event-details/event-type-label';
import { useEventPayload } from '../event-details/use-event-payload';
import { DetailMonoKeyValueRow } from '../sidebar/attributes-block';
import { DetailPanelShell } from '../trace-viewer/components/detail-panel-shell';
import type { DetailPanelWidth } from '../trace-viewer/components/use-detail-panel-width';
import { Collapsible } from '../ui/collapsible';
import { IconButton } from '../ui/icon-button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

const SEGMENT_COLOR: Record<TimingSegment['kind'], string> = {
  queued: 'bg-gray-400',
  failed: 'bg-amber-700',
  backoff: 'bg-amber-300',
  ok: 'bg-green-700',
};

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
  onLoadEventData,
  cachedEventData,
  onCacheEventData,
  encryptionKey,
}: EventDetailsBodyProps) {
  const { event } = row;
  const payload = useEventPayload({
    event,
    onLoadEventData,
    encryptionKey,
    initialData: cachedEventData,
    onLoaded: onCacheEventData,
  });

  const timingTotal = row.segments.reduce((sum, s) => sum + s.ms, 0);
  const occurredAt = parseEventDate(event.occurredAt);
  const createdAt = new Date(event.createdAt);

  return (
    <div className="@container px-4 pb-8">
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
          <TimingBreakdown segments={row.segments} />
        </Collapsible>
      ) : row.durationMs !== undefined ? (
        <Collapsible defaultOpen label="Timing">
          <DetailMonoKeyValueRow
            label="Duration"
            value={formatDurationPrecise(row.durationMs)}
          />
        </Collapsible>
      ) : null}

      <EventPayloadSection
        eventType={event.eventType}
        payload={payload}
        variant="section"
        encryptionKey={encryptionKey}
      />

      <Collapsible defaultOpen label="Identifiers">
        <div className="flex flex-col">
          <EventIdentifiers event={event} />
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
  onViewInTrace?: (spanId: string) => void;
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
  onViewInTrace,
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
        <EventTypeLabel
          eventType={event.eventType}
          label={row.name || event.eventType}
          notice={row.notice}
          className={cn('block', row.notice && 'text-gray-700')}
        />
      }
      actions={
        onViewInTrace ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <IconButton
                aria-label="View in Trace"
                onClick={() => onViewInTrace(getEventSpanId(event))}
              >
                <ChartGantt className="w-4 h-4" />
              </IconButton>
            </TooltipTrigger>
            <TooltipContent>View in Trace</TooltipContent>
          </Tooltip>
        ) : null
      }
      onPrev={onPrev}
      onNext={onNext}
      onClose={onClose}
    >
      <EventDetailsBody key={event.eventId} {...body} />
    </DetailPanelShell>
  );
}
