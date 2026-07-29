'use client';

/**
 * Reusable data inspector for the o11y UI.
 *
 * Renders JSON as a collapsible tree: bracket notation (`{ … }` / `[ … ]`),
 * colored keys, typed value colors, `▸`/`▾` disclosure icons, and a `...`
 * collapsed indicator.
 *
 * On top of plain JSON it handles the workflow-specific value types: StreamRef /
 * RunRef badges, encrypted markers, decoded byte streams, Dates, and named
 * class instances.
 */

import { Lock } from 'lucide-react';
import {
  createContext,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
  useContext,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ENCRYPTED_DISPLAY_NAME } from '../../lib/hydration';
import {
  type DecodedStreamChunkSource,
  type FormattedStreamChunkDisplay,
  formatArrayBufferViewForDisplay,
} from '../../lib/stream-display';
import { Button } from './button';
import { CLS, JSON_VIEW_STYLES } from './data-inspector.styles';
import { Spinner } from './spinner';

// ---------------------------------------------------------------------------
// StreamRef / ClassInstanceRef type detection
// (inline to avoid circular deps with hydration module)
// ---------------------------------------------------------------------------

const STREAM_REF_TYPE = '__workflow_stream_ref__';
const CLASS_INSTANCE_REF_TYPE = '__workflow_class_instance_ref__';
const RUN_REF_TYPE = '__workflow_run_ref__';
const BYTES_DISPLAY_TYPE = '__workflow_bytes_display__';

interface StreamRef {
  __type: typeof STREAM_REF_TYPE;
  streamId: string;
}

interface RunRef {
  __type: typeof RUN_REF_TYPE;
  runId: string;
}

interface BytesDisplay {
  __type: typeof BYTES_DISPLAY_TYPE;
  text: string;
  decodedFrom?: DecodedStreamChunkSource;
}

interface ClassInstanceRef {
  __type: typeof CLASS_INSTANCE_REF_TYPE;
  className: string;
  classId: string;
  data: unknown;
}

function deserializeChunkText(text: string): string {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'string') {
      return parsed;
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return text;
  }
}

function parseChunkData(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isStreamRef(value: unknown): value is StreamRef {
  if (value === null || typeof value !== 'object') return false;
  // Check both enumerable and non-enumerable __type (opaque refs use non-enumerable)
  const desc = Object.getOwnPropertyDescriptor(value, '__type');
  return desc?.value === STREAM_REF_TYPE;
}

function isRunRef(value: unknown): value is RunRef {
  if (value === null || typeof value !== 'object') return false;
  const desc = Object.getOwnPropertyDescriptor(value, '__type');
  return desc?.value === RUN_REF_TYPE;
}

export function isBytesDisplay(value: unknown): value is BytesDisplay {
  if (value === null || typeof value !== 'object') return false;
  const desc = Object.getOwnPropertyDescriptor(value, '__type');
  return desc?.value === BYTES_DISPLAY_TYPE;
}

function isClassInstanceRef(value: unknown): value is ClassInstanceRef {
  return (
    value !== null &&
    typeof value === 'object' &&
    '__type' in value &&
    (value as Record<string, unknown>).__type === CLASS_INSTANCE_REF_TYPE
  );
}

function isEncryptedMarker(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as { constructor?: { name?: string } }).constructor?.name ===
      ENCRYPTED_DISPLAY_NAME
  );
}

// ---------------------------------------------------------------------------
// Stream click context (passed through from the panel)
// ---------------------------------------------------------------------------

/**
 * Context for passing stream click handlers down to DataInspector instances.
 * Exported so that parent components (e.g., AttributePanel) can provide the handler.
 */
export const StreamClickContext = createContext<
  ((streamId: string) => void) | undefined
>(undefined);

/**
 * Context for passing a decrypt handler down to DataInspector instances.
 * When provided, encrypted markers become clickable buttons that trigger decryption.
 */
export type DecryptClickContextValue = {
  onDecrypt: () => void;
  isDecrypting: boolean;
  hasEncryptedData?: boolean;
};

export const DecryptClickContext = createContext<
  DecryptClickContextValue | undefined
>(undefined);

export const RunClickContext = createContext<
  ((runId: string) => void) | undefined
>(undefined);

// ---------------------------------------------------------------------------
// Workflow-specific value renderers (badges, encrypted markers, byte streams)
// ---------------------------------------------------------------------------

function EncryptedInlineLabel() {
  const ctx = useContext(DecryptClickContext);
  if (ctx) {
    return (
      <Button
        size="xs"
        className="align-baseline gap-x-1"
        disabled={ctx.isDecrypting}
        onClick={(e) => {
          e.stopPropagation();
          ctx.onDecrypt();
        }}
      >
        {ctx.isDecrypting ? (
          <Spinner size={10} />
        ) : (
          <Lock className="h-3 w-3" />
        )}
        <span>Decrypt</span>
      </Button>
    );
  }
  return (
    <span style={{ color: 'var(--ds-gray-600)', fontStyle: 'italic' }}>
      <Lock
        className="h-3 w-3"
        style={{
          display: 'inline',
          verticalAlign: 'middle',
          marginRight: '3px',
          marginTop: '-1px',
        }}
      />
      Encrypted
    </span>
  );
}

function StreamRefInline({ streamRef }: { streamRef: StreamRef }) {
  const onStreamClick = useContext(StreamClickContext);
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono cursor-pointer underline decoration-transparent transition-colors"
      style={{
        backgroundColor: hovered ? 'var(--ds-blue-200)' : 'var(--ds-blue-100)',
        color: 'var(--ds-blue-900)',
        border: '1px solid var(--ds-blue-300)',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={(e) => {
        e.stopPropagation();
        onStreamClick?.(streamRef.streamId);
      }}
      title={`View stream: ${streamRef.streamId}`}
    >
      <span>📡</span>
      <span>{streamRef.streamId}</span>
    </button>
  );
}

function RunRefInline({ runRef }: { runRef: RunRef }) {
  const onRunClick = useContext(RunClickContext);
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono cursor-pointer underline decoration-transparent transition-colors"
      style={{
        backgroundColor: hovered
          ? 'var(--ds-purple-200)'
          : 'var(--ds-purple-100)',
        color: 'var(--ds-purple-900)',
        border: '1px solid var(--ds-purple-300)',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={(e) => {
        e.stopPropagation();
        onRunClick?.(runRef.runId);
      }}
      title={`View run: ${runRef.runId}`}
    >
      <span>{runRef.runId}</span>
    </button>
  );
}

function DecodedBytesChunk({
  decodedText,
  source,
}: {
  decodedText: string;
  source: DecodedStreamChunkSource;
}) {
  const [selectedView, setSelectedView] = useState<'decoded' | 'bytes'>(
    'decoded'
  );
  const parsed = parseChunkData(decodedText);

  return (
    <div className="min-w-0">
      {selectedView === 'decoded' ? (
        <div className="min-w-0">
          {typeof parsed === 'string' ? (
            <span
              className="whitespace-pre-wrap break-words"
              style={{ color: 'var(--ds-gray-1000)' }}
            >
              {deserializeChunkText(parsed)}
            </span>
          ) : (
            <DataInspector data={parsed} expandLevel={1} />
          )}
        </div>
      ) : (
        <DecodedBytesInspector decodedText={decodedText} source={source} />
      )}
      <div className="mt-2 flex">
        <div
          className="inline-flex overflow-hidden rounded border"
          style={{ borderColor: 'var(--ds-gray-400)' }}
          title={`${source.type} decoded as ${source.encoding.toUpperCase()} text. Switch to Bytes to inspect the summarized raw value.`}
        >
          <button
            type="button"
            className="h-5 px-1.5 text-[10px] font-medium"
            style={{
              backgroundColor:
                selectedView === 'decoded'
                  ? 'var(--ds-gray-200)'
                  : 'var(--ds-gray-100)',
              color: 'var(--ds-gray-900)',
            }}
            onClick={() => setSelectedView('decoded')}
            aria-pressed={selectedView === 'decoded'}
            aria-label="Show decoded text"
          >
            Decoded
          </button>
          <button
            type="button"
            className="h-5 border-l px-1.5 text-[10px] font-medium"
            style={{
              borderColor: 'var(--ds-gray-400)',
              backgroundColor:
                selectedView === 'bytes'
                  ? 'var(--ds-gray-200)'
                  : 'var(--ds-gray-100)',
              color: 'var(--ds-gray-900)',
            }}
            onClick={() => setSelectedView('bytes')}
            aria-pressed={selectedView === 'bytes'}
            aria-label="Show raw bytes summary"
          >
            Bytes
          </button>
        </div>
      </div>
    </div>
  );
}

function DecodedBytesInspector({
  decodedText,
  source,
}: {
  decodedText: string;
  source: DecodedStreamChunkSource;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="font-mono">
      <button
        type="button"
        className="flex max-w-full items-start gap-1 text-left"
        style={{ color: 'var(--ds-gray-1000)' }}
        onClick={() => setExpanded((value) => !value)}
        title={`${source.type} decoded as ${source.encoding.toUpperCase()} text`}
      >
        <span className="select-none" style={{ color: 'var(--ds-gray-700)' }}>
          {expanded ? '▼' : '▶'}
        </span>
        <span className="min-w-0 break-words">{source.rawSummary}</span>
      </button>
      {expanded && (
        <div className="mt-1 pl-5">
          <span style={{ color: 'var(--ds-gray-700)' }}>decoded: </span>
          <span
            className="whitespace-pre-wrap break-words"
            style={{ color: 'var(--ds-green-900)' }}
          >
            {JSON.stringify(decodedText)}
          </span>
        </div>
      )}
    </div>
  );
}

function BytesDisplayValue({ display }: { display: BytesDisplay }) {
  if (display.decodedFrom) {
    return (
      <DecodedBytesChunk
        decodedText={display.text}
        source={display.decodedFrom}
      />
    );
  }
  return (
    <span
      className="whitespace-pre-wrap break-words"
      style={{ color: 'var(--ds-gray-1000)' }}
    >
      {display.text}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Tree renderer
// ---------------------------------------------------------------------------

type Entry = [field: string | undefined, value: unknown];

interface NodeContext {
  level: number;
  shouldExpand: (level: number) => boolean;
  outerRef: RefObject<HTMLDivElement | null>;
}

/** Field names are rendered unquoted (empty string shows as `""`). */
function formatField(field: string): string {
  return field === '' ? '""' : field;
}

/**
 * Describe an object/array/map/set as an expandable container. Returns null for
 * values that should render as a primitive. `prefix` carries a class name shown
 * before the opening bracket (Map/Set and named class instances).
 */
function describeContainer(
  value: unknown
): { entries: Entry[]; open: string; close: string; prefix?: string } | null {
  if (Array.isArray(value)) {
    return {
      entries: value.map((item) => [undefined, item] as Entry),
      open: '[',
      close: ']',
    };
  }
  if (value instanceof Map) {
    return {
      entries: Array.from(value.entries(), ([key, val]) => [
        String(key),
        val,
      ]) as Entry[],
      open: '{',
      close: '}',
      prefix: 'Map',
    };
  }
  if (value instanceof Set) {
    return {
      entries: Array.from(value.values(), (item) => [undefined, item] as Entry),
      open: '[',
      close: ']',
      prefix: 'Set',
    };
  }
  if (value !== null && typeof value === 'object') {
    const name = (value as { constructor?: { name?: string } }).constructor
      ?.name;
    return {
      entries: Object.entries(value) as Entry[],
      open: '{',
      close: '}',
      prefix: name && name !== 'Object' ? name : undefined,
    };
  }
  return null;
}

function describePrimitive(value: unknown): { text: string; cls: string } {
  if (value === null) return { text: 'null', cls: CLS.null };
  if (value === undefined) return { text: 'undefined', cls: CLS.undefined };
  if (typeof value === 'string' || value instanceof String) {
    return { text: `"${String(value)}"`, cls: CLS.string };
  }
  if (typeof value === 'boolean' || value instanceof Boolean) {
    return { text: String(value), cls: CLS.boolean };
  }
  if (typeof value === 'number' || value instanceof Number) {
    return { text: String(value), cls: CLS.number };
  }
  if (typeof value === 'bigint') {
    return { text: `${value.toString()}n`, cls: CLS.number };
  }
  return { text: String(value), cls: CLS.punctuation };
}

function Label({ field, clickable }: { field?: string; clickable?: boolean }) {
  if (field === undefined) return null;
  return (
    <span className={clickable ? CLS.clickableLabel : CLS.label}>
      {`${formatField(field)}:`}
    </span>
  );
}

function Comma({ isLast }: { isLast: boolean }) {
  if (isLast) return null;
  return <span className={CLS.punctuation}>,</span>;
}

/** A non-expandable row: `field: <value>`. */
function LeafRow({
  field,
  isLast,
  children,
}: {
  field?: string;
  isLast: boolean;
  children: ReactNode;
}) {
  return (
    <div className={CLS.child} role="treeitem" tabIndex={-1}>
      <Label field={field} />
      {children}
      <Comma isLast={isLast} />
    </div>
  );
}

function PrimitiveValue({ field, value, isLast }: NodeProps) {
  const { text, cls } = describePrimitive(value);
  return (
    <LeafRow field={field} isLast={isLast}>
      <span className={cls}>{text}</span>
    </LeafRow>
  );
}

function EmptyContainer({
  field,
  prefix,
  open,
  close,
  isLast,
}: {
  field?: string;
  prefix?: string;
  open: string;
  close: string;
  isLast: boolean;
}) {
  return (
    <div className={CLS.child} role="treeitem" tabIndex={-1}>
      <Label field={field} />
      {prefix ? <span className={CLS.className}>{prefix}</span> : null}
      <span className={CLS.punctuation}>{open}</span>
      <span className={CLS.punctuation}>{close}</span>
      <Comma isLast={isLast} />
    </div>
  );
}

function focusExpander(
  button: HTMLElement,
  outerRef: RefObject<HTMLDivElement | null>
) {
  const previous = outerRef.current?.querySelector<HTMLElement>(
    '[data-json-expander][tabindex="0"]'
  );
  if (previous) previous.tabIndex = -1;
  button.tabIndex = 0;
  button.focus();
}

function moveExpanderFocus(
  outerRef: RefObject<HTMLDivElement | null>,
  direction: 1 | -1
) {
  const root = outerRef.current;
  if (!root) return;
  const buttons = root.querySelectorAll<HTMLElement>('[data-json-expander]');
  let current = -1;
  for (let i = 0; i < buttons.length; i += 1) {
    if (buttons[i].tabIndex === 0) {
      current = i;
      break;
    }
  }
  if (current < 0) return;
  const next = (current + direction + buttons.length) % buttons.length;
  buttons[current].tabIndex = -1;
  buttons[next].tabIndex = 0;
  buttons[next].focus();
}

function ExpandableContainer({
  field,
  entries,
  open,
  close,
  prefix,
  ctx,
  isLast,
}: {
  field?: string;
  entries: Entry[];
  open: string;
  close: string;
  prefix?: string;
  ctx: NodeContext;
  isLast: boolean;
}) {
  const { level, shouldExpand, outerRef } = ctx;
  const [expanded, setExpanded] = useState(() => shouldExpand(level));
  const rowRef = useRef<HTMLDivElement>(null);
  const contentsId = useId();

  if (entries.length === 0) {
    return (
      <EmptyContainer
        field={field}
        prefix={prefix}
        open={open}
        close={close}
        isLast={isLast}
      />
    );
  }

  const toggle = () => {
    setExpanded((value) => !value);
    if (rowRef.current) focusExpander(rowRef.current, outerRef);
  };

  // Toggle only for clicks that land on this row itself; clicks bubbling up out
  // of a nested treeitem are handled by that descendant's own row.
  const onClick = (event: ReactMouseEvent) => {
    if (
      (event.target as HTMLElement).closest('[role="treeitem"]') !==
      event.currentTarget
    ) {
      return;
    }
    toggle();
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      setExpanded(true);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setExpanded(false);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveExpanderFocus(outerRef, -1);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveExpanderFocus(outerRef, 1);
    }
  };

  const lastIndex = entries.length - 1;

  return (
    // The treeitem row is the focusable, keyboard-operable control (roving
    // tabindex + arrow keys); the disclosure marker below is purely decorative.
    <div
      className={CLS.child}
      role="treeitem"
      aria-expanded={expanded}
      aria-controls={expanded ? contentsId : undefined}
      data-json-expander
      ref={rowRef}
      tabIndex={level === 0 ? 0 : -1}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      <span
        className={expanded ? CLS.collapseIcon : CLS.expandIcon}
        aria-hidden="true"
      />
      {field !== undefined && (
        <span className={CLS.clickableLabel}>{`${formatField(field)}:`}</span>
      )}
      {prefix ? <span className={CLS.className}>{prefix}</span> : null}
      <span className={CLS.punctuation}>{open}</span>
      {expanded ? (
        // biome-ignore lint/a11y/useSemanticElements: ARIA tree group is the correct role here
        <ul id={contentsId} className={CLS.childFields} role="group">
          {entries.map(([childField, childValue], index) => (
            <DataRender
              key={childField ?? index}
              field={childField}
              value={childValue}
              isLast={index === lastIndex}
              ctx={{ ...ctx, level: level + 1 }}
            />
          ))}
        </ul>
      ) : (
        <span className={CLS.collapsedContent} aria-hidden="true" />
      )}
      <span className={CLS.punctuation}>{close}</span>
      <Comma isLast={isLast} />
    </div>
  );
}

interface NodeProps {
  field?: string;
  value: unknown;
  isLast: boolean;
  ctx: NodeContext;
}

function DataRender({ field, value, isLast, ctx }: NodeProps) {
  if (isBytesDisplay(value)) {
    return (
      <LeafRow field={field} isLast={isLast}>
        <BytesDisplayValue display={value} />
      </LeafRow>
    );
  }
  if (isEncryptedMarker(value)) {
    return (
      <LeafRow field={field} isLast={isLast}>
        <EncryptedInlineLabel />
      </LeafRow>
    );
  }
  if (isStreamRef(value)) {
    return (
      <LeafRow field={field} isLast={isLast}>
        <StreamRefInline streamRef={value} />
      </LeafRow>
    );
  }
  if (isRunRef(value)) {
    return (
      <LeafRow field={field} isLast={isLast}>
        <RunRefInline runRef={value} />
      </LeafRow>
    );
  }
  if (value instanceof Date) {
    return (
      <LeafRow field={field} isLast={isLast}>
        <span className={CLS.date}>{value.toISOString()}</span>
      </LeafRow>
    );
  }
  if (value instanceof RegExp) {
    return (
      <LeafRow field={field} isLast={isLast}>
        <span className={CLS.regexp}>{value.toString()}</span>
      </LeafRow>
    );
  }
  if (isClassInstanceRef(value)) {
    return (
      <ClassInstanceNode
        field={field}
        instance={value}
        isLast={isLast}
        ctx={ctx}
      />
    );
  }

  const container = describeContainer(value);
  if (container) {
    return (
      <ExpandableContainer
        field={field}
        entries={container.entries}
        open={container.open}
        close={container.close}
        prefix={container.prefix}
        ctx={ctx}
        isLast={isLast}
      />
    );
  }

  return (
    <PrimitiveValue field={field} value={value} isLast={isLast} ctx={ctx} />
  );
}

function ClassInstanceNode({
  field,
  instance,
  isLast,
  ctx,
}: {
  field?: string;
  instance: ClassInstanceRef;
  isLast: boolean;
  ctx: NodeContext;
}) {
  const container = describeContainer(instance.data);
  if (container) {
    return (
      <ExpandableContainer
        field={field}
        entries={container.entries}
        open={container.open}
        close={container.close}
        prefix={instance.className}
        ctx={ctx}
        isLast={isLast}
      />
    );
  }
  const { text, cls } = describePrimitive(instance.data);
  return (
    <LeafRow field={field} isLast={isLast}>
      <span className={CLS.className}>{instance.className}</span>
      <span className={cls}>{text}</span>
    </LeafRow>
  );
}

function JsonTree({
  data,
  name,
  expandLevel,
}: {
  data: unknown;
  name?: string;
  expandLevel: number;
}) {
  const outerRef = useRef<HTMLDivElement>(null);
  const shouldExpand = useMemo(
    () => (level: number) => level < expandLevel,
    [expandLevel]
  );
  return (
    <div
      ref={outerRef}
      className={CLS.container}
      role="tree"
      aria-label="JSON view"
    >
      <DataRender
        field={name}
        value={data}
        isLast
        ctx={{ level: 0, shouldExpand, outerRef }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ref / typed-array collapsing (preprocessing before render)
// ---------------------------------------------------------------------------

/**
 * Create a non-expandable wrapper that carries ref data as non-enumerable
 * properties so the renderer can detect StreamRef/RunRef without exposing
 * their internals as object fields.
 */
function makeOpaqueRef(ref: Record<string, unknown>): unknown {
  const opaque = Object.create(null);
  for (const [key, value] of Object.entries(ref)) {
    Object.defineProperty(opaque, key, { value, enumerable: false });
  }
  return opaque;
}

function makeBytesDisplay(display: FormattedStreamChunkDisplay): unknown {
  const opaque = Object.create(null);
  Object.defineProperty(opaque, '__type', {
    value: BYTES_DISPLAY_TYPE,
    enumerable: false,
  });
  Object.defineProperty(opaque, 'text', {
    value: display.text,
    enumerable: false,
  });
  Object.defineProperty(opaque, 'decodedFrom', {
    value: display.decodedFrom,
    enumerable: false,
  });
  return opaque;
}

/**
 * Recursively walk data and replace RunRef/StreamRef/typed array objects with
 * non-expandable versions so the renderer doesn't show their internals.
 * Only recurses into plain objects and arrays to avoid stripping class
 * instances (Date, Error, URL, Headers, etc.) that have their own rendering.
 * Map and Set containers are preserved while their contents are prepared for
 * display.
 *
 * Exported for testing the typed-array detection path used by hydrated
 * AI agent stream chunks (e.g. `{ delta: new Uint8Array(...) }`).
 */
export function collapseRefs(data: unknown): unknown {
  if (data === null || typeof data !== 'object') return data;
  if (ArrayBuffer.isView(data) && !(data instanceof DataView)) {
    return makeBytesDisplay(formatArrayBufferViewForDisplay(data));
  }
  if (isRunRef(data) || isStreamRef(data))
    return makeOpaqueRef(data as unknown as Record<string, unknown>);
  if (Array.isArray(data)) return data.map(collapseRefs);
  if (data instanceof Map) {
    return new Map(
      Array.from(data.entries(), ([key, value]) => [
        collapseRefs(key),
        collapseRefs(value),
      ])
    );
  }
  if (data instanceof Set) {
    return new Set(Array.from(data.values(), collapseRefs));
  }
  // Only recurse into plain objects — leave class instances untouched
  const proto = Object.getPrototypeOf(data);
  if (proto !== Object.prototype && proto !== null) return data;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    result[key] = collapseRefs(value);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export interface DataInspectorProps {
  /** The data to inspect */
  data: unknown;
  /** Levels strictly below this number auto-expand (default: 2) */
  expandLevel?: number;
  /** Optional name for the root node */
  name?: string;
  /** Callback when a stream reference is clicked */
  onStreamClick?: (streamId: string) => void;
  /** Callback when a run reference is clicked */
  onRunClick?: (runId: string) => void;
  /** Callback when an encrypted marker is clicked (triggers decryption) */
  onDecrypt?: () => void;
  /** Whether decryption is currently in progress */
  isDecrypting?: boolean;
}

export function DataInspector({
  data,
  expandLevel = 2,
  name,
  onStreamClick,
  onRunClick,
  onDecrypt,
  isDecrypting = false,
}: DataInspectorProps) {
  const collapsedData = useMemo(() => collapseRefs(data), [data]);
  const stableData = useStableInspectorData(collapsedData);

  let content: ReactNode = (
    <>
      {/* React 19 hoists & dedupes this <style> by href, so it is emitted once
          regardless of how many inspectors are mounted. */}
      <style href="wf-json-view" precedence="default">
        {JSON_VIEW_STYLES}
      </style>
      <JsonTree data={stableData} name={name} expandLevel={expandLevel} />
    </>
  );

  if (onStreamClick) {
    content = (
      <StreamClickContext.Provider value={onStreamClick}>
        {content}
      </StreamClickContext.Provider>
    );
  }
  if (onRunClick) {
    content = (
      <RunClickContext.Provider value={onRunClick}>
        {content}
      </RunClickContext.Provider>
    );
  }
  if (onDecrypt) {
    content = (
      <DecryptClickContext.Provider value={{ onDecrypt, isDecrypting }}>
        {content}
      </DecryptClickContext.Provider>
    );
  }

  return content;
}

// ---------------------------------------------------------------------------
// Render stabilization (avoid re-renders when data is deeply equal)
// ---------------------------------------------------------------------------

function useStableInspectorData<T>(next: T): T {
  const previousRef = useRef<T>(next);
  if (!isDeepEqual(previousRef.current, next)) {
    previousRef.current = next;
  }
  return previousRef.current;
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSameBytesDisplay(a: BytesDisplay, b: BytesDisplay): boolean {
  return (
    a.text === b.text &&
    a.decodedFrom?.type === b.decodedFrom?.type &&
    a.decodedFrom?.encoding === b.decodedFrom?.encoding &&
    a.decodedFrom?.rawSummary === b.decodedFrom?.rawSummary
  );
}

function isDeepEqual(a: unknown, b: unknown, seen = new WeakMap()): boolean {
  if (Object.is(a, b)) return true;

  if (isBytesDisplay(a) || isBytesDisplay(b)) {
    return isBytesDisplay(a) && isBytesDisplay(b) && isSameBytesDisplay(a, b);
  }

  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }

  if (a instanceof RegExp && b instanceof RegExp) {
    return a.source === b.source && a.flags === b.flags;
  }

  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [key, value] of a.entries()) {
      if (!b.has(key) || !isDeepEqual(value, b.get(key), seen)) return false;
    }
    return true;
  }

  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    for (const value of a.values()) {
      if (!b.has(value)) return false;
    }
    return true;
  }

  if (!isObjectLike(a) || !isObjectLike(b)) {
    return false;
  }

  if (seen.get(a) === b) return true;
  seen.set(a, b);

  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray !== bIsArray) return false;

  if (aIsArray && bIsArray) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!isDeepEqual(a[i], b[i], seen)) return false;
    }
    return true;
  }

  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;

  for (const key of aKeys) {
    if (!Object.hasOwn(b, key)) return false;
    if (!isDeepEqual(a[key], b[key], seen)) return false;
  }

  return true;
}
