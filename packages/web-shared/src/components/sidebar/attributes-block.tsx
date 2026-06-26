'use client';

import {
  type AttributeChange,
  RESERVED_ATTRIBUTE_KEY_PREFIX,
} from '@workflow/world';
import { CopyableDataBlock } from './copyable-data-block';
import { DetailCard } from './detail-card';

/**
 * Check whether an attribute key is in the reserved (`$`-prefixed)
 * namespace used by framework/library code.
 */
export const isReservedAttributeKey = (key: string): boolean =>
  key.startsWith(RESERVED_ATTRIBUTE_KEY_PREFIX);

function ReservedBadge() {
  return (
    <span
      className="shrink-0 rounded border px-1 py-px text-[10px] font-medium leading-3"
      style={{
        borderColor: 'var(--ds-gray-alpha-400)',
        backgroundColor: 'var(--ds-gray-100)',
        color: 'var(--ds-gray-700)',
      }}
      title={`Keys prefixed with "${RESERVED_ATTRIBUTE_KEY_PREFIX}" are reserved for framework and library code`}
    >
      Reserved
    </span>
  );
}

function AttributeRow({
  attributeKey,
  value,
  removed = false,
}: {
  attributeKey: string;
  value?: string;
  removed?: boolean;
}) {
  const reserved = isReservedAttributeKey(attributeKey);
  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <span
        className="flex min-w-0 items-center gap-1.5 text-label-13 text-gray-900"
        style={reserved ? { color: 'var(--ds-gray-700)' } : undefined}
      >
        <span className="truncate">{attributeKey}</span>
        {reserved && <ReservedBadge />}
      </span>
      {removed ? (
        <span className="shrink-0 text-copy-13 italic text-gray-700">
          removed
        </span>
      ) : (
        <span
          className="max-w-[60%] truncate text-copy-13 text-gray-1000"
          title={value}
        >
          {value}
        </span>
      )}
    </div>
  );
}

/**
 * Sort attribute keys for display: user keys first (alphabetical), then
 * reserved `$`-prefixed keys (alphabetical), so framework metadata doesn't
 * crowd out user-set attributes.
 */
export function sortAttributeKeys(keys: string[]): string[] {
  return [...keys].sort((a, b) => {
    const aReserved = isReservedAttributeKey(a);
    const bReserved = isReservedAttributeKey(b);
    if (aReserved !== bReserved) return aReserved ? 1 : -1;
    return a.localeCompare(b);
  });
}

/**
 * Collapsible section showing a run's materialized attributes as key-value
 * rows. Reserved (`$`-prefixed) keys are visually de-emphasized with a
 * badge and sorted after user keys.
 */
export function RunAttributesCard({
  attributes,
}: {
  attributes: Record<string, string>;
}) {
  const keys = sortAttributeKeys(Object.keys(attributes));
  if (keys.length === 0) return null;

  return (
    <DetailCard summary="Attributes" defaultOpen contentClassName="mb-4">
      <div className="flex flex-col">
        {keys.map((key) => (
          <AttributeRow attributeKey={key} key={key} value={attributes[key]} />
        ))}
      </div>
    </DetailCard>
  );
}

interface AttrSetEventData {
  changes: AttributeChange[];
  writer?:
    | { type: 'workflow' }
    | { type: 'step'; stepId: string; attempt: number };
}

function isAttrSetEventData(data: unknown): data is AttrSetEventData {
  if (data === null || typeof data !== 'object') return false;
  const record = data as Record<string, unknown>;
  return (
    Array.isArray(record.changes) &&
    record.changes.every(
      (c) =>
        c !== null &&
        typeof c === 'object' &&
        typeof (c as Record<string, unknown>).key === 'string'
    )
  );
}

function describeWriter(writer: AttrSetEventData['writer']): string | null {
  if (!writer) return null;
  if (writer.type === 'workflow') return 'Set by workflow';
  if (writer.type === 'step') {
    return `Set by step ${writer.stepId} (attempt ${writer.attempt})`;
  }
  return null;
}

/**
 * Renders the payload of an `attr_set` event: the list of attribute
 * changes (sets and removals) plus which writer (workflow or step)
 * made them. Falls back to the generic JSON block for unexpected shapes.
 */
export function AttrSetEventBlock({ data }: { data: unknown }) {
  if (!isAttrSetEventData(data)) {
    return <CopyableDataBlock data={data} />;
  }

  const writerLabel = describeWriter(data.writer);

  return (
    <div className="flex flex-col px-3 py-1">
      <div className="flex flex-col">
        {data.changes.map((change, index) => (
          <AttributeRow
            attributeKey={change.key}
            key={`${change.key}:${index}`}
            removed={change.value === null}
            value={change.value ?? undefined}
          />
        ))}
      </div>
      {writerLabel && (
        <div
          className="border-t py-1.5 text-label-12"
          style={{
            borderColor: 'var(--ds-gray-alpha-400)',
            color: 'var(--ds-gray-700)',
          }}
        >
          {writerLabel}
        </div>
      )}
    </div>
  );
}
