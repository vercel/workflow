// Rerun: in an empty scratch directory, npm install --save-exact @workflow/world-local@5.0.0-beta.48
// Then node generate-5.0.0-beta.48.mjs OUTPUT_DIRECTORY. OUTPUT_DIRECTORY must not exist.
// Uses only the installed published World API; no fixture files are synthesized or rewritten.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import * as local from '@workflow/world-local';

const output = path.resolve(process.argv[2] ?? 'fixture');
await mkdir(output);
const dataDir = path.join(output, 'data');
const factory = local.createWorld ?? local.createLocalWorld;
const world = factory({ dataDir, recoverActiveRuns: false });
await world.start(); // Initialize/version-stamp before creating any active runs.
const tagged = factory({ dataDir, tag: 'vitest-0', recoverActiveRuns: false });
const bytes = new TextEncoder().encode('legacy fixture: 雪 🌍 café\u0000');
const version = JSON.parse(
  await readFile(
    new URL(
      './node_modules/@workflow/world-local/package.json',
      import.meta.url
    )
  )
).version;
const runs = [];
async function emit(w, runId, eventType, correlationId, eventData) {
  return w.events.create(runId, {
    eventType,
    specVersion: SPEC_VERSION_CURRENT,
    ...(correlationId && { correlationId }),
    ...(eventData !== undefined && { eventData }),
  });
}
async function seed(w, scenario, tag, count, complete) {
  const result = await emit(w, null, 'run_created', null, {
    deploymentId: 'legacy-fixture',
    workflowName: `legacy/${scenario}`,
    input: bytes,
  });
  const runId = result.run.runId;
  await emit(w, runId, 'run_started');
  for (let i = 1; i <= count; i++) {
    const id = `step_${String(i).padStart(6, '0')}`;
    await emit(w, runId, 'step_created', id, {
      stepName: `legacy-step-${i}`,
      input: bytes,
    });
    await emit(w, runId, 'step_started', id, { attempt: 1 });
    if (complete) await emit(w, runId, 'step_completed', id, { result: bytes });
  }
  if (scenario === 'in-flight') {
    await emit(w, runId, 'hook_created', 'hook_pending', {
      token: `legacy-${version}-pending`,
      metadata: bytes,
    });
    await emit(w, runId, 'wait_created', 'wait_pending', {
      resumeAt: new Date('2099-01-01T00:00:00.000Z'),
    });
  }
  if (complete) await emit(w, runId, 'run_completed', null, { output: bytes });
  if (scenario === 'completed') {
    const name = 'legacy-stream';
    if (w.streams) {
      await w.streams.write(runId, name, bytes);
      await w.streams.close(runId, name);
    } else {
      await w.writeToStream(name, runId, bytes);
      await w.closeStream(name, runId);
    }
  }
  const listParams = {
    runId,
    resolveData: 'all',
    pagination: { limit: 20, sortOrder: 'asc' },
  };
  const pages = [];
  let cursor;
  for (;;) {
    const page = await w.events.list({
      ...listParams,
      pagination: { ...listParams.pagination, ...(cursor && { cursor }) },
    });
    pages.push(page);
    if (!page.hasMore) break;
    if (!page.cursor || page.cursor === cursor)
      throw new Error('Pagination did not advance');
    cursor = page.cursor;
  }
  const run = await w.runs.get(runId, { resolveData: 'all' });
  const steps = await w.steps.list({
    runId,
    resolveData: 'all',
    pagination: { limit: 100, sortOrder: 'asc' },
  });
  const hooks = await w.hooks.list({ runId, resolveData: 'all' });
  runs.push({
    scenario,
    runId,
    status: run.status,
    tag,
    events: pages
      .flatMap((p) => p.data)
      .map((e) => ({
        eventId: e.eventId,
        eventType: e.eventType,
        correlationId: e.correlationId ?? null,
      })),
    steps: steps.data.map((s) => ({ stepId: s.stepId, status: s.status })),
    hooks: hooks.data.map((h) => ({ hookId: h.hookId, token: h.token })),
    eventsListParams: listParams,
    eventsListPages: pages,
    eventsListDefault: await w.events.list({ runId, resolveData: 'all' }),
    run,
    stepsList: steps,
    hooksList: hooks,
  });
}
try {
  await seed(world, 'completed', null, 3, true);
  await seed(world, 'in-flight', null, 1, false);
  await seed(world, 'pagination', null, 40, true); // 123 events, 7 explicit 20-item pages.
  await seed(tagged, 'tagged', 'vitest-0', 1, true);
  // Golden is the unmodified JSON projection of the public responses. Uint8Array
  // values become numeric-key objects and Dates become ISO strings via JSON.stringify.
  await writeFile(
    path.join(output, 'expected.json'),
    `${JSON.stringify({
      version,
      specVersion: SPEC_VERSION_CURRENT,
      binaryPayload: Array.from(bytes),
      unicodeText: new TextDecoder().decode(bytes),
      runs,
    })}\n`
  );
} finally {
  await tagged.close?.();
  await world.close?.();
}
console.log(
  version,
  runs.map((r) => [r.scenario, r.events.length])
);
