#!/usr/bin/env node
// Disk-usage benchmark: the same workload against one World implementation.
//
//   node bench/disk-usage.mjs <backend> <module> [--checkpoints 10000,50000,200000]
//                             [--out results.json] [--keep]
//
// <backend> is a label: `sqlite` enables the SQLite-only measurements
// (file split, WAL checkpoint, dbstat, vacuum, compression prototype).
// <module> is the path or specifier of a World package exporting
// createWorld({ dataDir }), e.g. packages/world-sqlite/dist/index.js.
//
// Workload: runs of 117 events (run_created, run_started, 38 × step_created
// / step_started / step_completed, run_completed) with deterministic,
// text-like step inputs and outputs, written through `events.create`.

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const [, , backend, modulePath, ...rest] = process.argv;
if (!backend || !modulePath) {
  console.error(
    'usage: disk-usage.mjs <backend> <module> [--checkpoints a,b,c] [--out file] [--keep]'
  );
  process.exit(2);
}
const opt = (name, fallback) => {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? fallback : rest[i + 1];
};
const checkpoints = opt('checkpoints', '10000,50000,200000')
  .split(',')
  .map(Number)
  .sort((a, b) => a - b);
const outFile = opt('out', undefined);
const keep = rest.includes('--keep');
const isSqlite = backend.startsWith('sqlite');

const resolved =
  modulePath.startsWith('.') || modulePath.startsWith('/')
    ? pathToFileURL(path.resolve(modulePath)).href
    : modulePath;
const { createWorld } = await import(resolved);
const SPEC_VERSION_CURRENT = 5;

// ---------------------------------------------------------------------------
// Payloads: JSON text, as a serialized step argument / return value would be.
// Deterministic so every backend stores identical bytes.
// ---------------------------------------------------------------------------

let seed = 0x9e3779b9;
function rand() {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 0x100000000;
}
const WORDS =
  'the order customer invoice shipped pending total amount currency usd eur item quantity price discount address street city country status message assistant user content tool call result search query document page summary token model latency retry error none true false id created updated'.split(
    ' '
  );
const word = () => WORDS[Math.floor(rand() * WORDS.length)];
function textPayload(targetBytes) {
  const records = [];
  let size = 2;
  while (size < targetBytes) {
    const rec = {
      id: `${word()}_${Math.floor(rand() * 1e9).toString(36)}`,
      kind: word(),
      amount: Math.round(rand() * 100000) / 100,
      at: new Date(1.7e12 + Math.floor(rand() * 1e10)).toISOString(),
      text: Array.from({ length: 6 + Math.floor(rand() * 18) }, word).join(' '),
    };
    const s = JSON.stringify(rec);
    size += s.length + 1;
    records.push(rec);
  }
  return new TextEncoder().encode(JSON.stringify({ items: records }));
}
// Inputs ~0.5–2 KB, outputs ~1–4 KB.
const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo));

// ---------------------------------------------------------------------------
// Workload
// ---------------------------------------------------------------------------

const STEPS_PER_RUN = 38; // 2 + 38 × 3 + 1 = 117 events
const EVENTS_PER_RUN = 3 + STEPS_PER_RUN * 3;

const dataDir = mkdtempSync(path.join(tmpdir(), `disk-bench-${backend}-`));
const world = createWorld({
  dataDir,
  recoverActiveRuns: false,
  baseUrl: 'http://127.0.0.1:1',
});
const runIds = [];
const payloadBytes = { runInput: 0, runOutput: 0, stepInput: 0, stepOutput: 0 };

async function writeRun() {
  const input = textPayload(between(300, 800));
  payloadBytes.runInput += input.byteLength;
  const created = await world.events.create(null, {
    eventType: 'run_created',
    specVersion: SPEC_VERSION_CURRENT,
    eventData: {
      deploymentId: 'dpl_bench',
      workflowName: 'workflow//bench//order',
      input,
    },
  });
  const runId = created.run.runId;
  runIds.push(runId);
  await world.events.create(
    runId,
    {
      eventType: 'run_started',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: {},
    },
    { skipPreload: true }
  );
  for (let i = 0; i < STEPS_PER_RUN; i++) {
    const stepId = `step_${runId.slice(5)}_${String(i).padStart(3, '0')}`;
    const stepInput = textPayload(between(500, 2000));
    const stepOutput = textPayload(between(1000, 4000));
    payloadBytes.stepInput += stepInput.byteLength;
    payloadBytes.stepOutput += stepOutput.byteLength;
    await world.events.create(runId, {
      eventType: 'step_created',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: stepId,
      eventData: { stepName: `step//bench//step${i % 7}`, input: stepInput },
    });
    await world.events.create(runId, {
      eventType: 'step_started',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: stepId,
      eventData: {},
    });
    await world.events.create(runId, {
      eventType: 'step_completed',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: stepId,
      eventData: { result: stepOutput },
    });
  }
  const output = textPayload(between(500, 1500));
  payloadBytes.runOutput += output.byteLength;
  await world.events.create(runId, {
    eventType: 'run_completed',
    specVersion: SPEC_VERSION_CURRENT,
    eventData: { output },
  });
}

// ---------------------------------------------------------------------------
// Measurement helpers
// ---------------------------------------------------------------------------

const MAC = process.platform === 'darwin';
function du(target) {
  // Allocated size, and apparent (logical) size, both in bytes.
  const disk =
    Number(execFileSync('du', ['-sk', target]).toString().split(/\s/)[0]) *
    1024;
  const apparent = MAC
    ? Number(execFileSync('du', ['-sAk', target]).toString().split(/\s/)[0]) *
      1024
    : Number(
        execFileSync('du', ['-sb', '--apparent-size', target])
          .toString()
          .split(/\s/)[0]
      );
  return { disk, apparent };
}
function countEntries(dir) {
  let files = 0;
  let dirs = 0;
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        dirs++;
        walk(path.join(d, entry.name));
      } else files++;
    }
  };
  walk(dir);
  return { files, dirs, inodes: files + dirs + 1 };
}
const fileSize = (f) => (existsSync(f) ? statSync(f).size : 0);

let DatabaseSync;
if (isSqlite) ({ DatabaseSync } = await import('node:sqlite'));
const dbFile = path.join(dataDir, 'workflow.sqlite');

function sqliteSplit() {
  return {
    db: fileSize(dbFile),
    wal: fileSize(`${dbFile}-wal`),
    shm: fileSize(`${dbFile}-shm`),
  };
}
function sqliteObjects(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT name, sum(pgsize) AS bytes, sum(payload) AS payload, sum(unused) AS unused
         FROM dbstat GROUP BY name ORDER BY bytes DESC`
      )
      .all();
    const pages = db.prepare('PRAGMA page_count').get().page_count;
    const free = db.prepare('PRAGMA freelist_count').get().freelist_count;
    const pageSize = db.prepare('PRAGMA page_size').get().page_size;
    return {
      pageSize,
      pages,
      freePages: free,
      objects: rows.map((r) => ({ ...r })),
    };
  } catch (error) {
    return { error: String(error.message) };
  } finally {
    db.close();
  }
}

/**
 * world-local: bytes the step entity files spend on copies of the step's
 * input and output, which the step_created / step_completed events also hold.
 */
function localDuplicateStepPayloads(dir) {
  const out = {
    input_bytes: 0,
    output_bytes: 0,
    step_files: 0,
    step_file_bytes: 0,
  };
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch (error) {
      // #4684 layout can move a run folder between listing and reading.
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.json')) {
        const text = readFileSync(p, 'utf8');
        const obj = JSON.parse(text);
        const size = Buffer.byteLength(text);
        out.step_files++;
        out.step_file_bytes += size;
        for (const [field, key] of [
          ['input', 'input_bytes'],
          ['output', 'output_bytes'],
        ]) {
          if (obj[field] === undefined) continue;
          const without = { ...obj };
          delete without[field];
          out[key] += size - Buffer.byteLength(JSON.stringify(without));
        }
      }
    }
  };
  const stepsDir = path.join(dir, 'steps');
  if (existsSync(stepsDir)) walk(stepsDir);
  return out;
}

/** world-sqlite: bytes the step rows spend on a copy of the step output. */
async function sqliteDuplicateStepPayloads(file) {
  const { deserialize } = await import('node:v8');
  const db = new DatabaseSync(file, { readOnly: true });
  const out = {
    input_bytes: 0,
    output_bytes: 0,
    step_rows: 0,
    step_row_bytes: 0,
  };
  for (const row of db.prepare('SELECT data FROM steps').iterate()) {
    const step = deserialize(row.data);
    out.step_rows++;
    out.step_row_bytes += row.data.byteLength;
    if (step.input?.byteLength) out.input_bytes += step.input.byteLength;
    if (step.output?.byteLength) out.output_bytes += step.output.byteLength;
  }
  db.close();
  return out;
}

async function snapshot(events) {
  const size = du(dataDir);
  const entries = countEntries(dataDir);
  const out = {
    events,
    runs: runIds.length,
    disk_bytes: size.disk,
    apparent_bytes: size.apparent,
    ...entries,
    disk_bytes_per_event: +(size.disk / events).toFixed(1),
    disk_bytes_per_run: Math.round(size.disk / runIds.length),
    apparent_bytes_per_event: +(size.apparent / events).toFixed(1),
    payload_bytes: { ...payloadBytes },
  };
  if (isSqlite) {
    out.sqlite_before_checkpoint = sqliteSplit();
    const db = new DatabaseSync(dbFile);
    db.exec('PRAGMA busy_timeout = 5000');
    out.checkpoint = { ...db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() };
    db.close();
    out.sqlite_after_checkpoint = sqliteSplit();
    const after = du(dataDir);
    out.disk_bytes_after_checkpoint = after.disk;
    out.apparent_bytes_after_checkpoint = after.apparent;
    out.dbstat = sqliteObjects(dbFile);
    out.duplicate_step_payloads = await sqliteDuplicateStepPayloads(dbFile);
  } else {
    out.duplicate_step_payloads = localDuplicateStepPayloads(dataDir);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const results = {
  backend,
  module: modulePath,
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  events_per_run: EVENTS_PER_RUN,
  checkpoints: [],
};
let events = 0;
const t0 = performance.now();
let writeMs = 0;
for (const target of checkpoints) {
  while (events + EVENTS_PER_RUN <= target) {
    const w = performance.now();
    await writeRun();
    writeMs += performance.now() - w;
    events += EVENTS_PER_RUN;
  }
  const snap = await snapshot(events);
  snap.elapsed_s = +((performance.now() - t0) / 1000).toFixed(1);
  // Wall time inside writeRun (payload generation + events.create), per event.
  snap.write_ms_per_event = +(writeMs / events).toFixed(3);
  results.checkpoints.push(snap);
  console.error(
    `[${backend}] ${events} events: disk ${(snap.disk_bytes / 1e6).toFixed(1)} MB, apparent ${(snap.apparent_bytes / 1e6).toFixed(1)} MB, ${snap.files} files, ${snap.write_ms_per_event} ms/event (${snap.elapsed_s}s)`
  );
}
await world.close?.();

// ---------------------------------------------------------------------------
// Deletion: drop every other run.
// ---------------------------------------------------------------------------

const doomed = runIds.filter((_, i) => i % 2 === 0);
if (isSqlite) {
  const measure = (file) => ({
    db: fileSize(file),
    wal: fileSize(`${file}-wal`),
    ...(() => {
      const d = new DatabaseSync(file, { readOnly: true });
      const r = {
        freePages: d.prepare('PRAGMA freelist_count').get().freelist_count,
        pages: d.prepare('PRAGMA page_count').get().page_count,
      };
      d.close();
      return r;
    })(),
  });
  const deleteRuns = (db) => {
    db.exec('BEGIN IMMEDIATE');
    const tables = db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
      .all()
      .map((r) => r.name);
    for (const table of tables) {
      const cols = db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => c.name);
      if (!cols.includes('run_id')) continue;
      const stmt = db.prepare(`DELETE FROM ${table} WHERE run_id = ?`);
      for (const id of doomed) stmt.run(id);
    }
    db.exec('COMMIT');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  };

  // A: the database as created (auto_vacuum = NONE) → DELETE → VACUUM.
  const a = path.join(dataDir, 'delete-a.sqlite');
  copyFileSync(dbFile, a);
  let db = new DatabaseSync(a);
  const autoVacuum = db.prepare('PRAGMA auto_vacuum').get().auto_vacuum;
  deleteRuns(db);
  db.close();
  const afterDelete = measure(a);
  db = new DatabaseSync(a);
  db.exec('VACUUM');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  const afterVacuum = measure(a);

  // B: switched to auto_vacuum = INCREMENTAL first → DELETE → incremental_vacuum.
  const b = path.join(dataDir, 'delete-b.sqlite');
  copyFileSync(dbFile, b);
  db = new DatabaseSync(b);
  db.exec('PRAGMA auto_vacuum = INCREMENTAL');
  db.exec('VACUUM');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  const incrementalBase = measure(b);
  db = new DatabaseSync(b);
  deleteRuns(db);
  db.close();
  const incrementalAfterDelete = measure(b);
  db = new DatabaseSync(b);
  db.exec('PRAGMA incremental_vacuum');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  const incrementalAfterVacuum = measure(b);

  results.deletion = {
    deleted_runs: doomed.length,
    of_runs: runIds.length,
    auto_vacuum_default: autoVacuum,
    before: measure(dbFile),
    after_delete: afterDelete,
    after_vacuum: afterVacuum,
    incremental: {
      before: incrementalBase,
      after_delete: incrementalAfterDelete,
      after_incremental_vacuum: incrementalAfterVacuum,
    },
  };
  rmSync(a, { force: true });
  rmSync(b, { force: true });

  // -------------------------------------------------------------------------
  // Compression / page-size prototype.
  // -------------------------------------------------------------------------
  const codecs = {
    deflate: (buf) => zlib.deflateRawSync(buf, { level: 6 }),
    brotli4: (buf) =>
      zlib.brotliCompressSync(buf, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 },
      }),
    ...(zlib.zstdCompressSync && {
      zstd3: (buf) => zlib.zstdCompressSync(buf),
    }),
  };
  // Each variant: a copy of the database, optionally with every record blob
  // compressed and/or a different page size, then VACUUMed.
  const variant = (codecName, pageSize) => {
    const c = path.join(dataDir, `variant-${codecName}-${pageSize}.sqlite`);
    copyFileSync(dbFile, c);
    db = new DatabaseSync(c);
    let raw = 0;
    let packed = 0;
    let ms = 0;
    const compress = codecs[codecName];
    if (compress) {
      db.exec('BEGIN IMMEDIATE');
      for (const table of ['events', 'runs', 'steps', 'hooks', 'waits']) {
        const cols = db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((col) => col.name);
        if (!cols.includes('data')) continue;
        const rows = db.prepare(`SELECT rowid AS id, data FROM ${table}`).all();
        const update = db.prepare(
          `UPDATE ${table} SET data = ? WHERE rowid = ?`
        );
        for (const row of rows) {
          const t = performance.now();
          const out = compress(row.data);
          ms += performance.now() - t;
          raw += row.data.byteLength;
          packed += out.byteLength;
          update.run(out, row.id);
        }
      }
      db.exec('COMMIT');
    }
    // page_size can only change outside WAL mode.
    db.exec('PRAGMA journal_mode = DELETE');
    db.exec(`PRAGMA page_size = ${pageSize}`);
    db.exec('VACUUM');
    db.close();
    const out = {
      codec: codecName,
      page_size: pageSize,
      db_bytes: fileSize(c),
      ...(compress && {
        record_bytes_raw: raw,
        record_bytes_compressed: packed,
        ratio: +(raw / packed).toFixed(2),
        compress_us_per_record: +(
          (ms * 1000) /
          results.checkpoints.at(-1).events
        ).toFixed(1),
      }),
    };
    rmSync(c, { force: true });
    return out;
  };
  results.variants = [
    variant('none', 4096),
    variant('none', 8192),
    variant('none', 16384),
    variant('none', 65536),
    ...Object.keys(codecs).map((name) => variant(name, 4096)),
    ...(codecs.zstd3 ? [variant('zstd3', 16384)] : []),
  ];
} else {
  const before = du(dataDir);
  const t = performance.now();
  const doomedSet = new Set(doomed);
  let removed = 0;
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      const owner = /^wrun_[0-9A-Z]{26}/.exec(entry.name)?.[0];
      if (owner && doomedSet.has(owner)) {
        rmSync(p, { recursive: true, force: true });
        removed++;
      } else if (entry.isDirectory()) walk(p);
    }
  };
  // Every per-run file and per-run directory is named after its run id.
  walk(dataDir);
  const after = du(dataDir);
  results.deletion = {
    deleted_runs: doomed.length,
    of_runs: runIds.length,
    removed_entries: removed,
    remove_s: +((performance.now() - t) / 1000).toFixed(1),
    before,
    after_delete: after,
    entries_after: countEntries(dataDir),
  };
}

const json = JSON.stringify(results, null, 2);
if (outFile) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(outFile, json);
}
console.log(json);
if (!keep) rmSync(dataDir, { recursive: true, force: true });
else console.error(`kept ${dataDir}`);
