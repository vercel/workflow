// Start the Postgres World
// Needed since we test this in CI
// NOTE: Astro doesn't have a hook for starting the Postgres World in production
if (process.env.WORKFLOW_TARGET_WORLD === '@workflow/world-postgres') {
  const { getWorld } = await import('workflow/runtime');
  console.log('Starting Postgres World...');
  await getWorld().start?.();
}
