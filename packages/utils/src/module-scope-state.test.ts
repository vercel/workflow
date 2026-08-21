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

/** A throwaway package directory holding a single `src/state.ts`. */
const tempPackages: string[] = [];
function packageWith(source: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'module-scope-state-'));
  tempPackages.push(dir);
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'state.ts'), source);
  return dir;
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
