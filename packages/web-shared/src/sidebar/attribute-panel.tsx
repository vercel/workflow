'use client';

import { parseStepName, parseWorkflowName } from '@workflow/utils/parse-name';
import type { Event, Hook, Step, WorkflowRun } from '@workflow/world';
import type { ModelMessage } from 'ai';
import type { ReactNode } from 'react';
import { createContext, useContext, useMemo, useState } from 'react';
import { ErrorCard } from '../components/ui/error-card';
import { useDarkMode } from '../hooks/use-dark-mode';
import { extractConversation, isDoStreamStep } from '../lib/utils';
import { ConversationView } from './conversation-view';
import { DetailCard } from './detail-card';

/**
 * Tab button for conversation/JSON toggle
 */
function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-3 py-1.5 text-[11px] font-medium transition-colors -mb-px"
      style={{
        // Explicit styles to prevent app-level button overrides when web-shared
        // is embedded in a self-hosted app.
        backgroundColor: 'transparent',
        borderTop: 'none',
        borderLeft: 'none',
        borderRight: 'none',
        borderBottom: `2px solid ${active ? 'var(--ds-blue-600)' : 'transparent'}`,
        borderRadius: 0,
        outline: 'none',
        boxShadow: 'none',
        cursor: 'pointer',
        color: active ? 'var(--ds-gray-1000)' : 'var(--ds-gray-600)',
      }}
    >
      {children}
    </button>
  );
}

/**
 * Tabbed view for conversation and raw JSON
 */
function ConversationWithTabs({
  conversation,
  args,
}: {
  conversation: ModelMessage[];
  args: unknown[];
}) {
  const [activeTab, setActiveTab] = useState<'conversation' | 'json'>(
    'conversation'
  );

  return (
    <DetailCard summary={`Input (${conversation.length} messages)`}>
      <div
        className="rounded-md border"
        style={{
          borderColor: 'var(--ds-gray-300)',
          backgroundColor: 'transparent',
        }}
      >
        <div
          className="flex gap-1 border-b"
          style={{
            borderColor: 'var(--ds-gray-300)',
            backgroundColor: 'transparent',
          }}
        >
          <TabButton
            active={activeTab === 'conversation'}
            onClick={() => setActiveTab('conversation')}
          >
            Conversation
          </TabButton>
          <TabButton
            active={activeTab === 'json'}
            onClick={() => setActiveTab('json')}
          >
            Raw JSON
          </TabButton>
        </div>

        {activeTab === 'conversation' ? (
          <ConversationView messages={conversation} />
        ) : (
          <div className="p-3">
            {Array.isArray(args)
              ? args.map((v, i) => (
                  <div className="mt-2 first:mt-0" key={i}>
                    {JsonBlock(v)}
                  </div>
                ))
              : JsonBlock(args)}
          </div>
        )}
      </div>
    </DetailCard>
  );
}

/**
 * Context for stream click handler
 */
const StreamClickContext = createContext<
  ((streamId: string) => void) | undefined
>(undefined);

/**
 * Marker for stream reference objects that can be rendered as links
 * This is duplicated from @workflow/core/observability to avoid pulling in
 * Node.js dependencies into the client bundle.
 */
const STREAM_REF_TYPE = '__workflow_stream_ref__';

/**
 * A stream reference object that contains the stream ID and can be
 * detected in the UI to render as a clickable link
 */
interface StreamRef {
  __type: typeof STREAM_REF_TYPE;
  streamId: string;
}

/**
 * Check if a value is a StreamRef object
 *
 */
const isStreamRef = (value: unknown): value is StreamRef => {
  // TODO: This is duplicated from @workflow/core/observability, but can't be pulled
  // in client-side code because it's a Node.js dependency.
  return (
    value !== null &&
    typeof value === 'object' &&
    '__type' in value &&
    value.__type === STREAM_REF_TYPE &&
    'streamId' in value &&
    typeof value.streamId === 'string'
  );
};

/**
 * Marker for custom class instance references.
 * This is duplicated from @workflow/core/observability to avoid pulling in
 * Node.js dependencies into the client bundle.
 */
const CLASS_INSTANCE_REF_TYPE = '__workflow_class_instance_ref__';

/**
 * A class instance reference object that contains the class name and serialized data.
 * Used in o11y when a custom class instance is encountered but the class is not
 * registered for deserialization.
 */
interface ClassInstanceRef {
  __type: typeof CLASS_INSTANCE_REF_TYPE;
  className: string;
  classId: string;
  data: unknown;
}

/**
 * Check if a value is a ClassInstanceRef object
 */
const isClassInstanceRef = (value: unknown): value is ClassInstanceRef => {
  return (
    value !== null &&
    typeof value === 'object' &&
    '__type' in value &&
    value.__type === CLASS_INSTANCE_REF_TYPE &&
    'className' in value &&
    typeof value.className === 'string'
  );
};

import ColorHash from 'color-hash';

/**
 * Color hash instance configured for nice saturation and lightness.
 * Returns HSL values which we can transform for different use cases.
 */
const colorHash = new ColorHash({
  saturation: [0.5, 0.6, 0.7],
  lightness: [0.4, 0.5, 0.6],
});

/**
 * Convert HSL to CSS hsl() string
 */
const hslToString = (h: number, s: number, l: number): string => {
  return `hsl(${h}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
};

/**
 * Get consistent colors for a class ID using color-hash and HSL transformations.
 * Adjusts colors based on light/dark mode for optimal appearance.
 */
const getClassColors = (
  classId: string,
  isDark: boolean
): { header: string; body: string; text: string } => {
  const [h, s, l] = colorHash.hsl(classId);

  if (isDark) {
    // Dark mode: vibrant header, dark body, light text
    return {
      header: hslToString(h, s, Math.min(l + 0.1, 0.6)), // Slightly brighter header
      body: hslToString(h, s * 0.8, 0.15), // Very dark, slightly desaturated body
      text: hslToString(h, s * 0.6, 0.8), // Light, slightly desaturated text
    };
  } else {
    // Light mode: vibrant header, light body, dark text
    return {
      header: hslToString(h, s, l), // Use base color for header
      body: hslToString(h, s * 0.4, 0.95), // Very light, desaturated body
      text: hslToString(h, s * 0.8, 0.25), // Dark, saturated text
    };
  }
};

/**
 * Renders a ClassInstanceRef as a styled card showing the class name and serialized data.
 * The header color is determined by hashing the classId for visual distinction.
 * Reacts to theme changes for proper dark/light mode support.
 */
const ClassInstanceRefDisplay = ({
  classInstanceRef,
}: {
  classInstanceRef: ClassInstanceRef;
}) => {
  const isDark = useDarkMode();
  const colors = getClassColors(classInstanceRef.classId, isDark);

  return (
    <div
      className="inline-flex flex-col rounded text-[11px] font-mono my-1"
      style={{
        backgroundColor: colors.body,
        border: `1px solid ${colors.header}`,
      }}
    >
      <div
        className="flex items-center gap-1.5 px-2 py-1 rounded-t"
        style={{
          backgroundColor: colors.header,
          color: '#FFFFFF',
        }}
        title={`Custom class: ${classInstanceRef.classId}`}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <title>Class instance</title>
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
          <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
          <line x1="12" y1="22.08" x2="12" y2="12" />
        </svg>
        <span className="font-semibold">{classInstanceRef.className}</span>
      </div>
      <pre
        className="px-2 py-1.5 overflow-x-auto whitespace-pre-wrap"
        style={{ color: colors.text }}
      >
        {JSON.stringify(classInstanceRef.data, null, 2)}
      </pre>
    </div>
  );
};

/**
 * Renders a StreamRef as a styled link/badge
 */
const StreamRefDisplay = ({ streamRef }: { streamRef: StreamRef }) => {
  const onStreamClick = useContext(StreamClickContext);

  const handleClick = () => {
    if (onStreamClick) {
      onStreamClick(streamRef.streamId);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono cursor-pointer hover:opacity-80 transition-opacity"
      style={{
        backgroundColor: 'var(--ds-blue-200)',
        color: 'var(--ds-blue-900)',
        border: '1px solid var(--ds-blue-400)',
      }}
      title={`Click to view stream: ${streamRef.streamId}`}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <title>Stream icon</title>
        <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
      {streamRef.streamId.length > 40
        ? `${streamRef.streamId.slice(0, 20)}...${streamRef.streamId.slice(
            -15
          )}`
        : streamRef.streamId}
    </button>
  );
};

/**
 * Recursively transforms a value for JSON display, replacing StreamRef and
 * ClassInstanceRef objects with placeholder strings that can be identified
 * and replaced with React elements.
 */
const transformValueForDisplay = (
  value: unknown
): {
  json: string;
  streamRefs: Map<string, StreamRef>;
  classInstanceRefs: Map<string, ClassInstanceRef>;
} => {
  const streamRefs = new Map<string, StreamRef>();
  const classInstanceRefs = new Map<string, ClassInstanceRef>();
  let counter = 0;

  const transform = (v: unknown): unknown => {
    if (isStreamRef(v)) {
      const placeholder = `__STREAM_REF_${counter++}__`;
      streamRefs.set(placeholder, v);
      return placeholder;
    }
    if (isClassInstanceRef(v)) {
      const placeholder = `__CLASS_INSTANCE_REF_${counter++}__`;
      classInstanceRefs.set(placeholder, v);
      return placeholder;
    }
    if (Array.isArray(v)) {
      return v.map(transform);
    }
    if (v !== null && typeof v === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(v)) {
        result[key] = transform(val);
      }
      return result;
    }
    return v;
  };

  const transformed = transform(value);
  return {
    json: JSON.stringify(transformed, null, 2),
    streamRefs,
    classInstanceRefs,
  };
};

const JsonBlock = (value: unknown) => {
  const { json, streamRefs, classInstanceRefs } =
    transformValueForDisplay(value);

  // If no special refs, just render plain JSON
  if (streamRefs.size === 0 && classInstanceRefs.size === 0) {
    return (
      <pre
        className="text-[11px] overflow-x-auto rounded-md border p-3"
        style={{
          borderColor: 'var(--ds-gray-300)',
          backgroundColor: 'var(--ds-gray-100)',
          color: 'var(--ds-gray-1000)',
        }}
      >
        <code>{json}</code>
      </pre>
    );
  }

  // Build a combined map of all placeholders to their React elements
  const placeholderComponents = new Map<string, ReactNode>();
  let keyIndex = 0;

  for (const [placeholder, streamRef] of streamRefs) {
    placeholderComponents.set(
      placeholder,
      <StreamRefDisplay key={keyIndex++} streamRef={streamRef} />
    );
  }

  for (const [placeholder, classInstanceRef] of classInstanceRefs) {
    placeholderComponents.set(
      placeholder,
      <ClassInstanceRefDisplay
        key={keyIndex++}
        classInstanceRef={classInstanceRef}
      />
    );
  }

  // Split the JSON by all placeholders and render with React elements
  const parts: ReactNode[] = [];
  let remaining = json;

  // Process placeholders in order of their appearance in the string
  while (remaining.length > 0) {
    let earliestIndex = -1;
    let earliestPlaceholder = '';
    let earliestComponent: ReactNode = null;

    // Find the earliest placeholder in the remaining string
    for (const [placeholder, component] of placeholderComponents) {
      const index = remaining.indexOf(`"${placeholder}"`);
      if (index !== -1 && (earliestIndex === -1 || index < earliestIndex)) {
        earliestIndex = index;
        earliestPlaceholder = placeholder;
        earliestComponent = component;
      }
    }

    if (earliestIndex === -1) {
      // No more placeholders found, add the rest
      parts.push(remaining);
      break;
    }

    // Add text before the placeholder
    if (earliestIndex > 0) {
      parts.push(remaining.slice(0, earliestIndex));
    }

    // Add the component
    parts.push(earliestComponent);

    // Move past the placeholder
    remaining = remaining.slice(earliestIndex + earliestPlaceholder.length + 2); // +2 for quotes
  }

  return (
    <pre
      className="text-[11px] overflow-x-auto rounded-md border p-3"
      style={{
        borderColor: 'var(--ds-gray-300)',
        backgroundColor: 'var(--ds-gray-100)',
        color: 'var(--ds-gray-1000)',
      }}
    >
      <code>{parts}</code>
    </pre>
  );
};

type AttributeKey =
  | keyof Step
  | keyof WorkflowRun
  | keyof Hook
  | keyof Event
  | 'eventData'
  | 'resumeAt'
  | 'expiredAt';

const attributeOrder: AttributeKey[] = [
  'workflowName',
  'stepName',
  'status',
  'stepId',
  'hookId',
  'eventId',
  'runId',
  'attempt',
  'token',
  'correlationId',
  'eventType',
  'deploymentId',
  'specVersion',
  'ownerId',
  'projectId',
  'environment',
  'executionContext',
  'createdAt',
  'startedAt',
  'updatedAt',
  'completedAt',
  'expiredAt',
  'retryAfter',
  'error',
  'metadata',
  'eventData',
  'input',
  'output',
  'resumeAt',
];

const sortByAttributeOrder = (a: string, b: string): number => {
  const aIndex = attributeOrder.indexOf(a as AttributeKey) || 0;
  const bIndex = attributeOrder.indexOf(b as AttributeKey) || 0;
  return aIndex - bIndex;
};

export const localMillisecondTime = (value: unknown): string => {
  let date: Date;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === 'number') {
    date = new Date(value);
  } else if (typeof value === 'string') {
    date = new Date(value);
  } else {
    date = new Date(String(value));
  }

  // e.g. 12/17/2025, 9:08:55.182 AM
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    fractionalSecondDigits: 3,
  });
};

interface DisplayContext {
  stepName?: string;
}

const attributeToDisplayFn: Record<
  AttributeKey,
  (value: unknown, context?: DisplayContext) => null | string | ReactNode
> = {
  // Names that need pretty-printing
  workflowName: (value: unknown) =>
    parseWorkflowName(String(value))?.shortName ?? '?',
  stepName: (value: unknown) => parseStepName(String(value))?.shortName ?? '?',
  // IDs
  runId: (value: unknown) => String(value),
  stepId: (value: unknown) => String(value),
  hookId: (value: unknown) => String(value),
  eventId: (value: unknown) => String(value),
  // Run/step details
  status: (value: unknown) => String(value),
  attempt: (value: unknown) => String(value),
  // Hook details
  token: (value: unknown) => String(value),
  // Event details
  eventType: (value: unknown) => String(value),
  correlationId: (value: unknown) => String(value),
  // Project details
  deploymentId: (value: unknown) => String(value),
  specVersion: (value: unknown) => String(value),
  // Tenancy (we don't show these)
  ownerId: (_value: unknown) => null,
  projectId: (_value: unknown) => null,
  environment: (_value: unknown) => null,
  executionContext: (_value: unknown) => null,
  // Dates
  // TODO: relative time with tooltips for ISO times
  createdAt: localMillisecondTime,
  startedAt: localMillisecondTime,
  updatedAt: localMillisecondTime,
  completedAt: localMillisecondTime,
  expiredAt: localMillisecondTime,
  retryAfter: localMillisecondTime,
  resumeAt: localMillisecondTime,
  // Resolved attributes, won't actually use this function
  metadata: JsonBlock,
  input: (value: unknown, context?: DisplayContext) => {
    // Check if input has args + closure vars structure
    if (value && typeof value === 'object' && 'args' in value) {
      const { args, closureVars } = value as {
        args: unknown[];
        closureVars?: Record<string, unknown>;
      };
      const argCount = Array.isArray(args) ? args.length : 0;
      const hasClosureVars = closureVars && Object.keys(closureVars).length > 0;

      // Check if this is a doStreamStep - show conversation view with tabs
      if (context?.stepName && isDoStreamStep(context.stepName)) {
        const conversation = extractConversation(args);
        if (conversation && conversation.length > 0) {
          return (
            <>
              <ConversationWithTabs conversation={conversation} args={args} />
              {hasClosureVars && (
                <DetailCard summary="Closure Variables">
                  {JsonBlock(closureVars)}
                </DetailCard>
              )}
            </>
          );
        }
      }

      return (
        <>
          <DetailCard summary={`Input (${argCount} arguments)`}>
            {Array.isArray(args)
              ? args.map((v, i) => (
                  <div className="mt-2" key={i}>
                    {JsonBlock(v)}
                  </div>
                ))
              : JsonBlock(args)}
          </DetailCard>
          {hasClosureVars && (
            <DetailCard summary="Closure Variables">
              {JsonBlock(closureVars)}
            </DetailCard>
          )}
        </>
      );
    }

    // Fallback: treat as plain array or object
    const argCount = Array.isArray(value) ? value.length : 0;
    return (
      <DetailCard summary={`Input (${argCount} arguments)`}>
        {Array.isArray(value)
          ? value.map((v, i) => (
              <div className="mt-2" key={i}>
                {JsonBlock(v)}
              </div>
            ))
          : JsonBlock(value)}
      </DetailCard>
    );
  },
  output: (value: unknown) => {
    return <DetailCard summary="Output">{JsonBlock(value)}</DetailCard>;
  },
  error: (value: unknown) => {
    // Handle structured error format
    if (value && typeof value === 'object' && 'message' in value) {
      const error = value as {
        message: string;
        stack?: string;
        code?: string;
      };

      return (
        <DetailCard summary="Error">
          <div className="flex flex-col gap-2">
            {/* Show code if it exists */}
            {error.code && (
              <div>
                <span
                  className="text-[11px] font-medium"
                  style={{ color: 'var(--ds-gray-700)' }}
                >
                  Error Code:{' '}
                </span>
                <code
                  className="text-[11px]"
                  style={{ color: 'var(--ds-gray-1000)' }}
                >
                  {error.code}
                </code>
              </div>
            )}
            {/* Show stack if available, otherwise just the message */}
            <pre
              className="text-[11px] overflow-x-auto rounded-md border p-3"
              style={{
                borderColor: 'var(--ds-gray-300)',
                backgroundColor: 'var(--ds-gray-100)',
                color: 'var(--ds-gray-1000)',
                whiteSpace: 'pre-wrap',
              }}
            >
              <code>{error.stack || error.message}</code>
            </pre>
          </div>
        </DetailCard>
      );
    }

    // Fallback for plain string errors
    return (
      <DetailCard summary="Error">
        <pre
          className="text-[11px] overflow-x-auto rounded-md border p-3"
          style={{
            borderColor: 'var(--ds-gray-300)',
            backgroundColor: 'var(--ds-gray-100)',
            color: 'var(--ds-gray-1000)',
            whiteSpace: 'pre-wrap',
          }}
        >
          <code>{String(value)}</code>
        </pre>
      </DetailCard>
    );
  },
  eventData: (value: unknown) => {
    return <DetailCard summary="Event Data">{JsonBlock(value)}</DetailCard>;
  },
};

const resolvableAttributes = [
  'input',
  'output',
  'error',
  'metadata',
  'eventData',
];

const ExpiredDataMessage = () => (
  <div
    className="text-copy-12 rounded-md border p-4 my-2"
    style={{
      borderColor: 'var(--ds-gray-300)',
      backgroundColor: 'var(--ds-gray-100)',
      color: 'var(--ds-gray-700)',
    }}
  >
    <span>The data for this run has expired and is no longer available.</span>
  </div>
);

export const AttributeBlock = ({
  attribute,
  value,
  isLoading,
  inline = false,
  context,
}: {
  attribute: string;
  value: unknown;
  isLoading?: boolean;
  inline?: boolean;
  context?: DisplayContext;
}) => {
  const displayFn =
    attributeToDisplayFn[attribute as keyof typeof attributeToDisplayFn];
  if (!displayFn) {
    return null;
  }
  const displayValue = displayFn(value, context);
  if (!displayValue) {
    return null;
  }

  if (inline) {
    return (
      <div className="flex items-center gap-1.5">
        <span
          className="text-[11px] font-medium"
          style={{ color: 'var(--ds-gray-700)' }}
        >
          {attribute}
        </span>
        <span className="text-[11px]" style={{ color: 'var(--ds-gray-1000)' }}>
          {displayValue}
        </span>
      </div>
    );
  }

  return (
    <div className="relative">
      {typeof isLoading === 'boolean' && isLoading && (
        <div className="absolute top-9 right-4">
          <div
            className="animate-spin rounded-full h-4 w-4 border-b-2"
            style={{ borderColor: 'var(--ds-gray-900)' }}
          />
        </div>
      )}
      <div key={attribute} className="flex flex-col gap-0 my-2">
        <span
          className="text-xs font-medium"
          style={{ color: 'var(--ds-gray-700)' }}
        >
          {attribute}
        </span>
        <span className="text-xs" style={{ color: 'var(--ds-gray-1000)' }}>
          {displayValue}
        </span>
      </div>
    </div>
  );
};

export const AttributePanel = ({
  data,
  isLoading,
  error,
  expiredAt,
  onStreamClick,
}: {
  data: Record<string, unknown>;
  isLoading?: boolean;
  error?: Error;
  expiredAt?: string | Date;
  /** Callback when a stream reference is clicked */
  onStreamClick?: (streamId: string) => void;
}) => {
  const displayData = data;
  const hasExpired = expiredAt != null && new Date(expiredAt) < new Date();
  const basicAttributes = Object.keys(displayData)
    .filter((key) => !resolvableAttributes.includes(key))
    .sort(sortByAttributeOrder);
  const resolvedAttributes = Object.keys(displayData)
    .filter((key) => resolvableAttributes.includes(key))
    .sort(sortByAttributeOrder);

  // Filter out attributes that return null
  const visibleBasicAttributes = basicAttributes.filter((attribute) => {
    const displayFn =
      attributeToDisplayFn[attribute as keyof typeof attributeToDisplayFn];
    if (!displayFn) return false;
    const displayValue = displayFn(
      displayData[attribute as keyof typeof displayData]
    );
    return displayValue !== null;
  });

  // Memoize context object to avoid object reconstruction on render
  const displayContext = useMemo(
    () => ({
      stepName: displayData.stepName as string | undefined,
    }),
    [displayData.stepName]
  );

  return (
    <StreamClickContext.Provider value={onStreamClick}>
      <div>
        {/* Basic attributes in a vertical layout with border */}
        {visibleBasicAttributes.length > 0 && (
          <div
            className="flex flex-col divide-y rounded-lg border mb-3 overflow-hidden"
            style={{
              borderColor: 'var(--ds-gray-300)',
              backgroundColor: 'var(--ds-gray-100)',
            }}
          >
            {visibleBasicAttributes.map((attribute) => (
              <div
                key={attribute}
                className="flex items-center justify-between px-3 py-1.5"
                style={{
                  borderColor: 'var(--ds-gray-300)',
                }}
              >
                <span
                  className="text-[11px] font-medium"
                  style={{ color: 'var(--ds-gray-700)' }}
                >
                  {attribute}
                </span>
                <span
                  className="text-[11px] font-mono"
                  style={{ color: 'var(--ds-gray-1000)' }}
                >
                  {attributeToDisplayFn[
                    attribute as keyof typeof attributeToDisplayFn
                  ]?.(displayData[attribute as keyof typeof displayData])}
                </span>
              </div>
            ))}
          </div>
        )}
        {error ? (
          <ErrorCard
            title="Failed to load resource details"
            details={error.message}
            className="my-4"
          />
        ) : hasExpired ? (
          <ExpiredDataMessage />
        ) : (
          resolvedAttributes.map((attribute) => (
            <AttributeBlock
              isLoading={isLoading}
              key={attribute}
              attribute={attribute}
              value={displayData[attribute as keyof typeof displayData]}
              context={displayContext}
            />
          ))
        )}
      </div>
    </StreamClickContext.Provider>
  );
};
