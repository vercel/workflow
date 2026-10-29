import { AsyncResource } from 'node:async_hooks';
import { globalSingleton } from '@workflow/utils';
import { getOtelApi } from './telemetry.js';

/**
 * Runs work in the async context this module was loaded in, instead of the
 * context of whichever request is being served.
 *
 * Requests between a run's owner and its step workers (invokes, step results,
 * direct step delivery) belong to the run, not to the request that happened to
 * wake the process. The platform derives an outgoing request's `x-vercel-id`
 * hop chain from the active request context and rejects a chain longer than
 * its loop-detection limit with 508 `INFINITE_LOOP_DETECTED`. A long-lived
 * owner that dispatches work while handling a returned step result would
 * otherwise extend the chain by two hops per round trip. From the module-load
 * context the chain stays at a constant depth: none when the module loads
 * outside a request, otherwise the first request's.
 */
type Runner = <T>(work: () => T) => T;
const state = globalSingleton(
  '@workflow/world-vercel//outside-request',
  1,
  () => {
    const shared: {
      run: Runner;
      /** Resolved once, so a request starts synchronously at its call site
       * (the HTTP client span begins immediately before the request). */
      otel?: Awaited<ReturnType<typeof getOtelApi>>;
    } = {
      run: AsyncResource.bind((work: () => unknown) => work()) as Runner,
    };
    void getOtelApi()
      .then((api) => {
        shared.otel = api;
      })
      .catch(() => {});
    return shared;
  }
);

/**
 * `fetch` outside the current request context. Callers inject trace headers
 * explicitly; keeping the active trace context here also parents spans that
 * fetch instrumentation creates.
 */
export function fetchOutsideRequest(
  input: string | URL,
  init?: RequestInit
): Promise<Response> {
  const otel = state.otel;
  const active = otel?.context.active();
  return state.run(() =>
    otel && active
      ? otel.context.with(active, () => fetch(input, init))
      : fetch(input, init)
  );
}
