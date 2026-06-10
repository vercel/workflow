// CI-only Next.js instrumentation, copied into the workbench app by
// .github/workflows/e2e-community-world.yml before the dev server starts.
//
// The shipped workbench intentionally has no instrumentation file so it matches
// the Next.js getting-started docs (removed in #1959/#1963). The community world
// adapters (e.g. MongoDB, Redis), however, dispatch created runs from an
// in-process queue worker that only runs once `getWorld().start()` is called.
// Without this kickstart every run stays `pending` and the E2E suite hangs until
// the job timeout. This restores the previous workbench instrumentation for the
// community-world E2E lane only.
import { registerOTel } from '@vercel/otel';

registerOTel({ serviceName: 'example-nextjs-workflow' });

if (process.env.NEXT_RUNTIME !== 'edge') {
  // kickstart the world
  import('workflow/runtime').then(async ({ getWorld }) => {
    await getWorld().start?.();
  });
}
