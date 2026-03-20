'use client';

/**
 * Reusable data inspector component built on react-inspector.
 *
 * All data rendering in the o11y UI should use this component to ensure
 * consistent theming, custom type handling (StreamRef, ClassInstanceRef),
 * and expand behavior.
 */

import { Lock } from 'lucide-react';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
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
  type InspectorThemeExtended,
  inspectorThemeDark,
  inspectorThemeExtendedDark,
  inspectorThemeExtendedLight,
  inspectorThemeLight,
} from './inspector-theme';

// ---------------------------------------------------------------------------
// StreamRef / ClassInstanceRef type detection
// (inline to avoid circular deps with hydration module)
// ---------------------------------------------------------------------------

const STREAM_REF_TYPE = '__workflow_stream_ref__';
const CLASS_INSTANCE_REF_TYPE = '__workflow_class_instance_ref__';
const RUN_REF_TYPE = '__workflow_run_ref__';

interface StreamRef {
  __type: typeof STREAM_REF_TYPE;
  streamId: string;
}

interface RunRef {
  __type: typeof RUN_REF_TYPE;
  runId: string;
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

export const RunClickContext = createContext<
  ((runId: string) => void) | undefined
>(undefined);

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

  // Encrypted marker → flat label with Lock icon, non-expandable
  if (
    data !== null &&
    typeof data === 'object' &&
    data.constructor?.name === ENCRYPTED_DISPLAY_NAME
  ) {
    const label = (
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

/**
 * Recursively walk data and replace RunRef/StreamRef objects with
 * non-expandable versions so ObjectInspector doesn't show their internals.
 */
function collapseRefs(data: unknown): unknown {
  if (data === null || typeof data !== 'object') return data;
  if (isRunRef(data) || isStreamRef(data))
    return makeOpaqueRef(data as unknown as Record<string, unknown>);
  if (Array.isArray(data)) return data.map(collapseRefs);
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
}

export function DataInspector({
  data,
  expandLevel = 2,
  name,
  onStreamClick,
  onRunClick,
}: DataInspectorProps) {
  const stableData = useStableInspectorData(collapseRefs(data));
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

  let content = (
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

  // Wrap in click contexts if handlers are provided
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

  return content;
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

function isDeepEqual(a: unknown, b: unknown, seen = new WeakMap()): boolean {
  if (Object.is(a, b)) return true;

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
