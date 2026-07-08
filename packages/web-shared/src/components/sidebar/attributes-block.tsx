'use client';

import {
  type AttributeChange,
  RESERVED_ATTRIBUTE_KEY_PREFIX,
} from '@workflow/world';
import { cva, type VariantProps } from 'class-variance-authority';
import { ArrowUpRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { CopyButton } from '../new-trace-viewer/components/copy-button';
import { MiddleTruncate } from '../new-trace-viewer/components/middle-truncate/middle-truncate';
import {
  CollapsibleContent,
  CollapsibleRoot,
  CollapsibleTrigger,
} from '../ui/collapsible';
import { CopyableDataBlock } from './copyable-data-block';

function isReservedAttributeKey(key: string): boolean {
  return key.startsWith(RESERVED_ATTRIBUTE_KEY_PREFIX);
}

const rowValueVariants = cva(
  'max-w-[60%] truncate text-right text-copy-13 text-gray-1000',
  {
    variants: {
      variant: {
        default: '',
        mono: 'font-mono',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

const rowCopyValueVariants = cva(
  'flex min-w-0 max-w-[60%] items-center justify-end gap-1 text-copy-13 text-gray-1000',
  {
    variants: {
      variant: {
        default: '',
        mono: 'font-mono',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

type DetailKeyValueRowProps = {
  label: string;
  value?: ReactNode;
  copyText?: string;
  href?: string;
  removed?: boolean;
};

function DetailKeyValueRowBase({
  label,
  value,
  copyText,
  href,
  removed = false,
  variant,
}: DetailKeyValueRowProps & VariantProps<typeof rowValueVariants>) {
  const stringValue = typeof value === 'string' ? value : undefined;

  return (
    <div className="px-1.5 hover:bg-gray-100 flex justify-between gap-3 -mx-1.5 py-0.5 rounded items-center">
      <span className="flex min-w-0 items-center gap-1.5 truncate text-label-13 text-gray-900">
        {label}
      </span>
      {removed ? (
        <span className="shrink-0 text-copy-13 italic text-gray-700">
          removed
        </span>
      ) : copyText ? (
        <div className={cn(rowCopyValueVariants({ variant }))} title={copyText}>
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className={cn(
                rowValueVariants({ variant }),
                'flex min-w-0 items-center gap-0.5 hover:underline'
              )}
            >
              <MiddleTruncate
                value={copyText}
                className="min-w-0 text-right"
                style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}
              />
              <ArrowUpRight aria-hidden className="h-3 w-3 shrink-0" />
            </a>
          ) : (
            <MiddleTruncate
              value={copyText}
              className={cn(
                rowValueVariants({ variant, className: 'text-right' })
              )}
              style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}
            />
          )}
          <CopyButton
            copyText={copyText}
            ariaLabel={`Copy ${label}`}
            className="shrink-0 -mr-1"
          />
        </div>
      ) : (
        <span className={cn(rowValueVariants({ variant }))} title={stringValue}>
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="hover:underline"
            >
              {value}
            </a>
          ) : (
            value
          )}
        </span>
      )}
    </div>
  );
}

export function DetailKeyValueRow(props: DetailKeyValueRowProps) {
  return <DetailKeyValueRowBase {...props} />;
}

export function DetailMonoKeyValueRow(props: DetailKeyValueRowProps) {
  return <DetailKeyValueRowBase {...props} variant="mono" />;
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
  return (
    <DetailKeyValueRow label={attributeKey} value={value} removed={removed} />
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
 * rows. Reserved (`$`-prefixed) keys are sorted after user keys.
 */
export function RunAttributesCard({
  attributes,
}: {
  attributes: Record<string, string>;
}) {
  const keys = sortAttributeKeys(Object.keys(attributes));
  if (keys.length === 0) return null;

  return (
    <CollapsibleRoot defaultOpen>
      <CollapsibleTrigger>Attributes</CollapsibleTrigger>
      <CollapsibleContent className="mb-4">
        <div className="flex flex-col">
          {keys.map((key) => (
            <AttributeRow
              attributeKey={key}
              key={key}
              value={attributes[key]}
            />
          ))}
        </div>
      </CollapsibleContent>
    </CollapsibleRoot>
  );
}

function formatMetadataValue(value: unknown): string {
  if (value == null) {
    return String(value);
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isMetadataRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Collapsible section showing hook (or other resource) metadata as key-value
 * rows, matching the Attributes section styling.
 */
export function RunMetadataCard({ metadata }: { metadata: unknown }) {
  if (!isMetadataRecord(metadata)) {
    return (
      <CollapsibleRoot defaultOpen>
        <CollapsibleTrigger>Metadata</CollapsibleTrigger>
        <CollapsibleContent className="mb-4">
          <CopyableDataBlock data={metadata} />
        </CollapsibleContent>
      </CollapsibleRoot>
    );
  }

  const keys = Object.keys(metadata).sort((a, b) => a.localeCompare(b));
  if (keys.length === 0) return null;

  return (
    <CollapsibleRoot defaultOpen>
      <CollapsibleTrigger>Metadata</CollapsibleTrigger>
      <CollapsibleContent className="mb-4">
        <div className="flex flex-col">
          {keys.map((key) => (
            <AttributeRow
              attributeKey={key}
              key={key}
              value={formatMetadataValue(metadata[key])}
            />
          ))}
        </div>
      </CollapsibleContent>
    </CollapsibleRoot>
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
