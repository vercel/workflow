import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain JS lint rule, no type declarations
import {
  formatFindings,
  scanPackage,
} from '../../../scripts/lint/module-scope-state.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

/** A throwaway package directory holding the given `src/` files. */
const tempPackages: string[] = [];
function packageWithFiles(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'module-scope-state-'));
  tempPackages.push(dir);
  fs.mkdirSync(path.join(dir, 'src'));
  for (const [name, source] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, 'src', name), source);
  }
  return dir;
}

/** The common case: one `src/state.ts`. */
function packageWith(source: string): string {
  return packageWithFiles({ 'state.ts': source });
}

afterEach(() => {
  for (const dir of tempPackages.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Every published world package. Discovered rather than listed so a new world
 * is covered the day it is added. The point of the rule is the packages
 * nobody has thought about yet. Private packages (`@workflow/world-sim`) are
 * out of scope: they are never bundled into a host application.
 */
function publishedWorldPackages(): string[] {
  const packages = path.join(repoRoot, 'packages');
  return fs
    .readdirSync(packages)
    .filter((name) => name.startsWith('world-'))
    .map((name) => path.join(packages, name))
    .filter((dir) => {
      const manifest = path.join(dir, 'package.json');
      if (!fs.existsSync(manifest)) return false;
      return !JSON.parse(fs.readFileSync(manifest, 'utf8')).private;
    });
}

describe('module-scope state rule', () => {
  const worlds = publishedWorldPackages();

  it('finds the world packages to check', () => {
    // Guards the sweep below against silently checking nothing.
    expect(worlds.map((dir) => path.basename(dir))).toEqual(
      expect.arrayContaining(['world-local', 'world-vercel'])
    );
  });

  it.each(worlds)('reports nothing for %s', (dir) => {
    const findings = scanPackage(dir, repoRoot);
    expect(findings, formatFindings(findings)).toEqual([]);
  });

  it('flags a module-scope Map that is written to', () => {
    const dir = packageWith(
      [
        'const transports = new Map<string, number>();',
        'export function open(id: string) {',
        '  transports.set(id, 1);',
        '}',
        '',
      ].join('\n')
    );
    expect(scanPackage(dir, dir)).toMatchObject([
      { name: 'transports', keyword: 'const', reason: '`.set()`' },
    ]);
  });

  it('flags a module-scope `let` that is reassigned', () => {
    const dir = packageWith(
      [
        'let started = false;',
        'export function start() {',
        '  started = true;',
        '}',
        '',
      ].join('\n')
    );
    expect(scanPackage(dir, dir)).toMatchObject([
      { name: 'started', keyword: 'let', reason: 'reassigned' },
    ]);
  });

  it('flags a field written through a member chain', () => {
    const dir = packageWith(
      [
        'const state = { count: 0 };',
        'export function bump() {',
        '  state.count += 1;',
        '}',
        '',
      ].join('\n')
    );
    expect(scanPackage(dir, dir)).toMatchObject([
      { name: 'state', reason: 'field written' },
    ]);
  });

  it('ignores module-scope state that never changes', () => {
    const dir = packageWith(
      [
        'const LIMIT = 10;',
        'const NAMES = new Set(["a"]);',
        'export const total = () => LIMIT + NAMES.size;',
        '',
      ].join('\n')
    );
    expect(scanPackage(dir, dir)).toEqual([]);
  });

  it('accepts state parked on globalThis by globalSingleton()', () => {
    const dir = packageWith(
      [
        "import { globalSingleton } from '@workflow/utils';",
        "const state = globalSingleton('pkg//transports', 1, () => ({",
        '  transports: new Map<string, number>(),',
        '}));',
        'export function open(id: string) {',
        '  state.transports.set(id, 1);',
        '}',
        '',
      ].join('\n')
    );
    expect(scanPackage(dir, dir)).toEqual([]);
  });

  it('accepts a declaration annotated `per-copy-ok:`', () => {
    const dir = packageWith(
      [
        '// per-copy-ok: reports what THIS copy sees, so once-per-copy is the point.',
        'let logged = false;',
        'export function warnOnce() {',
        '  logged = true;',
        '}',
        '',
      ].join('\n')
    );
    expect(scanPackage(dir, dir)).toEqual([]);
  });

  it('ignores a table filled once at module evaluation', () => {
    // Every copy computes the same bytes at init, so per-copy costs memory and
    // nothing else. Only a write that can happen later, per request, diverges.
    const dir = packageWith(
      [
        'const BASE64_LOOKUP = new Uint8Array(256);',
        'for (let i = 0; i < 64; i++) BASE64_LOOKUP[i] = i;',
        'export function decode(i: number) {',
        '  return BASE64_LOOKUP[i];',
        '}',
        '',
      ].join('\n')
    );
    expect(scanPackage(dir, dir)).toEqual([]);
  });

  it('accepts state hand-rolled onto globalThis, through an alias', () => {
    // The shape `docs/content/worlds/*/building-a-world.mdx` documents for
    // custom world authors, and the one `packages/core` already uses.
    const dir = packageWith(
      [
        'type WorldState = { locks: Map<string, Promise<void>> };',
        "const StateKey = Symbol.for('@your-org/world-foo//locks/v1');",
        'const store = globalThis as typeof globalThis &',
        '  Record<symbol, WorldState | undefined>;',
        'const state: WorldState = (store[StateKey] ??= { locks: new Map() });',
        'export function open(id: string) {',
        '  state.locks.set(id, Promise.resolve());',
        '}',
        '',
      ].join('\n')
    );
    expect(scanPackage(dir, dir)).toEqual([]);
  });

  it('flags a static class field, which is module state with a namespace', () => {
    const dir = packageWith(
      [
        'export class Registry {',
        '  static transports = new Map<string, number>();',
        '  static open(id: string) {',
        '    Registry.transports.set(id, 1);',
        '  }',
        '}',
        '',
      ].join('\n')
    );
    expect(scanPackage(dir, dir)).toMatchObject([
      { name: 'Registry.transports', keyword: 'static' },
    ]);
  });

  it('reports each static field on a class separately', () => {
    // Keyed `Class.field`, not by the class: keying on the bare class name let
    // the second static overwrite the first, so one of the two went unreported
    // and the survivor was labelled with the other one's mutation.
    const dir = packageWith(
      [
        'export class Registry {',
        '  static transports = new Map<string, number>();',
        '  static latch = false;',
        '  static open(id: string) {',
        '    Registry.transports.set(id, 1);',
        '  }',
        '  static mark() {',
        '    Registry.latch = true;',
        '  }',
        '}',
        '',
      ].join('\n')
    );
    expect(scanPackage(dir, dir)).toMatchObject([
      { name: 'Registry.transports', keyword: 'static', reason: '`.set()`' },
      { name: 'Registry.latch', keyword: 'static', reason: 'field written' },
    ]);
  });

  it('resolves `this` to the class inside a static member', () => {
    const dir = packageWith(
      [
        'export class Counters {',
        '  static hits = new Map<string, number>();',
        '  static bump(id: string) {',
        '    this.hits.set(id, 1);',
        '  }',
        '}',
        '',
      ].join('\n')
    );
    expect(scanPackage(dir, dir)).toMatchObject([
      { name: 'Counters.hits', keyword: 'static' },
    ]);
  });

  it('ignores an instance field, which is per-instance not per-copy', () => {
    const dir = packageWith(
      [
        'export class Session {',
        '  seen = new Map<string, number>();',
        '  mark(id: string) {',
        '    this.seen.set(id, 1);',
        '  }',
        '}',
        '',
      ].join('\n')
    );
    expect(scanPackage(dir, dir)).toEqual([]);
  });

  it('flags a field incremented with `++`, like one written with `+=`', () => {
    const dir = packageWith(
      [
        'const state = { count: 0 };',
        'export function bump() {',
        '  state.count++;',
        '}',
        '',
      ].join('\n')
    );
    expect(scanPackage(dir, dir)).toMatchObject([
      { name: 'state', reason: 'field written' },
    ]);
  });

  it('flags an exported empty collection filled from another file', () => {
    // The shipped bug's exact shape, with the registry and its mutators split
    // across files. A single-file walk cannot see the write, so the export plus
    // the empty initializer is the signal.
    const dir = packageWithFiles({
      'registry.ts': 'export const transports = new Map<string, number>();\n',
      'consumer.ts': [
        "import { transports } from './registry.js';",
        'export function open(id: string) {',
        '  transports.set(id, 1);',
        '}',
        '',
      ].join('\n'),
    });
    expect(scanPackage(dir, dir)).toMatchObject([
      { name: 'transports', reason: 'exported empty collection' },
    ]);
  });

  it('leaves a non-empty exported lookup table alone', () => {
    const dir = packageWith("export const LIMITS = new Map([['a', 1]]);\n");
    expect(scanPackage(dir, dir)).toEqual([]);
  });

  it('scans `.mts` sources', () => {
    // `@workflow/world-testing` is authored in `.mts`; while the walk was
    // `.ts`-only its entry in the sweep below passed vacuously.
    const dir = packageWithFiles({
      'state.mts': [
        'const counts = new Map<string, number>();',
        'export function bump(id: string) {',
        '  counts.set(id, 1);',
        '}',
        '',
      ].join('\n'),
    });
    expect(scanPackage(dir, dir)).toMatchObject([{ name: 'counts' }]);
  });

  it('does not accept a bare `per-copy-ok` with no reason', () => {
    const dir = packageWith(
      [
        '// per-copy-ok:',
        'let logged = false;',
        'export function warnOnce() {',
        '  logged = true;',
        '}',
        '',
      ].join('\n')
    );
    expect(scanPackage(dir, dir)).toMatchObject([{ name: 'logged' }]);
  });
});
