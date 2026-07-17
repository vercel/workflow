'use client';

import { parseStepName, parseWorkflowName } from '@workflow/utils/parse-name';
import type { Event, Hook, Step, WorkflowRun } from '@workflow/world';
import type { ModelMessage } from 'ai';
import { format } from 'date-fns';
import type { KeyboardEvent, ReactNode } from 'react';
import { useCallback, useContext, useMemo, useRef, useState } from 'react';
import { isEncryptedMarker, isExpiredMarker } from '../../lib/hydration';
import { extractConversation, isDoStreamStep } from '../../lib/utils';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleRoot,
  CollapsibleTrigger,
} from '../ui/collapsible';
import { ContextCardProvider } from '../ui/context-card';
import {
  DecryptClickContext,
  RunClickContext,
  StreamClickContext,
} from '../ui/data-inspector';
import { ErrorCard } from '../ui/error-card';
import { ErrorStackBlock, isStructuredError } from '../ui/error-stack-block';
import { Skeleton } from '../ui/skeleton';
import { TimestampTooltip } from '../ui/timestamp-tooltip';
import {
  DetailMonoKeyValueRow,
  RunAttributesCard,
  RunMetadataCard,
} from './attributes-block';
import { ConversationView } from './conversation-view';
import { CopyableDataBlock, EncryptedDataBlock } from './copyable-data-block';

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
  defaultOpen,
  onOpenChange,
}: {
  conversation: ModelMessage[];
  args: unknown[];
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [activeTab, setActiveTab] = useState<'conversation' | 'json'>(
    'conversation'
  );

  return (
    <Collapsible
      label="Input"
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
    >
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
    </Collapsible>
  );
}

/**
 * Render a value with the shared DataInspector (ObjectInspector with
 * custom theming, nodeRenderer for StreamRef/ClassInstanceRef, etc.)
 */
function EncryptedFieldBlock() {
  return <EncryptedDataBlock />;
}

/**
 * Inline display for an expired field — flat label indicating data is no longer available.
 */
function ExpiredFieldBlock() {
  return (
    <div
      className="flex items-center gap-1.5 rounded-md border px-3 py-2 text-xs"
      style={{
        borderColor: 'var(--ds-gray-300)',
        backgroundColor: 'var(--ds-gray-100)',
        color: 'var(--ds-gray-700)',
      }}
    >
      <span className="font-medium">Data expired</span>
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
  | 'occurredAt'
  | 'moduleSpecifier'
  | 'eventData'
  | 'resumeAt'
  | 'expiredAt'
  | 'workflowCoreVersion'
  | 'receivedCount'
  | 'lastReceivedAt'
  | 'disposedAt'
  | 'isSystem'
  | 'errorCode';

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
  'receivedCount',
  'lastReceivedAt',
  'disposedAt',
  'correlationId',
  'eventType',
  'deploymentId',
  'specVersion',
  'workflowCoreVersion',
  'ownerId',
  'projectId',
  'environment',
  'executionContext',
  'occurredAt',
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
  'attributes',
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
  moduleSpecifier: 'Module',
  workflowName: 'Workflow Name',
  stepName: 'Step Name',
  stepId: 'Step ID',
  hookId: 'Hook ID',
  attempt: 'Attempts',
  eventId: 'Event ID',
  runId: 'Run ID',
  token: 'Token',
  eventType: 'Event Type',
  errorCode: 'Error Code',
  correlationId: 'Correlation ID',
  deploymentId: 'Deployment ID',
  specVersion: 'Spec Version',
  workflowCoreVersion: '@workflow/core version',
  occurredAt: 'Occurred',
  createdAt: 'Created',
  startedAt: 'Started',
  updatedAt: 'Updated',
  completedAt: 'Completed',
  expiredAt: 'Expired',
  retryAfter: 'Retry After',
  resumeAt: 'Resume',
  lastReceivedAt: 'Last Received',
  disposedAt: 'Disposed',
  receivedCount: 'Times Resolved',
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
  format(date, 'MMM dd HH:mm:ss.SS OO').toUpperCase();

export const localMillisecondTime = (value: unknown): string => {
  const date = parseDateValue(value);
  if (!date) {
    return '-';
  }

  return formatLocalMillisecondTime(date);
};

const localMillisecondTimeOrNull = (value: unknown): string | null => {
  const date = parseDateValue(value);
  if (!date) {
    return null;
  }
  return formatLocalMillisecondTime(date);
};

const timestampWithTooltipOrNull = (value: unknown): ReactNode | null => {
  const date = parseDateValue(value);
  if (!date) return null;
  return (
    <TimestampTooltip date={date}>
      <span>{formatLocalMillisecondTime(date)}</span>
    </TimestampTooltip>
  );
};

interface DisplayContext {
  stepName?: string;
  sectionOpen?: boolean;
  onSectionOpenChange?: (open: boolean) => void;
}

const attributeToDisplayFn: Record<
  AttributeKey,
  (value: unknown, context?: DisplayContext) => null | string | ReactNode
> = {
  // Names that need pretty-printing
  workflowName: (_value: unknown) => null,
  moduleSpecifier: (value: unknown) => getModuleSpecifierFromName(value),
  stepName: (_value: unknown) => null,
  // IDs
  runId: (_value: unknown) => null,
  stepId: (value: unknown) => String(value),
  hookId: (value: unknown) => String(value),
  eventId: (value: unknown) => String(value),
  // Run/step details
  status: (_value: unknown) => null,
  attempt: (value: unknown) => String(value),
  // Hook details
  token: (value: unknown) => String(value),
  isWebhook: (value: unknown) => String(value),
  isSystem: (value: unknown) => String(value),
  receivedCount: (value: unknown) => String(value),
  lastReceivedAt: localMillisecondTimeOrNull,
  disposedAt: localMillisecondTimeOrNull,
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
  // Attributes — string-string metadata attached to the run.
  // Rendered as key-value rows in its own collapsible section;
  // if empty/missing, hidden by the hasDisplayContent gate.
  attributes: (value: unknown) => {
    if (!hasDisplayContent(value)) return null;
    return <RunAttributesCard attributes={value as Record<string, string>} />;
  },
  // Dates — wrapped with TimestampTooltip showing UTC/local + relative time
  occurredAt: timestampWithTooltipOrNull,
  createdAt: timestampWithTooltipOrNull,
  startedAt: timestampWithTooltipOrNull,
  updatedAt: (_value: unknown) => null,
  completedAt: timestampWithTooltipOrNull,
  expiredAt: (_value: unknown) => null,
  retryAfter: timestampWithTooltipOrNull,
  resumeAt: timestampWithTooltipOrNull,
  // Resolved attributes, won't actually use this function
  metadata: (value: unknown) => {
    if (!hasDisplayContent(value)) return null;
    if (isEncryptedMarker(value)) {
      return (
        <Collapsible label="Metadata">
          <EncryptedDataBlock />
        </Collapsible>
      );
    }
    if (isExpiredMarker(value)) {
      return (
        <Collapsible label="Metadata">
          <ExpiredFieldBlock />
        </Collapsible>
      );
    }
    return <RunMetadataCard metadata={value} />;
  },
  input: (value: unknown, context?: DisplayContext) => {
    if (isEncryptedMarker(value)) {
      return (
        <Collapsible
          label="Input"
          defaultOpen={context?.sectionOpen}
          onOpenChange={context?.onSectionOpenChange}
        >
          <EncryptedFieldBlock />
        </Collapsible>
      );
    }
    if (isExpiredMarker(value)) return <ExpiredFieldBlock />;
    // Check if input has args + closure vars structure
    if (value && typeof value === 'object' && 'args' in value) {
      const { args, closureVars, thisVal } = value as {
        args: unknown[];
        closureVars?: Record<string, unknown>;
        thisVal?: unknown;
      };
      const hasClosureVars = hasDisplayContent(closureVars);
      const hasThisVal = hasDisplayContent(thisVal);
      const hasArgs = hasDisplayContent(args);

      // Check if this is a doStreamStep - show conversation view with tabs
      if (context?.stepName && isDoStreamStep(context.stepName)) {
        const conversation = extractConversation(args);
        if (conversation && conversation.length > 0) {
          return (
            <>
              <ConversationWithTabs
                conversation={conversation}
                args={args}
                defaultOpen={context?.sectionOpen}
                onOpenChange={context?.onSectionOpenChange}
              />
              {hasClosureVars && (
                <Collapsible label="Closure Variables">
                  {JsonBlock(closureVars)}
                </Collapsible>
              )}
              {hasThisVal && (
                <Collapsible label="This Value">
                  {JsonBlock(thisVal)}
                </Collapsible>
              )}
            </>
          );
        }
      }

      // Don't render an empty "Input (0 arguments)" card when no input exists.
      if (!hasArgs && !hasClosureVars && !hasThisVal) {
        return <Collapsible label="Input (no data)" disabled />;
      }

      return (
        <>
          <Collapsible
            label="Input"
            defaultOpen={context?.sectionOpen}
            onOpenChange={context?.onSectionOpenChange}
          >
            {Array.isArray(args)
              ? args.map((v, i) => (
                  <div className="mt-2 first:mt-0" key={i}>
                    {JsonBlock(v)}
                  </div>
                ))
              : JsonBlock(args)}
          </Collapsible>
          {hasClosureVars && (
            <Collapsible label="Closure Variables">
              {JsonBlock(closureVars)}
            </Collapsible>
          )}
          {hasThisVal && (
            <Collapsible label="Context">{JsonBlock(thisVal)}</Collapsible>
          )}
        </>
      );
    }

    // Fallback: treat as plain array or object
    if (!hasDisplayContent(value)) {
      return <Collapsible label="Input (no data)" disabled />;
    }
    return (
      <Collapsible
        label="Input"
        defaultOpen={context?.sectionOpen}
        onOpenChange={context?.onSectionOpenChange}
      >
        {Array.isArray(value)
          ? value.map((v, i) => (
              <div className="mt-2 first:mt-0" key={i}>
                {JsonBlock(v)}
              </div>
            ))
          : JsonBlock(value)}
      </Collapsible>
    );
  },
  output: (value: unknown, context?: DisplayContext) => {
    if (isEncryptedMarker(value)) {
      return (
        <Collapsible
          label="Output"
          defaultOpen={context?.sectionOpen}
          onOpenChange={context?.onSectionOpenChange}
        >
          <EncryptedFieldBlock />
        </Collapsible>
      );
    }
    if (!hasDisplayContent(value)) return null;
    if (isExpiredMarker(value)) return <ExpiredFieldBlock />;
    return (
      <Collapsible
        label="Output"
        defaultOpen={context?.sectionOpen}
        onOpenChange={context?.onSectionOpenChange}
      >
        {JsonBlock(value)}
      </Collapsible>
    );
  },
  error: (value: unknown) => {
    if (isEncryptedMarker(value)) {
      return (
        <Collapsible label="Error" defaultOpen>
          <EncryptedFieldBlock />
        </Collapsible>
      );
    }
    if (isExpiredMarker(value)) return <ExpiredFieldBlock />;
    if (!hasDisplayContent(value)) return null;

    // Structured workflow errors may be persisted as either `{ message }` or
    // `{ message, stack }`. Render both with the dedicated error block.
    if (isStructuredError(value)) {
      return (
        <Collapsible label="Error" defaultOpen>
          <ErrorStackBlock value={value} />
        </Collapsible>
      );
    }

    return (
      <Collapsible label="Error" defaultOpen>
        {JsonBlock(value)}
      </Collapsible>
    );
  },
  eventData: (value: unknown) => {
    if (isEncryptedMarker(value)) {
      return (
        <Collapsible label="Event Data" defaultOpen>
          <EncryptedFieldBlock />
        </Collapsible>
      );
    }
    if (isExpiredMarker(value)) return <ExpiredFieldBlock />;
    if (!hasDisplayContent(value)) return null;
    return (
      <Collapsible label="Event Data" defaultOpen>
        {JsonBlock(value)}
      </Collapsible>
    );
  },
  errorCode: (value: unknown) => {
    if (typeof value !== 'string' || value.length === 0) return null;
    return String(value);
  },
};

const resolvableAttributes = [
  'input',
  'output',
  'error',
  'metadata',
  'attributes',
  'eventData',
];

// Attributes whose displayFn renders its own section header via Collapsible,
// so the outer AttributeBlock should not duplicate the label.
const selfHeaderedAttributes = new Set([
  'input',
  'output',
  'error',
  'metadata',
  'attributes',
  'eventData',
]);

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

const copyableBasicAttributes = new Set<AttributeKey>([
  'stepId',
  'hookId',
  'eventId',
  'deploymentId',
  'moduleSpecifier',
  'token',
]);

const loadingSectionLabels: Partial<Record<AttributeKey, string>> = {
  input: 'Input',
  output: 'Output',
  eventData: 'Event Data',
};

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
  const decryptCtx = useContext(DecryptClickContext);
  const sectionOpenRef = useRef(false);
  const handleSectionOpenChange = useCallback((open: boolean) => {
    sectionOpenRef.current = open;
  }, []);
  const label = loadingSectionLabels[attribute as AttributeKey];
  if (isLoading && label && !hasDisplayContent(value)) {
    if (decryptCtx?.hasEncryptedData) {
      return (
        <Collapsible
          label={label}
          defaultOpen={attribute === 'eventData' || sectionOpenRef.current}
          onOpenChange={handleSectionOpenChange}
        >
          <EncryptedFieldBlock />
        </Collapsible>
      );
    }
    return <Collapsible label={label} />;
  }

  const displayFn =
    attributeToDisplayFn[attribute as keyof typeof attributeToDisplayFn];
  if (!displayFn) {
    return null;
  }
  const displayValue = displayFn(value, {
    ...context,
    sectionOpen: sectionOpenRef.current,
    onSectionOpenChange: handleSectionOpenChange,
  });
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

  if (selfHeaderedAttributes.has(attribute)) {
    return <>{displayValue}</>;
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
      <div key={attribute} className="my-2 flex flex-col gap-0">
        <span className="text-label-14 text-gray-1000 font-medium first-letter:uppercase">
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
  moduleSourceUrl,
  isLoading,
  error,
  expiredAt,
  onStreamClick,
  onRunClick,
  onDecrypt,
  isDecrypting = false,
  resource,
}: {
  data: Record<string, unknown>;
  moduleSpecifier?: string;
  moduleSourceUrl?: string;
  isLoading?: boolean;
  error?: Error;
  expiredAt?: string | Date;
  /** Callback when a stream reference is clicked */
  onStreamClick?: (streamId: string) => void;
  /** Callback when a run reference is clicked */
  onRunClick?: (runId: string) => void;
  /** Callback when an encrypted marker is clicked (triggers decryption) */
  onDecrypt?: () => void;
  /** Whether decryption is currently in progress */
  isDecrypting?: boolean;
  /** Resource type of the selected span — used to show targeted loading skeletons. */
  resource?: string;
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
  const resolvedAttributes = useMemo(() => {
    const present = Object.keys(displayData)
      .filter((key) => resolvableAttributes.includes(key))
      .sort(sortByAttributeOrder);

    if (!isLoading) return present;

    if (resource === 'sleep') return present;

    const loadingPlaceholders = ['input', 'output'];
    for (const key of loadingPlaceholders) {
      if (!present.includes(key)) {
        present.push(key);
      }
    }
    return present.sort(sortByAttributeOrder);
  }, [displayData, isLoading, resource]);

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
  const outerDecryptCtx = useContext(DecryptClickContext);
  const decryptValue = onDecrypt
    ? {
        onDecrypt,
        isDecrypting,
        hasEncryptedData: outerDecryptCtx?.hasEncryptedData,
      }
    : outerDecryptCtx;

  return (
    <ContextCardProvider>
      <RunClickContext.Provider value={onRunClick}>
        <StreamClickContext.Provider value={onStreamClick}>
          <DecryptClickContext.Provider value={decryptValue}>
            {visibleBasicAttributes.length > 0 && (
              <CollapsibleRoot defaultOpen>
                <CollapsibleTrigger>Metadata</CollapsibleTrigger>
                <CollapsibleContent className="mt-0 mb-2">
                  <div className="flex flex-col">
                    {orderedBasicAttributes.map((attribute) => {
                      const displayValue = attributeToDisplayFn[
                        attribute as keyof typeof attributeToDisplayFn
                      ]?.(displayData[attribute as keyof typeof displayData]);
                      const isCopyableBasicAttribute =
                        copyableBasicAttributes.has(
                          attribute as AttributeKey
                        ) && typeof displayValue === 'string';
                      const label = getAttributeDisplayName(attribute);

                      return (
                        <DetailMonoKeyValueRow
                          key={attribute}
                          label={label}
                          value={displayValue}
                          copyText={
                            isCopyableBasicAttribute ? displayValue : undefined
                          }
                          href={
                            attribute === 'moduleSpecifier'
                              ? moduleSourceUrl
                              : undefined
                          }
                        />
                      );
                    })}
                    {isLoading &&
                      resource === 'sleep' &&
                      !displayData.resumeAt && (
                        <div className="flex items-center justify-between gap-3 py-0.5">
                          <span className="text-label-13 text-gray-900">
                            Resume
                          </span>
                          <Skeleton className="h-4 w-[55%]" />
                        </div>
                      )}
                  </div>
                </CollapsibleContent>
              </CollapsibleRoot>
            )}
            {error ? (
              <ErrorCard
                title="Failed to load resource details"
                details={error.message}
                className="my-4"
              />
            ) : hasExpired ? (
              <ExpiredDataMessage />
            ) : resolvedAttributes.length > 0 ? (
              resolvedAttributes.map((attribute) => (
                <AttributeBlock
                  isLoading={isLoading}
                  key={attribute}
                  attribute={attribute}
                  value={displayData[attribute as keyof typeof displayData]}
                  context={displayContext}
                />
              ))
            ) : null}
          </DecryptClickContext.Provider>
        </StreamClickContext.Provider>
      </RunClickContext.Provider>
    </ContextCardProvider>
  );
};
