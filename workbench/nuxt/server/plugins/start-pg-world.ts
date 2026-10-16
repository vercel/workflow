import { defineNitroPlugin } from '#imports';

// Start the Postgres World
// Needed since we test this in CI
export default defineNitroPlugin(async () => {
  if (process.env.WORKFLOW_TARGET_WORLD === '@workflow/world-postgres') {
    // Dev lanes need this; production builds also get it from
    // `workflow/nitro`'s own start plugin, and ensureWorldStarted() runs the
    // World's start() once for both.
    import('workflow/runtime').then(({ ensureWorldStarted }) =>
      ensureWorldStarted()
    );
  }
});
