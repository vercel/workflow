'use client';

/**
 * Reusable data inspector component built on react-inspector.
 *
 * All data rendering in the o11y UI should use this component to ensure
 * consistent theming, custom type handling (StreamRef, ClassInstanceRef),
 * and expand behavior.
 */

import { Lock } from 'lucide-react';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ObjectInspector,
  ObjectLabel,
  ObjectName,
  ObjectRootLabel,
  ObjectValue,
} from 'react-inspector';
import { useDarkMode } from '../../hooks/use-dark-mode';
import { ENCRYPTED_DISPLAY_NAME } from '../../lib/hydration';
import {
  type DecodedStreamChunkSource,
  type FormattedStreamChunkDisplay,
  formatArrayBufferViewForDisplay,
} from '../../lib/stream-display';
import {
  type InspectorThemeExtended,
  inspectorThemeDark,
  inspectorThemeExtendedDark,
  inspectorThemeExtendedLight,
  inspectorThemeLight,
} from './inspector-theme';
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

function isClassInstanceRef(value: unknown): value is {
  __type: string;
  className: string;
  classId: string;
  data: unknown;
} {
  return (
    value !== null &&
    typeof value === 'object' &&
    '__type' in value &&
    (value as Record<string, unknown>).__type === CLASS_INSTANCE_REF_TYPE
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
};

export const DecryptClickContext = createContext<
  DecryptClickContextValue | undefined
>(undefined);

export const RunClickContext = createContext<
  ((runId: string) => void) | undefined
>(undefined);

function EncryptedInlineLabel() {
  const ctx = useContext(DecryptClickContext);
  if (ctx) {
    return (
      <button
        type="button"
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] cursor-pointer"
        style={{
          backgroundColor: 'var(--ds-gray-100)',
          color: 'var(--ds-gray-700)',
          border: '1px solid var(--ds-gray-400)',
          fontStyle: 'italic',
          opacity: ctx.isDecrypting ? 0.6 : 1,
        }}
        disabled={ctx.isDecrypting}
        onClick={(e) => {
          e.stopPropagation();
          ctx.onDecrypt();
        }}
        title="Click to decrypt"
      >
        {ctx.isDecrypting ? (
          <Spinner size={12} />
        ) : (
          <Lock
            className="h-3 w-3"
            style={{ display: 'inline', flexShrink: 0 }}
          />
        )}
        <span>{ctx.isDecrypting ? 'Decrypting…' : 'Decrypt'}</span>
      </button>
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

// ---------------------------------------------------------------------------
// Extended theme context (for colors react-inspector doesn't support natively)
// ---------------------------------------------------------------------------

const ExtendedThemeContext = createContext<InspectorThemeExtended>(
  inspectorThemeExtendedLight
);

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

function BytesDisplayLabel({
  name,
  display,
}: {
  name?: string;
  display: BytesDisplay;
}) {
  return (
    <div className="inline-block min-w-0 align-top">
      {name != null && <ObjectName name={name} />}
      {name != null && <span>: </span>}
      {display.decodedFrom ? (
        <DecodedBytesChunk
          decodedText={display.text}
          source={display.decodedFrom}
        />
      ) : (
        <span
          className="whitespace-pre-wrap break-words"
          style={{ color: 'var(--ds-gray-1000)' }}
        >
          {display.text}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Custom nodeRenderer
// ---------------------------------------------------------------------------

/**
 * Extends the default react-inspector nodeRenderer with special handling
 * for ClassInstanceRef, StreamRef, and Date types.
 *
 * react-inspector renders Date instances as unstyled plain text (no theme
 * key exists for them), so we intercept here and apply the magenta color
 * from our extended theme — matching Node.js util.inspect()'s date style.
 *
 * Default nodeRenderer reference:
 * https://github.com/storybookjs/react-inspector/blob/main/README.md#noderenderer
 */
function NodeRenderer({
  depth,
  name,
  data,
  isNonenumerable,
}: {
  depth: number;
  name?: string;
  data: unknown;
  isNonenumerable?: boolean;
  expanded?: boolean;
}) {
  const extendedTheme = useContext(ExtendedThemeContext);

  if (isBytesDisplay(data)) {
    return <BytesDisplayLabel name={name} display={data} />;
  }

  // Encrypted marker → flat label with Lock icon, clickable when onDecrypt is available
  if (
    data !== null &&
    typeof data === 'object' &&
    data.constructor?.name === ENCRYPTED_DISPLAY_NAME
  ) {
    const label = <EncryptedInlineLabel />;
    if (depth === 0) {
      return label;
    }
    return (
      <span>
        {name != null && <ObjectName name={name} />}
        {name != null && <span>: </span>}
        {label}
      </span>
    );
  }

  // StreamRef → inline clickable badge
  if (isStreamRef(data)) {
    return (
      <span>
        {name != null && <ObjectName name={name} />}
        {name != null && <span>: </span>}
        <StreamRefInline streamRef={data} />
      </span>
    );
  }

  // RunRef → inline clickable badge linking to the target run
  if (isRunRef(data)) {
    return (
      <span>
        {name != null && <ObjectName name={name} />}
        {name != null && <span>: </span>}
        <RunRefInline runRef={data} />
      </span>
    );
  }

  // ClassInstanceRef → show className as type, data as the inspectable value
  if (isClassInstanceRef(data)) {
    if (depth === 0) {
      return <ObjectRootLabel name={data.className} data={data.data} />;
    }
    return (
      <span>
        {name != null && <ObjectName name={name} />}
        {name != null && <span>: </span>}
        <span style={{ fontStyle: 'italic' }}>{data.className} </span>
        <ObjectValue object={data.data} />
      </span>
    );
  }

  // Date → magenta color (Node.js: 'date' → 'magenta')
  // react-inspector has no OBJECT_VALUE_DATE_COLOR theme key, so we handle it here.
  if (data instanceof Date) {
    const dateStr = data.toISOString();
    if (depth === 0) {
      return (
        <span style={{ color: extendedTheme.OBJECT_VALUE_DATE_COLOR }}>
          {dateStr}
        </span>
      );
    }
    return (
      <span>
        {name != null && <ObjectName name={name} />}
        {name != null && <span>: </span>}
        <span style={{ color: extendedTheme.OBJECT_VALUE_DATE_COLOR }}>
          {dateStr}
        </span>
      </span>
    );
  }

  // Default rendering (same as react-inspector's built-in)
  if (depth === 0) {
    return <ObjectRootLabel name={name} data={data} />;
  }
  return (
    <ObjectLabel name={name} data={data} isNonenumerable={isNonenumerable} />
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

/**
 * Create a non-expandable wrapper that carries ref data as non-enumerable
 * properties. ObjectInspector won't render children for objects with no
 * enumerable keys, but our NodeRenderer can still detect them.
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
 * non-expandable versions so ObjectInspector doesn't show their internals.
 * Only recurses into plain objects and arrays to avoid stripping class
 * instances (Date, Error, URL, Headers, etc.) that have their own rendering in
 * NodeRenderer. Map and Set containers are preserved while their contents are
 * prepared for display.
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

export interface DataInspectorProps {
  /** The data to inspect */
  data: unknown;
  /** Initial expand depth (default: 2) */
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
  const [initialExpandLevel, setInitialExpandLevel] = useState(expandLevel);
  const isDark = useDarkMode();
  const extendedTheme = isDark
    ? inspectorThemeExtendedDark
    : inspectorThemeExtendedLight;

  useEffect(() => {
    // react-inspector reapplies expandLevel on every data change, which can
    // reopen paths the user manually collapsed. Apply it only on mount.
    setInitialExpandLevel(0);
  }, []);

  const content = (
    <ExtendedThemeContext.Provider value={extendedTheme}>
      <ObjectInspector
        data={stableData}
        name={name}
        // @ts-expect-error react-inspector accepts theme objects at runtime despite
        // types declaring string only — see https://github.com/storybookjs/react-inspector/blob/main/README.md#theme
        theme={isDark ? inspectorThemeDark : inspectorThemeLight}
        expandLevel={initialExpandLevel}
        nodeRenderer={NodeRenderer}
      />
    </ExtendedThemeContext.Provider>
  );

  let wrapped = content;

  if (onStreamClick) {
    wrapped = (
      <StreamClickContext.Provider value={onStreamClick}>
        {wrapped}
      </StreamClickContext.Provider>
    );
  }
  if (onRunClick) {
    wrapped = (
      <RunClickContext.Provider value={onRunClick}>
        {wrapped}
      </RunClickContext.Provider>
    );
  }
  if (onDecrypt) {
    wrapped = (
      <DecryptClickContext.Provider value={{ onDecrypt, isDecrypting }}>
        {wrapped}
      </DecryptClickContext.Provider>
    );
  }

  return wrapped;
}

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
