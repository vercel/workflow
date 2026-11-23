// CI-only Next.js instrumentation, copied into the workbench app by
// .github/workflows/e2e-community-world.yml before the dev server starts.
//
// The shipped workbench intentionally has no instrumentation file so it matches
// the Next.js getting-started docs. The community world adapters (MongoDB,
// Redis, Turso) store a queued message and deliver it from an in-process worker
// that only runs once `getWorld().start()` is called. Without this kickstart
// every run stays `pending` and each test waits out its deadline. The lane
// copies this file for every community world; `start?.()` leaves a world
// without a `start` unaffected.
import { registerOTel } from '@vercel/otel';

registerOTel({ serviceName: 'example-nextjs-workflow' });

if (process.env.NEXT_RUNTIME !== 'edge') {
  // kickstart the world
  import('workflow/runtime').then(async ({ getWorld }) => {
    await getWorld().start?.();
  });
}
