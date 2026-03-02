/**
 * Utility to instrument object methods with tracing.
 * This mirrors world-vercel's implementation for consistent observability.
 */
import {
  trace,
  getSpanKind,
  PeerService,
  RpcSystem,
  RpcService,
  RpcMethod,
} from './telemetry.js';

/** Configuration for peer service attribution */
const WORLD_LOCAL_SERVICE = {
  peerService: 'world-local',
  rpcSystem: 'local',
  rpcService: 'world-local',
};

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
          { kind: await getSpanKind('INTERNAL') },
          async (span) => {
            // Add peer service attributes for service maps
            // Use spanName for rpc.method so Datadog shows event type in resource
            span?.setAttributes({
              ...PeerService(WORLD_LOCAL_SERVICE.peerService),
              ...RpcSystem(WORLD_LOCAL_SERVICE.rpcSystem),
              ...RpcService(WORLD_LOCAL_SERVICE.rpcService),
              ...RpcMethod(spanName),
            });
            return f(...args);
          }
        );
      };
    }
  }
  return handlers;
}
