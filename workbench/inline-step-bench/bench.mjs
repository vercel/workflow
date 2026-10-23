#!/usr/bin/env node
//
// Local benchmark: step-to-step overhead (STSO) for steps that run *eagerly
// inline* — many sequential steps executed inside a single flow-handler
// invocation, with no queue hop between them.
//
// What it measures
// ----------------
// A workflow of N sequential no-op ("null") steps. Each step body stamps
// performance.now() on entry and exit. STSO[i] = t0[i] - t1[i-1], i.e. the
// wall-clock the runtime spends between the end of one step body and the start
// of the next. Because the step bodies do nothing, that gap IS the runtime
// overhead: reload/append the event log, build a fresh workflow VM, replay the
// workflow function from the top over the whole event log, and write
// step_started / step_completed for the next step.
//
// The point of interest is how that gap scales with the step index. The
// in-process loop in packages/core/src/runtime.ts re-runs the entire workflow
// function on every iteration against the full event log, so step N's gap is
// expected to grow with N.
//
// Usage
//   node bench.mjs                      # default scenarios
//   node bench.mjs --steps 1000         # override step count
//   node bench.mjs --only turbo-on      # run a single scenario
//   node bench.mjs --keep-data          # don't delete the world's data dir

import cp from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- CLI args

function parseArgs(argv) {
  const out = {
    steps: undefined,
    only: undefined,
    keepData: false,
    runs: 1,
    suite: 'default',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--steps') out.steps = Number(argv[++i]);
    else if (a === '--only') out.only = argv[++i];
    else if (a === '--runs') out.runs = Number(argv[++i]);
    else if (a === '--keep-data') out.keepData = true;
    else if (a === '--suite') out.suite = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(
        fs.readFileSync(new URL(import.meta.url), 'utf8').slice(0, 1600)
      );
      process.exit(0);
    } else throw new Error(`unknown arg: ${a}`);
  }
  return out;
}

const ARGS = parseArgs(process.argv.slice(2));
const STEPS = ARGS.steps ?? 1000;

// Keep the whole chain inside one invocation: the runtime otherwise bails out
// to the queue after WORKFLOW_V2_TIMEOUT_MS (default 120s) of wall time or
// WORKFLOW_REPLAY_TIMEOUT_MS (default 240s) of non-step time.
const LONG_INVOCATION_ENV = {
  WORKFLOW_V2_TIMEOUT_MS: '3600000',
  WORKFLOW_REPLAY_TIMEOUT_MS: '780000',
};

/**
 * Scenarios. `debug` runs turn on the runtime's debug log so we can read
 * per-replay `replayMs` / `eventCount` straight from the runtime; they are
 * reported separately because the logging itself perturbs the STSO numbers.
 */
const SCENARIOS = [
  {
    name: 'turbo-on',
    title: 'default config (turbo mode ON — the shipped default)',
    workflow: 'timedNullStepsWorkflow',
    env: {},
  },
  {
    name: 'turbo-off',
    title: 'WORKFLOW_TURBO=0 (await step_started before running each body)',
    workflow: 'timedNullStepsWorkflow',
    env: { WORKFLOW_TURBO: '0' },
  },
  {
    name: 'void-steps',
    title: 'void steps, timings reconstructed from the event log (control)',
    workflow: 'voidNullStepsWorkflow',
    env: {},
    fromEventLog: true,
  },
  {
    name: 'replay-profile',
    title: 'runtime debug log: replayMs + eventCount per loop iteration',
    workflow: 'timedNullStepsWorkflow',
    env: { DEBUG: 'workflow:runtime:debug' },
    debug: true,
  },
  {
    name: 'replay-profile-void',
    title: 'same, but for void steps (no per-step payload to re-deserialize)',
    workflow: 'voidNullStepsWorkflow',
    env: { DEBUG: 'workflow:runtime:debug' },
    debug: true,
    fromEventLog: true,
  },
];

/**
 * `--suite payload`: does the replay cost of a step's return value track its
 * SIZE, or whether ReplayPayloadCache can memoize it across replays?
 *
 * All six run the identical chain and are measured identically (event-log
 * timestamps), so only the step's return value differs. The pairs that matter:
 * str4000 vs str5000 (same type, 25% size difference, opposite sides of the
 * 4096-char memoize cap) and obj4 vs obj40 (both unmemoizable, 10× size).
 */
const PAYLOAD_SCENARIOS = [
  {
    name: 'void',
    title: 'step returns undefined (memoized)',
    workflow: 'voidNullStepsWorkflow',
  },
  {
    name: 'number',
    title: 'step returns a number — primitive, tiny (memoized)',
    workflow: 'numberStepsWorkflow',
  },
  {
    name: 'str4000',
    title:
      'step returns a 4000-char string — primitive, 4 KB, UNDER the 4096 cap (memoized)',
    workflow: 'str4000StepsWorkflow',
  },
  {
    name: 'str5000',
    title:
      'step returns a 5000-char string — primitive, 5 KB, OVER the 4096 cap (NOT memoized)',
    workflow: 'str5000StepsWorkflow',
  },
  {
    name: 'obj4',
    title: 'step returns a 4-field object — ~40 bytes (NOT memoized)',
    workflow: 'obj4StepsWorkflow',
  },
  {
    name: 'obj40',
    title: 'step returns a 40-field object — ~600 bytes (NOT memoized)',
    workflow: 'obj40StepsWorkflow',
  },
].map((s) => ({ ...s, env: {}, fromEventLog: true }));

// ------------------------------------------------------------ server harness

async function startServer(extraEnv) {
  const dataDir = path.join(
    os.tmpdir(),
    `inline-step-bench-${process.pid}-${randomUUID()}`
  );
  const proc = cp.spawn('node', [path.join(HERE, 'server.mjs')], {
    cwd: HERE,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      WORKFLOW_TARGET_WORLD: '@workflow/world-local',
      WORKFLOW_LOCAL_DATA_DIR: dataDir,
      CONTROL_FD: '3',
      ...LONG_INVOCATION_ENV,
      ...extraEnv,
    },
  });

  let out = '';
  proc.stdout.on('data', (c) => {
    out += c;
  });
  proc.stderr.on('data', (c) => {
    out += c;
  });

  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(
      () => reject(new Error(`server did not start:\n${out}`)),
      60_000
    );
    proc.stdio[3].on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(timer);
      resolve(JSON.parse(buf.slice(0, nl)).port);
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited (${code}):\n${out}`));
    });
  });

  return {
    port,
    base: `http://127.0.0.1:${port}`,
    getOutput: () => out,
    async stop() {
      if (proc.exitCode === null) {
        const exited = new Promise((r) => proc.once('exit', r));
        proc.kill();
        await Promise.race([exited, delay(5_000)]);
      }
      if (!ARGS.keepData) {
        await fsp
          .rm(dataDir, { recursive: true, force: true, maxRetries: 5 })
          .catch(() => {});
      }
    },
  };
}

async function json(url, init) {
  const res = await fetch(url, init);
  if (!res.ok)
    throw new Error(
      `${init?.method ?? 'GET'} ${url}: ${res.status} ${await res.text()}`
    );
  return res.json();
}

async function runWorkflowToCompletion(server, workflow, count) {
  const { runId } = await json(`${server.base}/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      file: 'workflows/null-steps.ts',
      workflow,
      args: [count],
    }),
  });

  const t0 = performance.now();
  const deadline = Date.now() + 900_000;
  for (;;) {
    const run = await json(`${server.base}/runs/${runId}`);
    if (run.status === 'completed')
      return { runId, run, wallMs: performance.now() - t0 };
    if (run.status === 'failed' || run.status === 'cancelled') {
      throw new Error(
        `run ${runId} ${run.status}: ${JSON.stringify(run.error)}`
      );
    }
    if (Date.now() > deadline)
      throw new Error(`run ${runId} timed out (${run.status})`);
    await delay(100);
  }
}

// ------------------------------------------------------------------- stats

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : NaN);
function quantile(xs, q) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** Ordinary least squares y = a + b*x. */
function linreg(xs, ys) {
  const n = xs.length;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  const b = den === 0 ? 0 : num / den;
  return { a: my - b * mx, b };
}

const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : 'n/a');
const f3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : 'n/a');

/** STSO[i] (i >= 1) = start of step i minus end of step i-1. */
function stsoSeries(samples) {
  const gaps = [];
  for (let i = 1; i < samples.length; i++) {
    gaps.push({ i, ms: samples[i].t0 - samples[i - 1].t1 });
  }
  return gaps;
}

function bucketReport(gaps, buckets) {
  const rows = [];
  for (const [lo, hi] of buckets) {
    const inRange = gaps.filter((g) => g.i >= lo && g.i <= hi).map((g) => g.ms);
    if (!inRange.length) continue;
    rows.push({
      range: `${lo}–${Math.min(hi, gaps[gaps.length - 1].i)}`,
      n: inRange.length,
      mean: mean(inRange),
      p50: quantile(inRange, 0.5),
      p90: quantile(inRange, 0.9),
      min: Math.min(...inRange),
      max: Math.max(...inRange),
    });
  }
  return rows;
}

function printTable(rows, cols) {
  const header = cols.map((c) => c.label.padStart(c.w)).join('  ');
  console.log(`  ${header}`);
  console.log(`  ${cols.map((c) => '─'.repeat(c.w)).join('  ')}`);
  for (const r of rows) {
    console.log(
      `  ${cols.map((c) => String(c.get(r)).padStart(c.w)).join('  ')}`
    );
  }
}

// -------------------------------------------------- event-log reconstruction

/**
 * Rebuild per-step timings from the world event log. `step_started.createdAt`
 * approximates body entry and `step_completed.createdAt` body exit, both at
 * ms resolution (coarser than performance.now(), but independent of anything
 * the workflow returns).
 */
function samplesFromEventLog(events) {
  const started = new Map();
  const out = [];
  for (const e of events) {
    if (e.eventType === 'step_started')
      started.set(e.correlationId, e.createdAt);
    else if (e.eventType === 'step_completed') {
      const t0 = started.get(e.correlationId);
      if (t0 === undefined) continue;
      out.push({ i: out.length, t0, t1: e.createdAt, wall: t0 });
    }
  }
  return out;
}

function eventHistogram(events) {
  const h = {};
  for (const e of events) h[e.eventType] = (h[e.eventType] ?? 0) + 1;
  return h;
}

// ---------------------------------------------------- debug-log replay parse

/**
 * Pull the runtime's own per-iteration replay accounting out of its debug log.
 *
 *   "Starting workflow replay"  { loopIteration, eventCount }
 *       — logged just before the fresh workflow VM replays the event log.
 *   "Workflow suspended"        { loopIteration, replayMs, steps, ... }
 *       — logged when that replay reaches the next un-run step, i.e. once per
 *         inline step. `replayMs` is measured from just before `runWorkflow()`
 *         to the moment the suspension is caught, so it is the *replay only*:
 *         no world writes, no step body.
 *   "Workflow replay completed" { loopIteration, replayMs }
 *       — the final iteration, where the workflow ran to its return.
 *
 * `loopIteration` restarts at 1 on every new flow-handler invocation, so a
 * non-monotonic sequence also reveals a queue hop.
 */
function parseReplayLog(text) {
  const field = (blob, name) => {
    const m = blob.match(new RegExp(`${name}:\\s*(\\d+)`));
    return m ? Number(m[1]) : undefined;
  };
  const starts = [];
  for (const m of text.matchAll(
    /Starting workflow replay\s*(\{[\s\S]{0,300}?\})/g
  )) {
    const it = field(m[1], 'loopIteration');
    const ec = field(m[1], 'eventCount');
    if (it !== undefined && ec !== undefined)
      starts.push({ iteration: it, eventCount: ec });
  }
  const rows = [];
  const re =
    /(Workflow suspended|Workflow replay completed)\s*(\{[\s\S]{0,300}?\})/g;
  for (const m of text.matchAll(re)) {
    const it = field(m[2], 'loopIteration');
    const ms = field(m[2], 'replayMs');
    if (it === undefined || ms === undefined) continue;
    rows.push({
      iteration: it,
      replayMs: ms,
      terminal: m[1] === 'Workflow replay completed',
      eventCount: starts[rows.length]?.eventCount,
    });
  }
  return rows;
}

// -------------------------------------------------------------- scenario run

const BUCKETS = [
  [1, 1],
  [2, 10],
  [11, 50],
  [51, 100],
  [101, 200],
  [201, 300],
  [301, 400],
  [401, 500],
  [501, 600],
  [601, 700],
  [701, 800],
  [801, 900],
  [901, 1000],
  [1001, Number.MAX_SAFE_INTEGER],
];

async function runScenario(scenario, steps) {
  console.log('');
  console.log('═'.repeat(78));
  console.log(`▶ ${scenario.name}: ${scenario.title}`);
  console.log(`  ${steps} sequential null steps · world-local`);
  console.log('═'.repeat(78));

  const server = await startServer(scenario.env);
  try {
    // Warm-up: JIT the flow route, the VM bootstrap, the world's fs paths.
    await runWorkflowToCompletion(server, scenario.workflow, 5);

    const { runId, run, wallMs } = await runWorkflowToCompletion(
      server,
      scenario.workflow,
      steps
    );
    const { count: invocations } = await json(
      `${server.base}/_flow-invocations/${runId}`
    );
    const { events } = await json(`${server.base}/runs/${runId}/events`);

    const samples = scenario.fromEventLog
      ? samplesFromEventLog(events)
      : run.output;

    if (!Array.isArray(samples) || samples.length !== steps) {
      throw new Error(
        `expected ${steps} samples, got ${Array.isArray(samples) ? samples.length : typeof samples}`
      );
    }

    const gaps = stsoSeries(samples);
    const bodyMs = samples.map((s) => s.t1 - s.t0);
    const spanMs = samples[samples.length - 1].t1 - samples[0].t0;
    const { a, b } = linreg(
      gaps.map((g) => g.i),
      gaps.map((g) => g.ms)
    );

    console.log('');
    console.log(
      `  flow-handler invocations for this run : ${invocations}` +
        (invocations === 1
          ? '  ✓ entire chain ran eagerly in ONE invocation'
          : '  ⚠ chain spanned multiple invocations')
    );
    console.log(
      `  events in the log                     : ${events.length} (${(events.length / steps).toFixed(2)} per step)`
    );
    console.log(`    ${JSON.stringify(eventHistogram(events))}`);
    console.log(
      `  step bodies executed                  : ${samples.length} (each exactly once)`
    );
    console.log(`  first-step-start → last-step-end      : ${f2(spanMs)} ms`);
    // For event-log-derived samples "body time" is really
    // step_completed.createdAt − step_started.createdAt, i.e. body + the
    // step_started write, not the body alone.
    console.log(
      `  Σ ${scenario.fromEventLog ? 'step_started→step_completed' : 'step body time            '}: ${f2(sum(bodyMs))} ms  (${((100 * sum(bodyMs)) / spanMs).toFixed(2)}% of the span)` +
        (scenario.fromEventLog
          ? '  ← event-log timestamps, so this is body + the step_started write, not body alone'
          : '')
    );
    console.log(
      `  Σ step-to-step overhead               : ${f2(sum(gaps.map((g) => g.ms)))} ms  (${((100 * sum(gaps.map((g) => g.ms))) / spanMs).toFixed(2)}% of the span)`
    );
    console.log(
      `  client-observed run wall time         : ${f2(wallMs)} ms (includes 100 ms status polling)`
    );
    console.log('');
    console.log('  step-to-step overhead by step index (ms)');
    printTable(bucketReport(gaps, BUCKETS), [
      { label: 'steps', w: 11, get: (r) => r.range },
      { label: 'n', w: 5, get: (r) => r.n },
      { label: 'mean', w: 8, get: (r) => f2(r.mean) },
      { label: 'p50', w: 8, get: (r) => f2(r.p50) },
      { label: 'p90', w: 8, get: (r) => f2(r.p90) },
      { label: 'min', w: 8, get: (r) => f2(r.min) },
      { label: 'max', w: 8, get: (r) => f2(r.max) },
    ]);

    const first10 = gaps.filter((g) => g.i <= 10).map((g) => g.ms);
    const last10 = gaps.slice(-10).map((g) => g.ms);
    console.log('');
    console.log(`  mean STSO, steps 1–10        : ${f2(mean(first10))} ms`);
    console.log(`  mean STSO, last 10 steps     : ${f2(mean(last10))} ms`);
    console.log(
      `  ratio (last 10 / first 10)   : ${f2(mean(last10) / mean(first10))}×`
    );
    console.log(`  OLS fit STSO(i) ≈ ${f3(a)} ms + ${f3(b)} ms × i`);
    console.log(
      `     → fixed per-step cost ≈ ${f3(a)} ms, marginal cost of each additional`
    );
    console.log(
      `       already-completed step in the log ≈ ${f3(b)} ms per replay`
    );

    let replayRows;
    if (scenario.debug) {
      // The warm-up run shares the server process, so its debug lines are in
      // the same buffer. `loopIteration` restarts at 1 per invocation, so drop
      // everything up to the second reset — that's where the measured run
      // begins.
      replayRows = parseReplayLog(server.getOutput());
      const resets = replayRows
        .map((r, idx) => (r.iteration === 1 ? idx : -1))
        .filter((idx) => idx >= 0);
      if (resets.length > 1) replayRows = replayRows.slice(resets[1]);
      if (replayRows.length) {
        console.log('');
        console.log(
          `  runtime replay log: ${replayRows.length} in-process loop iterations` +
            (replayRows.length === steps + 1
              ? `  ✓ ${steps} step-scheduling replays + 1 final replay that ran the workflow to completion`
              : '')
        );
        console.log(
          `    → the workflow function was re-executed from the top ${replayRows.length} times;`
        );
        console.log(`      each step body executed exactly once`);
        const bucketed = [];
        const size = Math.max(1, Math.floor(replayRows.length / 10));
        for (let i = 0; i < replayRows.length; i += size) {
          const chunk = replayRows.slice(i, i + size);
          bucketed.push({
            range: `${chunk[0].iteration}–${chunk[chunk.length - 1].iteration}`,
            events: chunk[chunk.length - 1].eventCount ?? '?',
            mean: mean(chunk.map((r) => r.replayMs)),
            max: Math.max(...chunk.map((r) => r.replayMs)),
          });
        }
        printTable(bucketed, [
          { label: 'iterations', w: 12, get: (r) => r.range },
          { label: 'events@end', w: 11, get: (r) => r.events },
          { label: 'mean replayMs', w: 14, get: (r) => f2(r.mean) },
          { label: 'max replayMs', w: 13, get: (r) => f2(r.max) },
        ]);
        const withEvents = replayRows.filter(
          (r) => typeof r.eventCount === 'number'
        );
        const fit = linreg(
          withEvents.map((r) => r.eventCount),
          withEvents.map((r) => r.replayMs)
        );
        console.log(
          `  OLS fit replayMs ≈ ${f3(fit.a)} + ${f3(fit.b)} × eventCount`
        );
        console.log(
          `  Σ replayMs = ${f2(sum(replayRows.map((r) => r.replayMs)))} ms across all iterations`
        );
        console.log(
          `  (event log grows by 3 events per step, so ${f3(fit.b)} ms/event ≈ ${f3(fit.b * 3)} ms per prior step)`
        );

        // Split each gap into "replay" and "everything else". Loop iteration
        // k schedules step k-1, so the replay that precedes step i is
        // iteration i+1's.
        const split = gaps
          .map((g) => {
            const row = replayRows[g.i];
            if (!row) return null;
            return {
              i: g.i,
              total: g.ms,
              replay: row.replayMs,
              other: g.ms - row.replayMs,
            };
          })
          .filter(Boolean);
        if (split.length) {
          console.log('');
          console.log(
            '  where the gap goes (ms): replay (fresh VM + re-run the workflow'
          );
          console.log(
            '  function over the whole event log) vs everything else (world writes,'
          );
          console.log('  incremental events.list, suspension bookkeeping)');
          const rows2 = [];
          for (const [lo, hi] of BUCKETS) {
            const chunk = split.filter((s) => s.i >= lo && s.i <= hi);
            if (!chunk.length) continue;
            rows2.push({
              range: `${lo}–${Math.min(hi, split[split.length - 1].i)}`,
              total: mean(chunk.map((s) => s.total)),
              replay: mean(chunk.map((s) => s.replay)),
              other: mean(chunk.map((s) => s.other)),
            });
          }
          printTable(rows2, [
            { label: 'steps', w: 11, get: (r) => r.range },
            { label: 'gap', w: 8, get: (r) => f2(r.total) },
            { label: 'replay', w: 8, get: (r) => f2(r.replay) },
            { label: 'other', w: 8, get: (r) => f2(r.other) },
            {
              label: 'replay%',
              w: 8,
              get: (r) => f2((100 * r.replay) / r.total),
            },
          ]);
        }
      } else {
        console.log(
          '  (no replay debug lines parsed — is DEBUG set correctly?)'
        );
      }
    }

    return {
      scenario: scenario.name,
      title: scenario.title,
      steps,
      invocations,
      eventCount: events.length,
      eventHistogram: eventHistogram(events),
      spanMs,
      bodyTotalMs: sum(bodyMs),
      stsoTotalMs: sum(gaps.map((g) => g.ms)),
      stsoFirst10Mean: mean(first10),
      stsoLast10Mean: mean(last10),
      stsoFit: { interceptMs: a, slopeMsPerStep: b },
      buckets: bucketReport(gaps, BUCKETS),
      gaps,
      replayRows,
    };
  } finally {
    await server.stop();
  }
}

// ---------------------------------------------------------------------- main

const suite = ARGS.suite === 'payload' ? PAYLOAD_SCENARIOS : SCENARIOS;
const wanted = ARGS.only ? suite.filter((s) => s.name === ARGS.only) : suite;
if (!wanted.length) throw new Error(`no scenario named ${ARGS.only}`);

console.log(
  'inline-step-bench — step-to-step overhead for eagerly inlined steps'
);
console.log(
  `node ${process.version} · ${os.cpus()[0]?.model ?? 'unknown cpu'} × ${os.cpus().length}`
);
const sdkVersion = JSON.parse(
  fs.readFileSync(path.join(HERE, 'node_modules/workflow/package.json'), 'utf8')
).version;
console.log(
  `workflow SDK ${sdkVersion} · repo HEAD ${process.env.BENCH_GIT_SHA ?? '(local)'}`
);

const results = [];
for (const scenario of wanted) {
  results.push(await runScenario(scenario, STEPS));
}

const outDir = path.join(HERE, 'results');
await fsp.mkdir(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const jsonPath = path.join(outDir, `bench-${STEPS}-${stamp}.json`);
await fsp.writeFile(
  jsonPath,
  JSON.stringify({ steps: STEPS, node: process.version, results }, null, 2)
);

for (const r of results) {
  const csv = [
    'step,stso_ms',
    ...r.gaps.map((g) => `${g.i},${g.ms.toFixed(4)}`),
  ].join('\n');
  await fsp.writeFile(
    path.join(outDir, `stso-${r.scenario}-${STEPS}.csv`),
    csv
  );
}

console.log('');
console.log('═'.repeat(78));
console.log('summary');
console.log('═'.repeat(78));
printTable(results, [
  { label: 'scenario', w: 20, get: (r) => r.scenario },
  { label: 'invocations', w: 12, get: (r) => r.invocations },
  { label: 'STSO 1–10', w: 10, get: (r) => f2(r.stsoFirst10Mean) },
  { label: 'STSO last10', w: 12, get: (r) => f2(r.stsoLast10Mean) },
  {
    label: 'growth',
    w: 8,
    get: (r) => `${f2(r.stsoLast10Mean / r.stsoFirst10Mean)}x`,
  },
  { label: 'fixed ms', w: 9, get: (r) => f3(r.stsoFit.interceptMs) },
  { label: 'ms/step', w: 9, get: (r) => f3(r.stsoFit.slopeMsPerStep) },
  { label: 'total ms', w: 10, get: (r) => f2(r.spanMs) },
]);
console.log('');
console.log(`raw results → ${jsonPath}`);
