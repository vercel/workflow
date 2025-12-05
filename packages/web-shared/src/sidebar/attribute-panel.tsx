'use client';

import { parseStepName, parseWorkflowName } from '@workflow/core/parse-name';
import type { Event, Hook, Step, WorkflowRun } from '@workflow/world';
import { AlertCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { DetailCard } from './detail-card';

const JsonBlock = (value: unknown) => {
  return (
    <pre
      className="text-copy-12 overflow-x-auto rounded-md border p-4"
      style={{
        borderColor: 'var(--ds-gray-300)',
        backgroundColor: 'var(--ds-gray-100)',
        color: 'var(--ds-gray-1000)',
      }}
    >
      <code>{JSON.stringify(value, null, 2)}</code>
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

const attributeToDisplayFn: Record<
  AttributeKey,
  (value: unknown) => null | string | ReactNode
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
  createdAt: (value: unknown) => new Date(String(value)).toLocaleString(),
  startedAt: (value: unknown) => new Date(String(value)).toLocaleString(),
  updatedAt: (value: unknown) => new Date(String(value)).toLocaleString(),
  completedAt: (value: unknown) => new Date(String(value)).toLocaleString(),
  expiredAt: (value: unknown) => new Date(String(value)).toLocaleString(),
  retryAfter: (value: unknown) => new Date(String(value)).toLocaleString(),
  resumeAt: (value: unknown) => new Date(String(value)).toLocaleString(),
  // Resolved attributes, won't actually use this function
  metadata: JsonBlock,
  input: (value: unknown) => {
    // Check if input has args + closure vars structure
    if (value && typeof value === 'object' && 'args' in value) {
      const { args, closureVars } = value as {
        args: unknown[];
        closureVars?: Record<string, unknown>;
      };
      const argCount = Array.isArray(args) ? args.length : 0;
      const hasClosureVars = closureVars && Object.keys(closureVars).length > 0;

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
                  className="text-copy-12 font-medium"
                  style={{ color: 'var(--ds-gray-700)' }}
                >
                  Error Code:{' '}
                </span>
                <code
                  className="text-copy-12"
                  style={{ color: 'var(--ds-gray-1000)' }}
                >
                  {error.code}
                </code>
              </div>
            )}
            {/* Show stack if available, otherwise just the message */}
            <pre
              className="text-copy-12 overflow-x-auto rounded-md border p-4"
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
          className="text-copy-12 overflow-x-auto rounded-md border p-4"
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
    <span>This data has expired and is no longer available.</span>
  </div>
);

export const AttributeBlock = ({
  attribute,
  value,
  isLoading,
}: {
  attribute: string;
  value: unknown;
  isLoading?: boolean;
}) => {
  const displayFn =
    attributeToDisplayFn[attribute as keyof typeof attributeToDisplayFn];
  if (!displayFn) {
    return null;
  }
  const displayValue = displayFn(value);
  if (!displayValue) {
    return null;
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
        <span className="font-medium" style={{ color: 'var(--ds-gray-500)' }}>
          {attribute}
        </span>
        <span style={{ color: 'var(--ds-gray-1000)' }}>{displayValue}</span>
      </div>
    </div>
  );
};

export const AttributePanel = ({
  data,
  isLoading,
  error,
}: {
  data: Record<string, unknown>;
  isLoading?: boolean;
  error?: Error;
}) => {
  const displayData = data;
  const hasExpired =
    'expiredAt' in displayData && displayData.expiredAt != null;
  const basicAttributes = Object.keys(displayData)
    .filter((key) => !resolvableAttributes.includes(key))
    .sort(sortByAttributeOrder);
  const resolvedAttributes = Object.keys(displayData)
    .filter((key) => resolvableAttributes.includes(key))
    .sort(sortByAttributeOrder);

  return (
    <div>
      {basicAttributes.map((attribute) => (
        <AttributeBlock
          key={attribute}
          attribute={attribute}
          value={displayData[attribute as keyof typeof displayData]}
        />
      ))}
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
          />
        ))
      )}
    </div>
  );
};
