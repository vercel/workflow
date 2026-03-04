'use client';

import { parseStepName, parseWorkflowName } from '@workflow/utils/parse-name';
import type { Event, Hook, Step, WorkflowRun } from '@workflow/world';
import type { ModelMessage } from 'ai';
import { Lock } from 'lucide-react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { isEncryptedMarker } from '../../lib/hydration';
import { extractConversation, isDoStreamStep } from '../../lib/utils';
import { StreamClickContext } from '../ui/data-inspector';
import { ErrorCard } from '../ui/error-card';
import {
  ErrorStackBlock,
  isStructuredErrorWithStack,
} from '../ui/error-stack-block';
import { Skeleton } from '../ui/skeleton';
import { ConversationView } from './conversation-view';
import { CopyableDataBlock } from './copyable-data-block';
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
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
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
 * Shared tabbed container with accessible ARIA roles and keyboard navigation.
 * Used by ConversationWithTabs for the conversation/JSON toggle.
 */
function TabbedContainer<T extends string>({
  tabs,
  activeTab,
  onTabChange,
  ariaLabel,
  children,
}: {
  tabs: { id: T; label: string }[];
  activeTab: T;
  onTabChange: (tab: T) => void;
  ariaLabel: string;
  children: ReactNode;
}) {
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      event.preventDefault();
      const currentIndex = tabs.findIndex((t) => t.id === activeTab);
      const nextIndex =
        event.key === 'ArrowRight'
          ? (currentIndex + 1) % tabs.length
          : (currentIndex - 1 + tabs.length) % tabs.length;
      onTabChange(tabs[nextIndex].id);
    },
    [tabs, activeTab, onTabChange]
  );

  return (
    <div
      className="rounded-md border"
      style={{
        borderColor: 'var(--ds-gray-300)',
        backgroundColor: 'transparent',
      }}
    >
      <div
        className="flex gap-1 border-b"
        role="tablist"
        aria-label={ariaLabel}
        onKeyDown={handleKeyDown}
        style={{
          borderColor: 'var(--ds-gray-300)',
          backgroundColor: 'transparent',
        }}
      >
        {tabs.map((tab) => (
          <TabButton
            key={tab.id}
            active={activeTab === tab.id}
            onClick={() => onTabChange(tab.id)}
          >
            {tab.label}
          </TabButton>
        ))}
      </div>

      <div role="tabpanel">{children}</div>
    </div>
  );
}

const conversationTabs = [
  { id: 'conversation' as const, label: 'Conversation' },
  { id: 'json' as const, label: 'Raw JSON' },
];

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
      <TabbedContainer
        tabs={conversationTabs}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        ariaLabel="Conversation view"
      >
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
      </TabbedContainer>
    </DetailCard>
  );
}

/**
 * Render a value with the shared DataInspector (ObjectInspector with
 * custom theming, nodeRenderer for StreamRef/ClassInstanceRef, etc.)
 */
/**
 * Inline display for an encrypted field — no expand, just a flat label
 * with the lucide Lock icon matching the title bar Decrypt button.
 */
function EncryptedFieldBlock() {
  return (
    <div
      className="flex items-center gap-1.5 rounded-md border px-3 py-2 text-xs"
      style={{
        borderColor: 'var(--ds-gray-300)',
        backgroundColor: 'var(--ds-gray-100)',
        color: 'var(--ds-gray-700)',
      }}
    >
      <Lock className="h-3 w-3" />
      <span className="font-medium">Encrypted</span>
    </div>
  );
}

function JsonBlock(value: unknown) {
  return <CopyableDataBlock data={value} />;
}

const hasDisplayContent = (value: unknown): boolean => {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
};

type AttributeKey =
  | keyof Step
  | keyof WorkflowRun
  | keyof Hook
  | keyof Event
  | 'moduleSpecifier'
  | 'eventData'
  | 'resumeAt'
  | 'expiredAt'
  | 'workflowCoreVersion';

const attributeOrder: AttributeKey[] = [
  'workflowName',
  'moduleSpecifier',
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

const getModuleSpecifierFromName = (value: unknown): string => {
  const raw = String(value);
  const parsedStep = parseStepName(raw);
  if (parsedStep) {
    return parsedStep.moduleSpecifier;
  }
  const parsedWorkflow = parseWorkflowName(raw);
  if (parsedWorkflow) {
    return parsedWorkflow.moduleSpecifier;
  }
  return raw;
};

const parseDateValue = (value: unknown): Date | null => {
  if (value == null) {
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'string' && value.trim().length === 0) {
    return null;
  }

  const date =
    typeof value === 'number' ? new Date(value) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
};

const formatLocalMillisecondTime = (date: Date): string =>
  date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    fractionalSecondDigits: 3,
  });

export const localMillisecondTime = (value: unknown): string => {
  const date = parseDateValue(value);
  if (!date) {
    return '-';
  }

  // e.g. 12/17/2025, 9:08:55.182 AM
  return formatLocalMillisecondTime(date);
};

const localMillisecondTimeOrNull = (value: unknown): string | null => {
  const date = parseDateValue(value);
  if (!date) {
    return null;
  }
  return formatLocalMillisecondTime(date);
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
  moduleSpecifier: (value: unknown) => getModuleSpecifierFromName(value),
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
  createdAt: localMillisecondTimeOrNull,
  startedAt: localMillisecondTimeOrNull,
  updatedAt: localMillisecondTimeOrNull,
  completedAt: localMillisecondTimeOrNull,
  expiredAt: localMillisecondTimeOrNull,
  retryAfter: localMillisecondTimeOrNull,
  resumeAt: localMillisecondTimeOrNull,
  // Resolved attributes, won't actually use this function
  metadata: (value: unknown) => {
    if (!hasDisplayContent(value)) return null;
    if (isEncryptedMarker(value)) return <EncryptedFieldBlock />;
    return JsonBlock(value);
  },
  input: (value: unknown, context?: DisplayContext) => {
    if (isEncryptedMarker(value)) return <EncryptedFieldBlock />;
    // Check if input has args + closure vars structure
    if (value && typeof value === 'object' && 'args' in value) {
      const { args, closureVars, thisVal } = value as {
        args: unknown[];
        closureVars?: Record<string, unknown>;
        thisVal?: unknown;
      };
      const argCount = Array.isArray(args) ? args.length : 0;
      const argLabel = argCount === 1 ? 'argument' : 'arguments';
      const hasClosureVars = hasDisplayContent(closureVars);
      const hasThisVal = hasDisplayContent(thisVal);
      const hasArgs = hasDisplayContent(args);

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
              {hasThisVal && (
                <DetailCard summary="This Value">
                  {JsonBlock(thisVal)}
                </DetailCard>
              )}
            </>
          );
        }
      }

      // Don't render an empty "Input (0 arguments)" card when no input exists.
      if (!hasArgs && !hasClosureVars && !hasThisVal) {
        return (
          <DetailCard
            summary="Input (no data)"
            disabled
            summaryClassName="text-base py-2"
          />
        );
      }

      return (
        <>
          <DetailCard
            summary={`Input (${argCount} ${argLabel})`}
            summaryClassName="text-base py-2"
            contentClassName="mt-0"
          >
            {Array.isArray(args)
              ? args.map((v, i) => (
                  <div className="mt-2 first:mt-0" key={i}>
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
          {hasThisVal && (
            <DetailCard summary="this">{JsonBlock(thisVal)}</DetailCard>
          )}
        </>
      );
    }

    // Fallback: treat as plain array or object
    const argCount = Array.isArray(value) ? value.length : 0;
    const argLabel = argCount === 1 ? 'argument' : 'arguments';
    if (!hasDisplayContent(value)) {
      return (
        <DetailCard
          summary="Input (no data)"
          disabled
          summaryClassName="text-base py-2"
        />
      );
    }
    return (
      <DetailCard
        summary={`Input (${argCount} ${argLabel})`}
        summaryClassName="text-base py-2"
        contentClassName="mt-0"
      >
        {Array.isArray(value)
          ? value.map((v, i) => (
              <div className="mt-2 first:mt-0" key={i}>
                {JsonBlock(v)}
              </div>
            ))
          : JsonBlock(value)}
      </DetailCard>
    );
  },
  output: (value: unknown) => {
    if (!hasDisplayContent(value)) return null;
    if (isEncryptedMarker(value)) return <EncryptedFieldBlock />;
    return (
      <DetailCard
        summary="Output"
        summaryClassName="text-base py-2"
        contentClassName="mt-0"
      >
        {JsonBlock(value)}
      </DetailCard>
    );
  },
  error: (value: unknown) => {
    if (isEncryptedMarker(value)) return <EncryptedFieldBlock />;
    if (!hasDisplayContent(value)) return null;

    // If the error object has a `stack` field, render it as readable
    // pre-formatted text. Otherwise fall back to the raw JSON viewer.
    if (isStructuredErrorWithStack(value)) {
      return (
        <DetailCard
          summary="Error"
          summaryClassName="text-base py-2"
          contentClassName="mt-0"
        >
          <ErrorStackBlock value={value} />
        </DetailCard>
      );
    }

    return (
      <DetailCard
        summary="Error"
        summaryClassName="text-base py-2"
        contentClassName="mt-0"
      >
        {JsonBlock(value)}
      </DetailCard>
    );
  },
  eventData: (value: unknown) => {
    if (isEncryptedMarker(value)) return <EncryptedFieldBlock />;
    if (!hasDisplayContent(value)) return null;
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
  const isExpandableLoadingTarget =
    attribute === 'input' ||
    attribute === 'output' ||
    attribute === 'eventData';
  if (isLoading && isExpandableLoadingTarget) {
    const label =
      attribute === 'eventData'
        ? 'Event Data'
        : attribute === 'output'
          ? 'Output'
          : 'Input';
    return (
      <div
        className={`my-2 flex flex-col ${attribute === 'input' || attribute === 'output' ? 'gap-2 my-3.5' : 'gap-0'}`}
      >
        <span
          className={`${attribute === 'input' || attribute === 'output' ? 'text-base' : 'text-xs'} font-medium first-letter:uppercase`}
          style={{ color: 'var(--ds-gray-700)' }}
        >
          {attribute}
        </span>
        <DetailCard
          summary={label}
          summaryClassName="text-base py-2"
          disabled
        />
        <div
          className="overflow-x-auto rounded-md border p-3"
          style={{ borderColor: 'var(--ds-gray-300)' }}
        >
          <Skeleton className="h-4 w-[38%]" />
          <Skeleton className="mt-2 h-4 w-[88%]" />
          <Skeleton className="mt-2 h-4 w-[72%]" />
        </div>
      </div>
    );
  }

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
      <div
        key={attribute}
        className={`my-2 flex flex-col ${attribute === 'input' || attribute === 'output' || attribute === 'error' ? 'gap-2 my-3.5' : 'gap-0'}`}
      >
        <span
          className={`${attribute === 'input' || attribute === 'output' || attribute === 'error' ? 'text-base' : 'text-xs'} font-medium first-letter:uppercase`}
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
  moduleSpecifier,
  isLoading,
  error,
  expiredAt,
  onStreamClick,
}: {
  data: Record<string, unknown>;
  moduleSpecifier?: string;
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
    if (moduleSpecifier) {
      result.moduleSpecifier = moduleSpecifier;
    } else if (typeof data.stepName === 'string') {
      result.moduleSpecifier = data.stepName;
    } else if (typeof data.workflowName === 'string') {
      result.moduleSpecifier = data.workflowName;
    }
    return result;
  }, [data, moduleSpecifier]);
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

  // Keep `moduleSpecifier` immediately after `workflowName` or `stepName`.
  const orderedBasicAttributes = useMemo(() => {
    const attributes = [...visibleBasicAttributes];
    const moduleSpecifierIndex = attributes.indexOf('moduleSpecifier');
    if (moduleSpecifierIndex === -1) {
      return attributes;
    }

    attributes.splice(moduleSpecifierIndex, 1);
    const workflowNameIndex = attributes.indexOf('workflowName');
    if (workflowNameIndex !== -1) {
      attributes.splice(workflowNameIndex + 1, 0, 'moduleSpecifier');
      return attributes;
    }

    const stepNameIndex = attributes.indexOf('stepName');
    if (stepNameIndex !== -1) {
      attributes.splice(stepNameIndex + 1, 0, 'moduleSpecifier');
      return attributes;
    }

    attributes.unshift('moduleSpecifier');
    return attributes;
  }, [visibleBasicAttributes]);

  // Memoize context object to avoid object reconstruction on render
  const displayContext = useMemo(
    () => ({
      stepName: displayData.stepName as string | undefined,
    }),
    [displayData.stepName]
  );
  const handleCopyModuleSpecifier = useCallback((value: string) => {
    navigator.clipboard
      .writeText(value)
      .then(() => {
        toast.success('moduleSpecifier copied');
      })
      .catch(() => {
        toast.error('Failed to copy moduleSpecifier');
      });
  }, []);

  return (
    <StreamClickContext.Provider value={onStreamClick}>
      <div>
        {/* Basic attributes in a vertical layout with border */}
        {visibleBasicAttributes.length > 0 && (
          <div
            className="mb-3 flex flex-col overflow-hidden rounded-lg border"
            style={{
              borderColor: 'var(--ds-gray-300)',
            }}
          >
            {orderedBasicAttributes.map((attribute, index) => {
              const displayValue = attributeToDisplayFn[
                attribute as keyof typeof attributeToDisplayFn
              ]?.(displayData[attribute as keyof typeof displayData]);
              const isModuleSpecifier = attribute === 'moduleSpecifier';
              const moduleSpecifierValue =
                typeof displayValue === 'string'
                  ? displayValue
                  : String(displayValue ?? displayData.moduleSpecifier ?? '');
              const showDivider = index < orderedBasicAttributes.length - 1;

              return (
                <div key={attribute} className="py-1">
                  <div className="flex min-h-[32px] items-center justify-between gap-4 rounded-sm px-2.5 py-1">
                    <span
                      className="text-[14px] first-letter:uppercase"
                      style={{ color: 'var(--ds-gray-700)' }}
                    >
                      {getAttributeDisplayName(attribute)}
                    </span>
                    {isModuleSpecifier ? (
                      <button
                        type="button"
                        className="min-w-0 max-w-[70%] truncate text-right text-[13px] font-mono"
                        style={{
                          color: 'var(--ds-gray-1000)',
                          background: 'transparent',
                          border: 'none',
                          padding: 0,
                        }}
                        title={moduleSpecifierValue}
                        onClick={() =>
                          handleCopyModuleSpecifier(moduleSpecifierValue)
                        }
                      >
                        {moduleSpecifierValue}
                      </button>
                    ) : (
                      <span
                        className="min-w-0 max-w-[70%] truncate text-right text-[13px] font-mono"
                        style={{ color: 'var(--ds-gray-1000)' }}
                      >
                        {displayValue}
                      </span>
                    )}
                  </div>
                  {showDivider ? (
                    <div
                      className="mx-2.5 border-b"
                      style={{ borderColor: 'var(--ds-gray-300)' }}
                    />
                  ) : null}
                </div>
              );
            })}
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
          <>
            {resolvedAttributes.map((attribute) => (
              <AttributeBlock
                isLoading={isLoading}
                key={attribute}
                attribute={attribute}
                value={displayData[attribute as keyof typeof displayData]}
                context={displayContext}
              />
            ))}
          </>
        )}
      </div>
    </StreamClickContext.Provider>
  );
};
