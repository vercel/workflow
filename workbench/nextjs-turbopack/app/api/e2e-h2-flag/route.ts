/**
 * Repro-branch probe. Proves that `WORKFLOW_H2_MULTIPLEX`, set in this app's
 * `vercel.json` `env` block, actually reaches the deployed function's *runtime*
 * environment — which is where `@workflow/world-vercel` reads it, lazily, in
 * `createEventsDispatcher()` (packages/world-vercel/src/http-client.ts).
 *
 * Without this probe a flag-off storm that measures no change is ambiguous
 * between "multiplexing is not the cause" and "the flag never arrived".
 */
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({
    WORKFLOW_H2_MULTIPLEX: process.env.WORKFLOW_H2_MULTIPLEX ?? null,
    // Mirrors `h2MultiplexEnabled()` in world-vercel's http-client.
    multiplexEnabled: process.env.WORKFLOW_H2_MULTIPLEX !== '0',
    // 'vercel.json' if the deployment supplied it, 'instrumentation' if the
    // fallback in instrumentation.ts had to.
    source: process.env.WORKFLOW_H2_MULTIPLEX_SOURCE ?? null,
  });
}
