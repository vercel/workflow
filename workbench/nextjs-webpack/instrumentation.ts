import { registerOTel } from '@vercel/otel';
import { registerE2eLifecycleHooks } from './lifecycle-hooks-e2e';

export function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Workflow lifecycle hooks are host-only; skip the edge runtime's
    // instrumentation pass.
    registerE2eLifecycleHooks();
  }
  registerOTel({
    serviceName: 'nextjs-webpack',
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
