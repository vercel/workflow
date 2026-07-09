import type { ServerInit } from '@sveltejs/kit';
import { registerOTel } from '@vercel/otel';
import { createWorld as createPostgresWorld } from '@workflow/world-postgres';
import { setWorld } from 'workflow/runtime';

registerOTel({
  serviceName: 'example-sveltekit',
  instrumentationConfig: {
    fetch: {
      // By default @vercel/otel only propagates W3C trace context to Vercel
      // deployment URLs, so outgoing requests to the workflow-server
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
  // Start the Postgres World
  // Needed since we test this in CI
  if (process.env.WORKFLOW_TARGET_WORLD === '@workflow/world-postgres') {
    const world = await createPostgresWorld();
    setWorld(world);
    if (world.start) {
      console.log('Starting World workers...');
      await world.start();
    }
  }
};
