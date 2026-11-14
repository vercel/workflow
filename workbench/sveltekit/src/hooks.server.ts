import type { ServerInit } from '@sveltejs/kit';
import { registerOTel } from '@vercel/otel';

registerOTel({
  serviceName: 'example-sveltekit',
  instrumentationConfig: {
    fetch: {
      // By default @vercel/otel only propagates W3C trace context to Vercel
      // deployment URLs, so outgoing requests to the world-vercel backend
      // (vercel-workflow.com) and the Vercel Queue Service
      // (*.vercel-queue.com) get a client span with no `traceparent` header —
      // which breaks the trace link to those services' spans in APM.
      // Explicitly propagate context to both domains so traces stay
      // correlated end to end.
      // https://vercel.com/docs/tracing/instrumentation#configuring-context-propagation
      propagateContextUrls: [/vercel-workflow\.com/, /vercel-queue\.com/],
    },
  },
});

export const init: ServerInit = async () => {
  // The Postgres World delivers in process: this process is a worker. The
  // generated module hands the flow route to the World and starts it.
  if (process.env.WORKFLOW_TARGET_WORLD === '@workflow/world-postgres') {
    const { startWorkflowWorker } = await import(
      './routes/.well-known/workflow/v1/flow/worker.js'
    );
    await startWorkflowWorker();
  }
};
