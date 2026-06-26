import { registerOTel } from '@vercel/otel';

export async function register() {
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
  // Start the workflow World once at server boot so in-flight runs are
  // recovered after a restart without needing a workflow operation. Only in the
  // Node.js runtime (the Edge runtime can't load the world modules and doesn't
  // own the queue/recovery loop). No-op on the Vercel World; runs recovery for
  // the local/postgres worlds.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { ensureWorldStarted } = await import('workflow/runtime');
    await ensureWorldStarted();
  }
}
