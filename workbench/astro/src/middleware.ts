import { defineMiddleware } from 'astro:middleware';

// Astro has no server-startup hook that works across all adapters, so start the
// World from middleware on the first request instead. `ensureWorldStarted()` is
// idempotent (it starts the World at most once per process), so this only does
// real work on the first request and is a cheap resolved-promise await
// thereafter. Starting the World runs boot-time recovery
// (`reenqueueActiveRuns`) for the local/postgres worlds so in-flight runs
// resume after a restart; it is a no-op on the Vercel World.
export const onRequest = defineMiddleware(async (_context, next) => {
  const { ensureWorldStarted } = await import('workflow/runtime');
  await ensureWorldStarted();
  return next();
});
