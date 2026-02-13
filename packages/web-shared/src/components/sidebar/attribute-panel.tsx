'use client';

import { parseStepName, parseWorkflowName } from '@workflow/utils/parse-name';
import type { Event, Hook, Step, WorkflowRun } from '@workflow/world';
import type { ModelMessage } from 'ai';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { extractConversation, isDoStreamStep } from '../../lib/utils';
import { DataInspector, StreamClickContext } from '../ui/data-inspector';
import { ErrorCard } from '../ui/error-card';
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
 * Render a value with the shared DataInspector (ObjectInspector with
 * custom theming, nodeRenderer for StreamRef/ClassInstanceRef, etc.)
 */
function JsonBlock(value: unknown) {
  return (
    <div
      className="overflow-x-auto rounded-md border p-3"
      style={{ borderColor: 'var(--ds-gray-300)' }}
    >
      <DataInspector data={value} />
    </div>
  );
}

type AttributeKey =
  | keyof Step
  | keyof WorkflowRun
  | keyof Hook
  | keyof Event
  | 'eventData'
  | 'resumeAt'
  | 'expiredAt'
  | 'workflowCoreVersion';

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
  'workflowCoreVersion',
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

/**
 * Display names for attributes that should render differently from their key.
 */
const attributeDisplayNames: Partial<Record<AttributeKey, string>> = {
  workflowCoreVersion: '@workflow/core version',
};

/**
 * Get the display name for an attribute key.
 */
const getAttributeDisplayName = (attribute: string): string => {
  return attributeDisplayNames[attribute as AttributeKey] ?? attribute;
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
  workflowCoreVersion: (value: unknown) => String(value),
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
  // Extract workflowCoreVersion from executionContext for display
  const displayData = useMemo(() => {
    const result = { ...data };
    const execCtx = data.executionContext as
      | Record<string, unknown>
      | undefined;
    if (execCtx?.workflowCoreVersion) {
      result.workflowCoreVersion = execCtx.workflowCoreVersion;
    }
    return result;
  }, [data]);
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
                  {getAttributeDisplayName(attribute)}
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
