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

interface StreamRef {
  __type: typeof STREAM_REF_TYPE;
  streamId: string;
}

function isStreamRef(value: unknown): value is StreamRef {
  return (
    value !== null &&
    typeof value === 'object' &&
    '__type' in value &&
    (value as Record<string, unknown>).__type === STREAM_REF_TYPE
  );
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
          <span
            className="h-3 w-3 animate-spin rounded-full border-2"
            style={{
              display: 'inline-block',
              flexShrink: 0,
              borderColor: 'var(--ds-gray-400)',
              borderTopColor: 'var(--ds-gray-700)',
            }}
          />
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
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono cursor-pointer"
      style={{
        backgroundColor: 'var(--ds-blue-100)',
        color: 'var(--ds-blue-800)',
        border: '1px solid var(--ds-blue-300)',
      }}
      onClick={() => onStreamClick?.(streamRef.streamId)}
      title={`View stream: ${streamRef.streamId}`}
    >
      <span>📡</span>
      <span>{streamRef.streamId}</span>
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

export interface DataInspectorProps {
  /** The data to inspect */
  data: unknown;
  /** Initial expand depth (default: 2) */
  expandLevel?: number;
  /** Optional name for the root node */
  name?: string;
  /** Callback when a stream reference is clicked */
  onStreamClick?: (streamId: string) => void;
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
  onDecrypt,
  isDecrypting = false,
}: DataInspectorProps) {
  const stableData = useStableInspectorData(data);
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
