// Benchmark: CPU cost of payload compression in the serialization layer.
//
// Compression is a pure client-side CPU cost added to the serialize
// (write) and deserialize (read) paths — it is WORLD-INDEPENDENT. The
// world (local / vercel / postgres) only changes the *baseline* you
// compare against (filesystem vs network+encryption+S3), so the absolute
// numbers here hold regardless of backend, and the *relative* impact is
// largest on the local world (fast baseline) and smallest on Vercel
// (network + encryption dominate). See scripts/README.md.
//
// Usage (from packages/core, after `pnpm build`):
//   node scripts/benchmark-compression-cpu.mjs
//
// Three sections:
//   1. Per-payload serialize + deserialize cost via the real shipping
//      path (the SDK's preferred codec — zstd when node:zlib has it,
//      else gzip), off vs on. Force gzip with WORKFLOW_COMPRESSION_CODEC=gzip.
//   2. Stress: total CPU to (de)serialize thousands of event payloads,
//      modelling a long workflow + replay.
//   3. Algorithm comparison (node:zlib sync APIs) — informational, to
//      compare gzip levels / zstd levels / brotli / deflate.

import zlib from 'node:zlib';
import * as step from '../dist/serialization/step.js';
import { ecommerceOrder, WORKLOADS } from './lib/workloads.mjs';

const encoder = new TextEncoder();

function rawBytes(value) {
  if (value instanceof Uint8Array) return value.byteLength;
  return encoder.encode(JSON.stringify(value)).byteLength;
}

/** Time an async fn: warm up, then run until both minIters and minMs met. */
async function timeAsync(
  fn,
  { warmup = 30, minIters = 50, minMs = 1500 } = {}
) {
  for (let i = 0; i < warmup; i++) await fn();
  let iters = 0;
  const start = performance.now();
  let elapsed = 0;
  do {
    await fn();
    iters++;
    elapsed = performance.now() - start;
  } while (iters < minIters || elapsed < minMs);
  return { usPerOp: (elapsed * 1000) / iters, iters };
}

/** Time a sync fn the same way. */
function timeSync(fn, { warmup = 30, minIters = 50, minMs = 1000 } = {}) {
  for (let i = 0; i < warmup; i++) fn();
  let iters = 0;
  const start = performance.now();
  let elapsed = 0;
  do {
    fn();
    iters++;
    elapsed = performance.now() - start;
  } while (iters < minIters || elapsed < minMs);
  return { usPerOp: (elapsed * 1000) / iters, iters };
}

const mbPerSec = (bytes, usPerOp) => bytes / (usPerOp / 1e6) / (1024 * 1024);
const pct = (a, b) => `${(((a - b) / b) * 100).toFixed(1)}%`;

// ---------------------------------------------------------------------------
// 1. Per-payload serialize + deserialize cost (real shipping path)
// ---------------------------------------------------------------------------

const writeCodec = process.env.WORKFLOW_COMPRESSION_CODEC || 'zstd (default)';
console.log(
  `## Serialize + deserialize CPU cost (real shipping path, codec: ${writeCodec})`
);
console.log('');
console.log(
  '| Workload | ser off | ser on | ser Δ | deser off | deser on | deser Δ | compress MB/s |'
);
console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');

for (const [name, value] of WORKLOADS) {
  const bytes = rawBytes(value);
  const serOff = await timeAsync(() => step.serialize(value, undefined, {}));
  const serOn = await timeAsync(() =>
    step.serialize(value, undefined, { compression: true })
  );

  const uncompressed = await step.serialize(value, undefined, {});
  const compressed = await step.serialize(value, undefined, {
    compression: true,
  });
  const deserOff = await timeAsync(() =>
    step.deserialize(uncompressed, undefined, {})
  );
  const deserOn = await timeAsync(() =>
    step.deserialize(compressed, undefined, {})
  );

  console.log(
    `| ${name} | ${serOff.usPerOp.toFixed(1)}µs | ${serOn.usPerOp.toFixed(1)}µs | +${pct(serOn.usPerOp, serOff.usPerOp)} | ${deserOff.usPerOp.toFixed(1)}µs | ${deserOn.usPerOp.toFixed(1)}µs | +${pct(deserOn.usPerOp, deserOff.usPerOp)} | ${mbPerSec(bytes, serOn.usPerOp - serOff.usPerOp).toFixed(0)} |`
  );
}

// ---------------------------------------------------------------------------
// 2. Stress: thousands of event payloads (long workflow + replay)
// ---------------------------------------------------------------------------
//
// A long workflow writes each step payload once and re-reads (replays)
// every prior payload on each cold start. We model the serialization CPU
// for N events: N serializes + N deserializes, off vs on. The "added"
// number is the total extra CPU compression spends across the whole run.

console.log('');
console.log('## Stress: total serialization CPU for N event payloads');
console.log('');
console.log(
  '(e-commerce order payload, ~6.6 KB each — representative step output)'
);
console.log('');
console.log(
  '| Events | off (ser+deser) | on (ser+deser) | added CPU | per event |'
);
console.log('| ---: | ---: | ---: | ---: | ---: |');

const stressValue = ecommerceOrder();
const stressUncompressed = await step.serialize(stressValue, undefined, {});
const stressCompressed = await step.serialize(stressValue, undefined, {
  compression: true,
});

for (const n of [1000, 5000, 10000]) {
  // Time one ser+deser cycle for each mode, then multiply by N. Timing
  // each cycle (rather than looping N inline) keeps GC pressure realistic
  // and the per-op cost stable.
  const offCycle = await timeAsync(async () => {
    const s = await step.serialize(stressValue, undefined, {});
    await step.deserialize(s, undefined, {});
  });
  const onCycle = await timeAsync(async () => {
    const s = await step.serialize(stressValue, undefined, {
      compression: true,
    });
    await step.deserialize(s, undefined, {});
  });
  const offTotalMs = (offCycle.usPerOp * n) / 1000;
  const onTotalMs = (onCycle.usPerOp * n) / 1000;
  console.log(
    `| ${n.toLocaleString()} | ${offTotalMs.toFixed(0)}ms | ${onTotalMs.toFixed(0)}ms | +${(onTotalMs - offTotalMs).toFixed(0)}ms | +${(onCycle.usPerOp - offCycle.usPerOp).toFixed(1)}µs |`
  );
}
void stressUncompressed;
void stressCompressed;

// ---------------------------------------------------------------------------
// 3. Algorithm comparison (node:zlib sync) — informational
// ---------------------------------------------------------------------------
//
// Production uses Web CompressionStream('gzip') ≈ zlib gzip level 6. These
// sync numbers let us compare candidate codecs for a future format prefix
// (e.g. a `zsd1` zstd codec) without committing to one. Measured on the
// devalue-serialized payload bytes (what the layer actually compresses).

console.log('');
console.log('## Algorithm comparison (node:zlib sync, informational)');
console.log('');

// zstd entries are gated on availability (node:zlib >= 22.15). The
// production gzip path ships via the Web CompressionStream (≈ gzip -6); the
// node:zlib gzip rows here isolate pure codec speed from that stream
// overhead, and are the apples-to-apples comparison against zstd.
const hasZstd = typeof zlib.zstdCompressSync === 'function';
const zstdAt = (level) => (b) =>
  zlib.zstdCompressSync(b, {
    params: { [zlib.constants.ZSTD_c_compressionLevel]: level },
  });

const ALGOS = [
  ['gzip -1', (b) => zlib.gzipSync(b, { level: 1 }), zlib.gunzipSync],
  ['gzip -6 (default)', (b) => zlib.gzipSync(b, { level: 6 }), zlib.gunzipSync],
  ['gzip -9', (b) => zlib.gzipSync(b, { level: 9 }), zlib.gunzipSync],
  ...(hasZstd
    ? [
        ['zstd -3 (default)', zstdAt(3), zlib.zstdDecompressSync],
        ['zstd -9', zstdAt(9), zlib.zstdDecompressSync],
        ['zstd -19', zstdAt(19), zlib.zstdDecompressSync],
      ]
    : []),
  [
    'brotli -q5',
    (b) =>
      zlib.brotliCompressSync(b, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 },
      }),
    zlib.brotliDecompressSync,
  ],
  ['deflate-raw', (b) => zlib.deflateRawSync(b), zlib.inflateRawSync],
];

// Use the larger text/structured payloads where codec choice matters.
const ALGO_WORKLOADS = WORKLOADS.filter(([name]) =>
  /chat|API|document|Time series/.test(name)
);

for (const [name, value] of ALGO_WORKLOADS) {
  const input = await step.serialize(value, undefined, {}); // devl + bytes
  const inputBytes = input.byteLength;
  console.log(`### ${name} (${(inputBytes / 1024).toFixed(1)} KB serialized)`);
  console.log('');
  console.log('| Algorithm | ratio | compress | decompress | compress MB/s |');
  console.log('| --- | ---: | ---: | ---: | ---: |');
  for (const [algo, compressFn, decompressFn] of ALGOS) {
    const out = compressFn(input);
    const ratio = ((1 - out.length / inputBytes) * 100).toFixed(1);
    const c = timeSync(() => compressFn(input));
    const d = timeSync(() => decompressFn(out));
    console.log(
      `| ${algo} | ${ratio}% | ${c.usPerOp.toFixed(1)}µs | ${d.usPerOp.toFixed(1)}µs | ${mbPerSec(inputBytes, c.usPerOp).toFixed(0)} |`
    );
  }
  console.log('');
}
