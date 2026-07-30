import { registerOTel } from '@vercel/otel';

// Repro branch only. `vercel.json`'s `env` block is the documented way to give
// the deployed functions a runtime variable, but Vercel marks it deprecated, so
// this is the belt to that suspenders: if the block were ignored, a storm here
// would measure stock main and read as "multiplexing is not the cause".
// `@workflow/world-vercel` reads the variable lazily in
// `createEventsDispatcher()`, which always runs after instrumentation, so
// setting it here reaches the same code path.
// Recorded so the probe route can also tell us whether the deprecated
// `vercel.json` block still works — that decides where the real mitigation
// advice should point if #3190 turns out to own the regression.
process.env.WORKFLOW_H2_MULTIPLEX_SOURCE =
  process.env.WORKFLOW_H2_MULTIPLEX === undefined
    ? 'instrumentation'
    : 'vercel.json';
process.env.WORKFLOW_H2_MULTIPLEX ??= '0';

export function register() {
  registerOTel({
    serviceName: 'nextjs-turbopack',
    instrumentationConfig: {
      fetch: {
        // By default @vercel/otel only propagates W3C trace context to Vercel
        // deployment URLs, so outgoing requests to the workflow-server
        // (vercel-workflow.com) and the Vercel Queue Service
        // (*.vercel-queue.com) get a client span with no `traceparent` header
        // — which breaks the trace link to those services' spans in APM.
        // Explicitly propagate context to both domains so traces stay
        // correlated end to end.
        // https://vercel.com/docs/tracing/instrumentation#configuring-context-propagation
        propagateContextUrls: [/vercel-workflow\.com/, /vercel-queue\.com/],
      },
    },
  });
}
