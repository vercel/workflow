// Benchmark world-local event create/list latency against a copy of a real
// data directory, to compare storage layouts across builds.
//
// Usage (from packages/world-local):
//   node scripts/benchmark-layout.mjs prepare <srcDataDir> <dstDataDir> [targetEvents=50000]
//   node scripts/benchmark-layout.mjs run <worldLocalDistIndexJs> <dataDir> [label]
//
// `prepare` copies a data directory into <dstDataDir> (copy-on-write clones
// where the filesystem supports them, e.g. APFS or btrfs) and pads
// events/ with cloned files under fake run ids until it holds `targetEvents`
// files. <dstStore> must not exist yet and must not overlap <srcStore>; the
// command refuses both before writing anything.
// `run` imports the given world-local build and measures:
//   - events.list of the largest real run, a mid-size run, and a 1-event run
//   - events.create for a brand-new run: run_created, run_started, 50 steps
//     (step_created/started/completed), run_completed
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const [cmd, ...args] = process.argv.slice(2);

function eventFiles(store) {
  const dir = path.join(store, 'events');
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.json')) out.push(entry.name);
    else if (entry.isDirectory()) {
      for (const f of fs.readdirSync(path.join(dir, entry.name))) {
        if (f.endsWith('.json')) out.push(f);
      }
    }
  }
  return out;
}

function runCounts(store) {
  const counts = new Map();
  for (const f of eventFiles(store)) {
    const runId = f.slice(0, f.indexOf('-evnt_'));
    counts.set(runId, (counts.get(runId) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * `prepare` writes only to a brand-new `dst`. Refuse, before touching
 * anything, a `dst` that already exists or that overlaps `src` (the same
 * path, an ancestor or a descendant, including through symlinks).
 */
function assertSafePrepareTarget(src, dst) {
  if (!src || !dst) {
    throw new Error('usage: prepare <srcStore> <dstStore> [targetEvents]');
  }
  const realSrc = fs.realpathSync(src);
  if (fs.existsSync(dst) || isBrokenSymlink(dst)) {
    throw new Error(
      `refusing to prepare into ${dst}: it already exists (the destination must be new)`
    );
  }
  const realDst = path.join(
    fs.realpathSync(path.dirname(path.resolve(dst))),
    path.basename(dst)
  );
  const within = (child, parent) => {
    const rel = path.relative(parent, child);
    // `..` alone or `../…` leaves `parent`; a name like `..bench` does not.
    return (
      rel === '' ||
      (rel !== '..' &&
        !rel.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(rel))
    );
  };
  if (within(realDst, realSrc) || within(realSrc, realDst)) {
    throw new Error(
      `refusing to prepare: ${dst} overlaps the source store ${src}`
    );
  }
}

function isBrokenSymlink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

if (cmd === 'prepare') {
  const [src, dst, targetArg] = args;
  const target = Number(targetArg ?? 50000);
  assertSafePrepareTarget(src, dst);
  fs.cpSync(src, dst, {
    recursive: true,
    errorOnExist: true,
    force: false,
    mode: fs.constants.COPYFILE_FICLONE,
  });
  const dir = path.join(dst, 'events');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const real = files.slice();
  let n = files.length;
  let pad = 0;
  while (n < target) {
    // Clone real event files under fake run ids, 1000 per fake run. The
    // content keeps the old runId; only file names matter for scan cost.
    const f = real[pad % real.length];
    const fakeRun = `wrun_PAD${String(Math.floor(pad / 1000)).padStart(22, '0')}`;
    const seq = String((pad % 1000) + 1).padStart(26, '0');
    fs.copyFileSync(
      path.join(dir, f),
      path.join(dir, `${fakeRun}-evnt_${seq}.json`),
      fs.constants.COPYFILE_FICLONE
    );
    pad++;
    n++;
  }
  console.log(`prepared ${dst}: ${n} event files (${pad} padding)`);
  process.exit(0);
}

if (cmd !== 'run') {
  console.error('usage: benchmark-layout.mjs prepare|run ...');
  process.exit(2);
}

const [impl, store, label = path.basename(path.dirname(impl))] = args;
const counts = runCounts(store).filter(([r]) => !r.startsWith('wrun_PAD'));
const largest = counts[0];
const mid = counts[Math.floor(counts.length / 2)];
const tiny = counts[counts.length - 1];
const totalEvents = eventFiles(store).length;

const mod = await import(pathToFileURL(impl).href);
const t0 = performance.now();
const world = mod.createWorld({ dataDir: store, recoverActiveRuns: false });
// Some versions migrate / initialise lazily on the first storage call.
await world.runs.list({ pagination: { limit: 1 } }).catch(() => {});
const initMs = performance.now() - t0;
// First per-run call: includes any one-time layout migration.
const tf = performance.now();
await world.events.list({ runId: counts[0][0], pagination: { limit: 1 } });
const firstCallMs = performance.now() - tf;

function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, p50: q(0.5), p95: q(0.95), max: s[s.length - 1] };
}
const fmt = (o) =>
  `n=${o.n} p50=${o.p50.toFixed(1)}ms p95=${o.p95.toFixed(1)}ms max=${o.max.toFixed(1)}ms`;

async function listAll(runId, resolveData) {
  let cursor;
  let n = 0;
  do {
    const page = await world.events.list({
      runId,
      pagination: { limit: 1000, cursor },
      resolveData,
    });
    n += page.data.length;
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return n;
}

const results = { label, totalEvents, initMs, firstCallMs };
console.log(
  `# ${label}: ${totalEvents} event files, init ${initMs.toFixed(0)}ms, first call ${firstCallMs.toFixed(0)}ms`
);

for (const [name, [runId, count]] of [
  ['list largest', largest],
  ['list mid', mid],
  ['list tiny', tiny],
]) {
  for (const resolveData of ['none', 'all']) {
    const xs = [];
    let got = 0;
    for (let i = 0; i < 5; i++) {
      const s = performance.now();
      got = await listAll(runId, resolveData);
      xs.push(performance.now() - s);
    }
    const st = stats(xs);
    results[`${name} (${resolveData})`] = st;
    console.log(
      `${name} [${count} ev, got ${got}] resolveData=${resolveData}: ${fmt(st)}`
    );
  }
}

// Brand-new run lifecycle.
const input = new Uint8Array(200 * 1024).fill(7); // a realistic step input
const timings = {};
async function timed(type, p) {
  const s = performance.now();
  const r = await p;
  if (!timings[type]) timings[type] = [];
  timings[type].push(performance.now() - s);
  return r;
}
const created = await timed(
  'run_created',
  world.events.create(null, {
    eventType: 'run_created',
    specVersion: world.specVersion,
    eventData: {
      deploymentId: 'bench',
      workflowName: 'bench',
      input: new Uint8Array([1]),
    },
  })
);
const runId = created.event.runId;
await timed(
  'run_started',
  world.events.create(runId, {
    eventType: 'run_started',
    specVersion: world.specVersion,
  })
);
for (let i = 0; i < 50; i++) {
  const stepId = `step_${String(i).padStart(4, '0')}`;
  await timed(
    'step_created',
    world.events.create(runId, {
      eventType: 'step_created',
      specVersion: world.specVersion,
      correlationId: stepId,
      eventData: { stepName: 'bench-step', input },
    })
  );
  await timed(
    'step_started',
    world.events.create(runId, {
      eventType: 'step_started',
      specVersion: world.specVersion,
      correlationId: stepId,
    })
  );
  await timed(
    'step_completed',
    world.events.create(runId, {
      eventType: 'step_completed',
      specVersion: world.specVersion,
      correlationId: stepId,
      eventData: { result: new Uint8Array([1, 2, 3]) },
    })
  );
}
await timed(
  'run_completed',
  world.events.create(runId, {
    eventType: 'run_completed',
    specVersion: world.specVersion,
    eventData: { output: new Uint8Array([1]) },
  })
);
// The runtime passes `sinceCursor` on almost every write to get the log delta
// back inline. Same lifecycle, 20 steps, with the cursor threaded through.
{
  let cursor;
  const sc = [];
  const r2 = await world.events.create(null, {
    eventType: 'run_created',
    specVersion: world.specVersion,
    eventData: {
      deploymentId: 'bench',
      workflowName: 'bench',
      input: new Uint8Array([1]),
    },
  });
  const rid = r2.event.runId;
  const go = async (req) => {
    const s = performance.now();
    const r = await world.events.create(
      rid,
      { specVersion: world.specVersion, ...req },
      cursor ? { sinceCursor: cursor } : undefined
    );
    sc.push(performance.now() - s);
    if (r.cursor) cursor = r.cursor;
  };
  await go({ eventType: 'run_started' });
  for (let i = 0; i < 20; i++) {
    const stepId = `step_${String(i).padStart(4, '0')}`;
    await go({
      eventType: 'step_created',
      correlationId: stepId,
      eventData: { stepName: 'bench-step', input },
    });
    await go({ eventType: 'step_started', correlationId: stepId });
    await go({
      eventType: 'step_completed',
      correlationId: stepId,
      eventData: { result: new Uint8Array([1]) },
    });
  }
  results['create with sinceCursor'] = stats(sc);
  console.log(`create with sinceCursor: ${fmt(stats(sc))}`);
}
const all = [];
for (const [type, xs] of Object.entries(timings)) {
  all.push(...xs);
  results[`create ${type}`] = stats(xs);
  console.log(`create ${type}: ${fmt(stats(xs))}`);
}
results['create (all)'] = stats(all);
console.log(`create (all ${all.length}): ${fmt(stats(all))}`);
const sx = performance.now();
const n = await listAll(runId, 'all');
console.log(`list new run [${n} ev]: ${(performance.now() - sx).toFixed(1)}ms`);

// Bytes the new run's 50 steps put on disk.
let bytes = 0;
for (const f of eventFiles(store))
  if (f.startsWith(runId)) {
    const p = fs.existsSync(path.join(store, 'events', f))
      ? path.join(store, 'events', f)
      : path.join(store, 'events', runId, f);
    bytes += fs.statSync(p).size;
  }
for (const f of fs.readdirSync(path.join(store, 'steps'))) {
  if (f.startsWith(runId))
    bytes += fs.statSync(path.join(store, 'steps', f)).size;
}
const stepDir = path.join(store, 'steps', runId);
if (fs.existsSync(stepDir) && fs.statSync(stepDir).isDirectory()) {
  for (const f of fs.readdirSync(stepDir))
    bytes += fs.statSync(path.join(stepDir, f)).size;
}
results.newRunBytes = bytes;
console.log(
  `new run on disk (events+steps): ${(bytes / 1024 / 1024).toFixed(1)} MB for 50 x 200KB inputs`
);
fs.writeFileSync(`${store}.${label}.json`, JSON.stringify(results, null, 2));
process.exit(0);
