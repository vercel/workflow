import { createWorld as createPostgresWorld } from '@workflow/world-postgres';
import { definePlugin } from 'nitro';
import { setWorld } from 'workflow/runtime';

// Inject the Postgres World when configured (statically imported so bundlers
// include it). Needed since we test this in CI.
//
// Only injects — it does NOT start the World. Boot-time start (and in-flight
// run recovery) is handled by @workflow/nitro's auto-registered startup
// plugin, which runs after config plugins like this one and calls
// `ensureWorldStarted()` with Nitro's authoritative dev flag.
export default definePlugin(async () => {
  if (process.env.WORKFLOW_TARGET_WORLD === '@workflow/world-postgres') {
    setWorld(await createPostgresWorld());
  }
});
