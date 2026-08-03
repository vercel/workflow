/**
 * Utility to instrument object methods with tracing.
 * This is a minimal version for world-vercel to avoid circular dependencies with @workflow/core.
 */
import {
  getSpanKind,
  PeerService,
  RpcMethod,
  RpcService,
  RpcSystem,
  StepId,
  trace,
  WorkflowRunId,
} from './telemetry.js';

/** Configuration for peer service attribution */
const WORKFLOW_SERVER_SERVICE = {
  peerService: 'workflow-server',
  rpcSystem: 'http',
  rpcService: 'workflow-server',
};

const RUN_ID_ARG_INDEX_BY_METHOD: Record<string, number> = {
  'world.runs.get': 0,
  'world.runs.experimentalSetAttributes': 0,
  'world.steps.get': 0,
  'world.events.create': 0,
  'world.events.get': 0,
};

const RUN_ID_PARAM_METHODS = new Set([
  'world.steps.list',
  'world.events.list',
  'world.hooks.list',
]);

/**
 * Extracts the event type from arguments for events.create calls.
 * The event data is the second argument and contains eventType.
 */
function extractEventType(args: unknown[]): string | undefined {
  if (args.length >= 2 && typeof args[1] === 'object' && args[1] !== null) {
    const data = args[1] as Record<string, unknown>;
    if (typeof data.eventType === 'string') {
      return data.eventType;
    }
  }
  return undefined;
}

function getStringArg(args: unknown[], index: number): string | undefined {
  return typeof args[index] === 'string' ? args[index] : undefined;
}

function getRunIdFromParams(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null) {
    return undefined;
  }
  const runId = (params as Record<string, unknown>).runId;
  return typeof runId === 'string' ? runId : undefined;
}

function getRunIdFromResult(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) {
    return undefined;
  }

  const record = result as Record<string, unknown>;
  if (typeof record.runId === 'string') {
    return record.runId;
  }

  for (const key of ['run', 'step', 'hook', 'wait']) {
    const entity = record[key];
    if (typeof entity === 'object' && entity !== null) {
      const runId = (entity as Record<string, unknown>).runId;
      if (typeof runId === 'string') {
        return runId;
      }
    }
  }

  return undefined;
}

function extractWorkflowAttributes(
  prefix: string,
  methodName: string,
  args: unknown[]
): Record<string, string> {
  const methodKey = `${prefix}.${methodName}`;
  const attributes: Record<string, string> = {};

  const runIdArgIndex = RUN_ID_ARG_INDEX_BY_METHOD[methodKey];
  const runId =
    runIdArgIndex === undefined
      ? RUN_ID_PARAM_METHODS.has(methodKey)
        ? getRunIdFromParams(args[0])
        : undefined
      : getStringArg(args, runIdArgIndex);
  if (runId) {
    Object.assign(attributes, WorkflowRunId(runId));
  }

  if (methodKey === 'world.steps.get') {
    const stepId = getStringArg(args, 1);
    if (stepId) Object.assign(attributes, StepId(stepId));
  }

  return attributes;
}

/**
 * Wraps all methods of an object with tracing spans.
 * @param prefix - Prefix for span names (e.g., "world.runs")
 * @param o - Object with methods to instrument
 * @returns Instrumented object with same interface
 */
export function instrumentObject<T extends object>(prefix: string, o: T): T {
  const handlers = {} as T;
  for (const key of Object.keys(o) as (keyof T)[]) {
    if (typeof o[key] !== 'function') {
      handlers[key] = o[key];
    } else {
      const f = o[key];
      const methodName = String(key);
      // @ts-expect-error - dynamic function wrapping
      handlers[key] = async (...args: unknown[]) => {
        // Build span name - for events.create, include the event type
        let spanName = `${prefix}.${methodName}`;
        if (prefix === 'world.events' && methodName === 'create') {
          const eventType = extractEventType(args);
          if (eventType) {
            spanName = `${prefix}.${methodName} ${eventType}`;
          }
        }

        return trace(
          spanName,
          { kind: await getSpanKind('CLIENT') },
          async (span) => {
            // Add peer service attributes for service maps
            // Use spanName for rpc.method so Datadog shows event type in resource
            span?.setAttributes({
              ...PeerService(WORKFLOW_SERVER_SERVICE.peerService),
              ...RpcSystem(WORKFLOW_SERVER_SERVICE.rpcSystem),
              ...RpcService(WORKFLOW_SERVER_SERVICE.rpcService),
              ...RpcMethod(spanName),
              ...extractWorkflowAttributes(prefix, methodName, args),
            });
            const result = await f(...args);
            const resultRunId = getRunIdFromResult(result);
            if (resultRunId) {
              span?.setAttributes(WorkflowRunId(resultRunId));
            }
            return result;
          }
        );
      };
    }
  }
  return handlers;
}
