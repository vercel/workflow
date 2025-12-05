/**
 * Observability utilities for workflow inspection.
 * Shared between CLI and Web UI for consistent behavior.
 */

import {
  hydrateStepArguments,
  hydrateStepReturnValue,
  hydrateWorkflowArguments,
  hydrateWorkflowReturnValue,
} from './serialization.js';

const STREAM_ID_PREFIX = 'strm_';

/*
 * Check if a value is a stream ID
 */
export const isStreamId = (value: unknown): boolean => {
  return typeof value === 'string' && value.startsWith(STREAM_ID_PREFIX);
};

const streamToStreamId = (value: any): string => {
  if ('name' in value) {
    const name = String(value.name);
    if (!name.startsWith(STREAM_ID_PREFIX)) {
      return `${STREAM_ID_PREFIX}${name}`;
    }
    return name;
  }
  return `${STREAM_ID_PREFIX}null`;
};

const serializedStepFunctionToString = (value: unknown): string => {
  if (!value) return 'null';
  if (typeof value !== 'object') return 'null';
  if ('stepId' in value) {
    const stepId = value.stepId;
    // TODO: Add closure vars to the string representation.
    // value.closureVars
    return `<step:${stepId}>`;
  }
  return '<function>';
};

/**
 * This is an extra reviver for devalue that takes any streams that would be converted,
 * into actual streams, and instead formats them as string links for printing in CLI output.
 *
 * This is mainly because we don't want to open any streams that we aren't going to read from,
 * and so we can get the string ID/name, which the serializer stream doesn't provide.
 */
const streamPrintRevivers: Record<string, (value: any) => any> = {
  ReadableStream: streamToStreamId,
  WritableStream: streamToStreamId,
  TransformStream: streamToStreamId,
  StepFunction: serializedStepFunctionToString,
};

const hydrateStepIO = <
  T extends { stepId?: string; input?: any; output?: any; runId?: string },
>(
  step: T
): T => {
  return {
    ...step,
    input:
      step.input && Array.isArray(step.input) && step.input.length
        ? hydrateStepArguments(
            step.input,
            [],
            step.runId as string,
            globalThis,
            streamPrintRevivers
          )
        : step.input,
    output: step.output
      ? hydrateStepReturnValue(step.output, globalThis, streamPrintRevivers)
      : step.output,
  };
};

const hydrateWorkflowIO = <
  T extends { runId?: string; input?: any; output?: any },
>(
  workflow: T
): T => {
  return {
    ...workflow,
    input:
      workflow.input && Array.isArray(workflow.input) && workflow.input.length
        ? hydrateWorkflowArguments(
            workflow.input,
            globalThis,
            streamPrintRevivers
          )
        : workflow.input,
    output: workflow.output
      ? hydrateWorkflowReturnValue(
          workflow.output,
          [],
          workflow.runId as string,
          globalThis,
          streamPrintRevivers
        )
      : workflow.output,
  };
};

const hydrateEventData = <
  T extends { eventId?: string; eventData?: any; runId?: string },
>(
  event: T
): T => {
  if (!event.eventData) {
    return event;
  }
  const eventData = { ...event.eventData };
  // Events can have various eventData with non-devalued keys.
  // So far, only eventData.result is devalued (though this may change),
  // so we need to hydrate it specifically.
  try {
    if ('result' in eventData && typeof eventData.result === 'object') {
      eventData.result = hydrateStepReturnValue(
        eventData.result,
        globalThis,
        streamPrintRevivers
      );
    }
  } catch (error) {
    console.error('Error hydrating event data', error);
  }
  return {
    ...event,
    eventData,
  };
};

const hydrateHookMetadata = <T extends { hookId?: string; metadata?: any }>(
  hook: T
): T => {
  return {
    ...hook,
    metadata:
      hook.metadata && 'runId' in hook
        ? hydrateStepArguments(
            hook.metadata,
            [],
            hook.runId as string,
            globalThis,
            streamPrintRevivers
          )
        : hook.metadata,
  };
};

export const hydrateResourceIO = <
  T extends {
    stepId?: string;
    hookId?: string;
    eventId?: string;
    input?: any;
    output?: any;
    metadata?: any;
    eventData?: any;
    executionContext?: any;
  },
>(
  resource: T
): T => {
  if (!resource) {
    return resource;
  }
  let hydrated: T;
  if ('stepId' in resource) {
    hydrated = hydrateStepIO(resource);
  } else if ('hookId' in resource) {
    hydrated = hydrateHookMetadata(resource);
  } else if ('eventId' in resource) {
    hydrated = hydrateEventData(resource);
  } else {
    hydrated = hydrateWorkflowIO(resource);
  }
  if ('executionContext' in hydrated) {
    const { executionContext: _, ...rest } = hydrated;
    return rest as T;
  }
  return hydrated;
};

/**
 * Extract all stream IDs from a value (recursively traverses objects/arrays)
 */
export function extractStreamIds(obj: unknown): string[] {
  const streamIds: string[] = [];

  function traverse(value: unknown): void {
    if (isStreamId(value)) {
      streamIds.push(value as string);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        traverse(item);
      }
    } else if (value && typeof value === 'object') {
      for (const val of Object.values(value)) {
        traverse(val);
      }
    }
  }

  traverse(obj);
  return Array.from(new Set(streamIds)); // Remove duplicates
}

/**
 * Truncate a string to a maximum length, adding ellipsis if needed
 */
export function truncateId(id: string, maxLength = 12): string {
  if (id.length <= maxLength) return id;
  return `${id.slice(0, maxLength)}...`;
}
