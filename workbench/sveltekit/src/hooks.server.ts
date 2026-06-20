import type { ServerInit } from '@sveltejs/kit';

export const init: ServerInit = async () => {
  // Start the World once at server boot so in-flight runs are recovered after a
  // restart without needing a workflow operation. No-op on the Vercel World;
  // runs recovery for the local/postgres worlds.
  const { ensureWorldStarted } = await import('workflow/runtime');
  await ensureWorldStarted();
};
