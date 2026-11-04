import { registerOTel } from '@vercel/otel';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Workflow lifecycle hooks are host-only. The import MUST be dynamic
    // and inside the runtime guard (the canonical Next.js pattern for
    // node-only instrumentation): a static top-level import would pull
    // `workflow/api` → world-init → @workflow/world-local → fs into every
    // compile target of instrumentation.ts, and the non-node ones cannot
    // resolve `fs` (breaks the webpack workbench's build).
    const { registerE2eLifecycleHooks } = await import('./lifecycle-hooks-e2e');
    registerE2eLifecycleHooks();
  }
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
