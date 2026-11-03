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
    // Start the Postgres World's worker when the app boots, as the Postgres
    // World's setup guide says and the other workbenches' start-pg-world
    // plugins do. Without it the app's worker only started lazily, on the
    // app's first enqueue, so a run started from another process (the e2e
    // runner, which runs enqueue-only) was never delivered.
    if (process.env.WORKFLOW_TARGET_WORLD === '@workflow/world-postgres') {
      const { getWorld } = await import('workflow/runtime');
      const world = await getWorld();
      await world.start?.();
    }
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
