'use client';

/**
 * Reusable data inspector component built on react-inspector.
 *
 * All data rendering in the o11y UI should use this component to ensure
 * consistent theming, custom type handling (StreamRef, ClassInstanceRef),
 * and expand behavior.
 */

import { createContext, useContext } from 'react';
import {
  ObjectInspector,
  ObjectLabel,
  ObjectName,
  ObjectRootLabel,
  ObjectValue,
} from 'react-inspector';
import { useDarkMode } from '../../hooks/use-dark-mode';
import { inspectorThemeDark, inspectorThemeLight } from './inspector-theme';

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
// Custom nodeRenderer
// ---------------------------------------------------------------------------

/**
 * Extends the default react-inspector nodeRenderer with special handling
 * for ClassInstanceRef and StreamRef types.
 *
 * Default nodeRenderer reference:
 * https://github.com/storybookjs/react-inspector/blob/main/README.md#noderenderer
 */
const nodeRenderer = ({
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
}) => {
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

  // Default rendering (same as react-inspector's built-in)
  if (depth === 0) {
    return <ObjectRootLabel name={name} data={data} />;
  }
  return (
    <ObjectLabel name={name} data={data} isNonenumerable={isNonenumerable} />
  );
};

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
}

export function DataInspector({
  data,
  expandLevel = 2,
  name,
  onStreamClick,
}: DataInspectorProps) {
  const isDark = useDarkMode();

  const content = (
    <ObjectInspector
      data={data}
      name={name}
      // @ts-expect-error react-inspector accepts theme objects at runtime despite
      // types declaring string only — see https://github.com/storybookjs/react-inspector/blob/main/README.md#theme
      theme={isDark ? inspectorThemeDark : inspectorThemeLight}
      expandLevel={expandLevel}
      nodeRenderer={nodeRenderer}
    />
  );

  // Wrap in StreamClickContext if a handler is provided
  if (onStreamClick) {
    return (
      <StreamClickContext.Provider value={onStreamClick}>
        {content}
      </StreamClickContext.Provider>
    );
  }

  return content;
}
