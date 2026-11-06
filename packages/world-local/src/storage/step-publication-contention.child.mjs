// Use Node's type stripping with the same relative .js → .ts resolution as
// in-band-fence.child.mjs, without inheriting the test runner's module mocks.
import { register } from 'node:module';

register(
  `data:text/javascript,${encodeURIComponent(
    'export async function resolve(s, c, n) { try { return await n(s, c); } catch (e) { if (/^\\.\\.?\\//.test(s) && s.endsWith(".js")) return n(s.slice(0, -3) + ".ts", c); throw e; } }'
  )}`
);

const { SPEC_VERSION_CURRENT } = await import('@workflow/world');
const { createStorage } = await import('../storage.ts');
const [dataDir, runId] = process.argv.slice(2);
await createStorage(dataDir).events.create(runId, {
  eventType: 'step_created',
  specVersion: SPEC_VERSION_CURRENT,
  correlationId: 'step_child',
  eventData: { stepName: 'child', input: new Uint8Array() },
});
