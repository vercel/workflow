export default defineNuxtConfig({
  compatibilityDate: 'latest',
  modules: ['workflow/nuxt'],
  hooks: {
    // Start the Postgres World
    // Needed since we test this in CI
    'nitro:init': async () => {
      if (process.env.WORKFLOW_TARGET_WORLD === '@workflow/world-postgres') {
        import('workflow/runtime').then(async ({ getWorld }) => {
          console.log('Starting Postgres World...');
          await getWorld().start?.();
        });
      }
    },
  },
});
