// Benchmark: serialized payload sizes with and without gzip compression.
//
// Measures the exact bytes the serialization layer hands to the World
// storage backends (S3/DynamoDB refs for world-vercel, bytea columns for
// world-postgres, JSON files for world-local) for a set of real-world-style
// workloads, with compression off vs on.
//
// Usage (from packages/core, after `pnpm build`):
//   node scripts/benchmark-compression-size.mjs
//
// Note: backends that store binary as base64 (DynamoDB inline refs,
// world-local JSON files) amplify every byte by 4/3, so the absolute
// savings there are ~33% larger than the raw numbers below.

import * as step from '../dist/serialization/step.js';
import { aiChatHistory, WORKLOADS } from './lib/workloads.mjs';

const encoder = new TextEncoder();

function byteLength(data) {
  if (data instanceof Uint8Array) return data.byteLength;
  return encoder.encode(JSON.stringify(data)).byteLength;
}

function fmt(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

const rows = [];
for (const [name, value] of WORKLOADS) {
  const off = await step.serialize(value, undefined, {});
  const on = await step.serialize(value, undefined, { compression: true });
  const offBytes = byteLength(off);
  const onBytes = byteLength(on);
  const savings = ((1 - onBytes / offBytes) * 100).toFixed(1);
  rows.push({ name, offBytes, onBytes, savings });
}

console.log('| Workload | Uncompressed | Compressed | Savings |');
console.log('| --- | ---: | ---: | ---: |');
for (const { name, offBytes, onBytes, savings } of rows) {
  const note = offBytes === onBytes ? ' (passthrough)' : '';
  console.log(
    `| ${name} | ${fmt(offBytes)} | ${fmt(onBytes)}${note} | ${offBytes === onBytes ? '—' : `${savings}%`} |`
  );
}

// Simulated event-log total for a representative run: an AI agent workflow
// with 10 steps that each return a growing chat history (the replay model
// re-serializes the full conversation at every step boundary).
let totalOff = 0;
let totalOn = 0;
for (let i = 1; i <= 10; i++) {
  const value = aiChatHistory(6 * i);
  totalOff += byteLength(await step.serialize(value, undefined, {}));
  totalOn += byteLength(
    await step.serialize(value, undefined, { compression: true })
  );
}
console.log('');
console.log(
  `Simulated 10-step AI agent run (event log total): ${fmt(totalOff)} → ${fmt(totalOn)} (${((1 - totalOn / totalOff) * 100).toFixed(1)}% smaller)`
);
