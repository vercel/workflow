import { registerOTel } from '@vercel/otel';

export async function register() {
  registerOTel({ serviceName: 'nextjs-turbopack-workflow' });
  // Start the workflow World once at server boot so in-flight runs are
  // recovered after a restart without needing a workflow operation. Only in the
  // Node.js runtime (the Edge runtime can't load the world modules and doesn't
  // own the queue/recovery loop). No-op on the Vercel World; runs recovery for
  // the local/postgres worlds.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { ensureWorldStarted } = await import('workflow/runtime');
    await ensureWorldStarted();
  }
}
