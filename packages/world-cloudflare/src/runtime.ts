/**
 * Process-wide wiring between the World and the workflow route.
 *
 * In this World nothing is delivered over HTTP. The run's Durable Object (or a
 * step runner) calls core's queue handler in its own isolate: it hands the
 * route a request carrying only a delivery token, and the handler our World
 * returned from `createQueueHandler` picks the message up by that token. The
 * route stays exactly what the builder generated; no payload is serialized on
 * the way in or out.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { globalSingleton } from '@workflow/utils';
import type { MessageId, ValidQueueName } from '@workflow/world';

export type FlowRoute = (req: Request) => Promise<Response>;

export interface DeliveryMeta {
  attempt: number;
  queueName: ValidQueueName;
  messageId: MessageId;
}

export interface RuntimeConfig {
  /** Identifier of the build this isolate runs. Runs are pinned to it. */
  deploymentId: string;
  /**
   * Creates an instance of the generated workflow route
   * (`workflowEntrypoint(workflowCode)`).
   *
   * Each run object instance uses a route instance of its own. Core keeps
   * per-run execution state inside a route instance (the active execution a
   * concurrent delivery joins), and an aborted object instance leaves its
   * executions pending forever. A fresh object instance must not join them.
   */
  createFlowRoute: () => FlowRoute;
}

type Handler = (message: unknown, meta: DeliveryMeta) => Promise<unknown>;

interface PendingDelivery {
  message: unknown;
  meta: DeliveryMeta;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

const DELIVERY_HEADER = 'x-workflow-cloudflare-delivery';
const FLOW_URL = 'http://workflow.internal/.well-known/workflow/v1/flow';

const state = globalSingleton('@workflow/world-cloudflare//runtime', 1, () => ({
  config: undefined as RuntimeConfig | undefined,
  sharedFlow: undefined as FlowRoute | undefined,
  pending: new Map<string, PendingDelivery>(),
  nextToken: 0,
}));

export function configureRuntime(config: RuntimeConfig): void {
  state.config = config;
}

export function getRuntimeConfig(): RuntimeConfig {
  if (!state.config) {
    throw new Error(
      'world-cloudflare: configureRuntime() was not called before the World was used'
    );
  }
  return state.config;
}

/**
 * The `createQueueHandler` implementation: a route handler that runs core's
 * callback for the delivery its request names.
 */
export function createQueueHandler(
  _prefix: string,
  handler: Handler
): (req: Request) => Promise<Response> {
  return async (req) => {
    const token = req.headers.get(DELIVERY_HEADER);
    const delivery = token ? state.pending.get(token) : undefined;
    if (!token || !delivery) {
      return new Response('Unknown workflow delivery', { status: 400 });
    }
    state.pending.delete(token);
    try {
      delivery.resolve(await handler(delivery.message, delivery.meta));
    } catch (error) {
      delivery.reject(error);
    }
    return new Response(null, { status: 204 });
  };
}

/** The isolate-wide route instance, for deliveries outside run objects. */
export function sharedFlowRoute(): FlowRoute {
  state.sharedFlow ??= getRuntimeConfig().createFlowRoute();
  return state.sharedFlow;
}

/** Run core's queue handler for one message in this isolate. */
export async function deliver(
  message: unknown,
  meta: DeliveryMeta,
  flow: FlowRoute = sharedFlowRoute()
): Promise<unknown> {
  const token = `d${++state.nextToken}`;
  const result = new Promise<unknown>((resolve, reject) => {
    state.pending.set(token, { message, meta, resolve, reject });
  });
  const response = await flow(
    new Request(FLOW_URL, {
      method: 'POST',
      headers: { [DELIVERY_HEADER]: token },
    })
  );
  if (state.pending.delete(token)) {
    throw new Error(
      `world-cloudflare: workflow route did not run the delivery (HTTP ${response.status}: ${await response.text()})`
    );
  }
  return result;
}

/**
 * The run whose Durable Object is executing the current call chain, if any.
 * World calls for that run are served in-process instead of over RPC.
 */
export interface LocalRun {
  runId: string;
  object: unknown;
}

const localRun = globalSingleton(
  '@workflow/world-cloudflare//localRun',
  1,
  () => ({ storage: new AsyncLocalStorage<LocalRun>() })
);

export function currentLocalRun(): LocalRun | undefined {
  return localRun.storage.getStore();
}

export function runAsLocal<T>(run: LocalRun, fn: () => T): T {
  return localRun.storage.run(run, fn);
}
