'use client';

import { parseStepName, parseWorkflowName } from '@workflow/core/parse-name';
import type { Event, Hook, Step, WorkflowRun } from '@workflow/world';
import type { ModelMessage } from 'ai';
import { AlertCircle } from 'lucide-react';
import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from 'react';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { extractConversation, isDoStreamStep } from '../lib/utils';
import { ConversationView } from './conversation-view';
import { DetailCard } from './detail-card';

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
        style={{ borderColor: 'var(--ds-gray-300)' }}
      >
        {/* Tab buttons */}
        <div
          className="flex gap-1 border-b"
          style={{ borderColor: 'var(--ds-gray-300)' }}
        >
          <button
            type="button"
            onClick={() => setActiveTab('conversation')}
            className="px-3 py-1.5 text-[11px] font-medium transition-colors"
            style={{
              color:
                activeTab === 'conversation'
                  ? 'var(--ds-gray-1000)'
                  : 'var(--ds-gray-600)',
              borderBottom:
                activeTab === 'conversation'
                  ? '2px solid var(--ds-blue-600)'
                  : '2px solid transparent',
              marginBottom: '-1px',
            }}
          >
            Conversation
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('json')}
            className="px-3 py-1.5 text-[11px] font-medium transition-colors"
            style={{
              color:
                activeTab === 'json'
                  ? 'var(--ds-gray-1000)'
                  : 'var(--ds-gray-600)',
              borderBottom:
                activeTab === 'json'
                  ? '2px solid var(--ds-blue-600)'
                  : '2px solid transparent',
              marginBottom: '-1px',
            }}
          >
            Raw JSON
          </button>
        </div>

        {/* Tab content */}
        {activeTab === 'conversation' ? (
          <ConversationView messages={conversation} />
        ) : (
          <div className="p-3 max-h-[400px] overflow-y-auto">
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
        ? `${streamRef.streamId.slice(0, 20)}...${streamRef.streamId.slice(-15)}`
        : streamRef.streamId}
    </button>
  );
};

/**
 * Recursively transforms a value for JSON display, replacing StreamRef objects
 * with placeholder strings that can be identified and replaced with React elements
 */
const transformValueForDisplay = (
  value: unknown
): { json: string; streamRefs: Map<string, StreamRef> } => {
  const streamRefs = new Map<string, StreamRef>();
  let counter = 0;

  const transform = (v: unknown): unknown => {
    if (isStreamRef(v)) {
      const placeholder = `__STREAM_REF_${counter++}__`;
      streamRefs.set(placeholder, v);
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
  };
};

const JsonBlock = (value: unknown) => {
  const { json, streamRefs } = transformValueForDisplay(value);

  // If no stream refs, just render plain JSON
  if (streamRefs.size === 0) {
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

  // Split the JSON by stream ref placeholders and render with React elements
  const parts: ReactNode[] = [];
  let remaining = json;
  let keyIndex = 0;

  for (const [placeholder, streamRef] of streamRefs) {
    const index = remaining.indexOf(`"${placeholder}"`);
    if (index !== -1) {
      // Add text before the placeholder
      if (index > 0) {
        parts.push(remaining.slice(0, index));
      }
      // Add the StreamRef component
      parts.push(<StreamRefDisplay key={keyIndex++} streamRef={streamRef} />);
      remaining = remaining.slice(index + placeholder.length + 2); // +2 for quotes
    }
  }

  // Add any remaining text
  if (remaining) {
    parts.push(remaining);
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
          <Alert variant="destructive" className="my-4">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Failed to load resource details</AlertTitle>
            <AlertDescription className="text-sm">
              {error.message}
            </AlertDescription>
          </Alert>
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
