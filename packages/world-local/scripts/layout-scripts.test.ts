import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const bench = path.join(scripts, 'benchmark-layout.mjs');

/** Relative path -> sha256 of every file under `dir`. */
function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    out[path.relative(dir, full)] = createHash('sha256')
      .update(fs.readFileSync(full))
      .digest('hex');
  }
  return out;
}

function node(script: string, ...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

let root: string;
let store: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'world-local-scripts-'));
  store = path.join(root, 'store');
  fs.mkdirSync(path.join(store, 'events'), { recursive: true });
  fs.writeFileSync(
    path.join(store, 'events', 'wrun_A-evnt_1.json'),
    '{"runId":"wrun_A"}'
  );
  fs.writeFileSync(path.join(store, 'version.txt'), '5.0.1');
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

describe('benchmark-layout prepare', () => {
  const prepare = (src: string, dst: string, target = '10') =>
    node(bench, 'prepare', src, dst, target);

  function expectRefused(
    result: ReturnType<typeof prepare>,
    pattern: RegExp
  ): void {
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(pattern);
  }

  it('refuses the same path and leaves the source intact', () => {
    const before = hashTree(store);
    expectRefused(prepare(store, store), /already exists/);
    expect(hashTree(store)).toEqual(before);
  });

  it('refuses an ancestor of the source', () => {
    const before = hashTree(root);
    expectRefused(prepare(store, root), /already exists|overlaps/);
    expect(hashTree(root)).toEqual(before);
  });

  it('refuses a new destination inside the source', () => {
    const before = hashTree(store);
    const dst = path.join(store, 'copy');
    expectRefused(prepare(store, dst), /overlaps/);
    expect(hashTree(store)).toEqual(before);
    expect(fs.existsSync(dst)).toBe(false);
  });

  it('refuses a destination inside the source whose name starts with ..', () => {
    const before = hashTree(store);
    const dst = path.join(store, '..bench');
    expectRefused(prepare(store, dst), /overlaps/);
    expect(hashTree(store)).toEqual(before);
    expect(fs.existsSync(dst)).toBe(false);
  });

  it('refuses a destination reached through a symlink to the source', () => {
    const alias = path.join(root, 'alias');
    fs.symlinkSync(store, alias);
    const before = hashTree(store);
    expectRefused(prepare(alias, path.join(alias, 'copy')), /overlaps/);
    expectRefused(prepare(store, alias), /already exists/);
    expect(hashTree(store)).toEqual(before);
  });

  it('refuses an existing destination and leaves both intact', () => {
    const other = path.join(root, 'other');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'keep.txt'), 'keep');
    const before = { store: hashTree(store), other: hashTree(other) };
    expectRefused(prepare(store, other), /already exists/);
    expect({ store: hashTree(store), other: hashTree(other) }).toEqual(before);
  });

  it('copies into a new destination and pads it to the target', () => {
    const before = hashTree(store);
    const dst = path.join(root, 'bench');
    const result = prepare(store, dst);
    expect(result.status, result.stderr).toBe(0);
    expect(hashTree(store)).toEqual(before);
    expect(fs.readdirSync(path.join(dst, 'events'))).toHaveLength(10);
  });

  it('pads run-scoped sources in fake run directories without changing the source', () => {
    const events = path.join(store, 'events');
    fs.rmSync(events, { recursive: true });
    for (const runId of ['wrun_A', 'wrun_B', 'wrun_C']) {
      const dir = path.join(events, runId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${runId}-evnt_1.tag.json`), runId);
    }
    const before = hashTree(store);
    const dst = path.join(root, 'bench');
    const result = prepare(store, dst, '25');
    expect(result.status, result.stderr).toBe(0);
    expect(hashTree(store)).toEqual(before);
    const files = Object.keys(hashTree(dst)).filter(
      (file) => file.startsWith(`events${path.sep}`) && file.endsWith('.json')
    );
    expect(files).toHaveLength(25);
    const padding = files.filter((file) => file.includes('wrun_PAD'));
    expect(padding).toHaveLength(22);
    for (const file of padding) {
      expect(file.split(path.sep)[1]).toMatch(/^wrun_PAD\d{22}$/);
      expect(path.basename(file)).toMatch(/^wrun_PAD\d{22}-evnt_\d{26}\.json$/);
    }
  });

  it.each([
    'flat',
    'nested',
  ])('refuses an empty %s source before copying', (layout) => {
    const events = path.join(store, 'events');
    fs.rmSync(events, { recursive: true });
    const dir = layout === 'nested' ? path.join(events, 'wrun_A') : events;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'not-an-event.txt'), 'keep');
    fs.mkdirSync(path.join(dir, 'not-a-file.json'));
    const before = hashTree(store);
    const dst = path.join(root, 'bench');
    expectRefused(prepare(store, dst), /at least one event/);
    expect(fs.existsSync(dst)).toBe(false);
    expect(hashTree(store)).toEqual(before);
  });

  it('refuses a source without events/ before copying', () => {
    fs.rmSync(path.join(store, 'events'), { recursive: true });
    const before = hashTree(store);
    const dst = path.join(root, 'bench');
    expectRefused(prepare(store, dst), /events\/ directory/);
    expect(fs.existsSync(dst)).toBe(false);
    expect(hashTree(store)).toEqual(before);
  });

  it.each([
    '0',
    'abc',
    '-1',
    '1.5',
  ])('refuses invalid target %s before copying', (target) => {
    const before = hashTree(store);
    const dst = path.join(root, 'bench');
    expectRefused(prepare(store, dst, target), /positive integer/);
    expect(fs.existsSync(dst)).toBe(false);
    expect(hashTree(store)).toEqual(before);
  });
});
