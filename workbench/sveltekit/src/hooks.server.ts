import { dev } from '$app/environment';
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
  // Explicitly construct the Postgres World when configured so it is
  // statically bundled; ensureWorldStarted() below picks it up and starts it.
  if (process.env.WORKFLOW_TARGET_WORLD === '@workflow/world-postgres') {
    setWorld(await createPostgresWorld());
  }

  // Start the World once at server boot so in-flight runs are recovered after a
  // restart without needing a workflow operation. No-op on the Vercel World;
  // runs recovery for the local/postgres worlds. `dev` comes from SvelteKit's
  // `$app/environment` (its authoritative dev/prod flag): in dev, previous
  // in-flight runs are cancelled rather than recovered (their code may have
  // changed); in a production build they are recovered.
  const { ensureWorldStarted } = await import('workflow/runtime');
  await ensureWorldStarted({ dev });
};
