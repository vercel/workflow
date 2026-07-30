import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runScopedKey } from './idempotency-key.js';

const CORE_SRC = fileURLToPath(new URL('..', import.meta.url));

/**
 * Expressions allowed as the value of an `idempotencyKey:` property in core:
 * the two run-scoping builders, or a type declaration.
 */
const RUN_SCOPED_VALUE =
  /^\s*(string;|runScopedKey\(|backstopIdempotencyKey\()/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!entry.name.endsWith('.ts')) return [];
    if (entry.name.endsWith('.test.ts')) return [];
    return [path];
  });
}

/** Every place the file assigns an `idempotencyKey`, with the value assigned. */
function keySites(
  file: string,
  lines: string[]
): Array<{ at: string; value: string }> {
  const PROPERTY = 'idempotencyKey:';
  return lines.flatMap((line, index) => {
    const at = line.indexOf(PROPERTY);
    const trimmed = line.trim();
    if (at === -1 || trimmed.startsWith('//') || trimmed.startsWith('*')) {
      return [];
    }
    // The value may sit on the following line when the formatter wraps it.
    const sameLine = line.slice(at + PROPERTY.length);
    return [
      {
        at: `${relative(CORE_SRC, file)}:${index + 1}: ${trimmed}`,
        value: sameLine.trim() ? sameLine : (lines[index + 1] ?? ''),
      },
    ];
  });
}

describe('runScopedKey', () => {
  it('prefixes the run and joins parts with colons', () => {
    expect(runScopedKey('wrun_1', 'step_2', 'backstop')).toBe(
      'wrun_1:step_2:backstop'
    );
  });

  it('separates runs sharing a correlation id', () => {
    // The whole point: under slot identity the first step of every run of a
    // workflow is `step_…001`, and the queue those messages are sent to is
    // shared by every run of that workflow.
    expect(runScopedKey('wrun_a', 'step_001')).not.toBe(
      runScopedKey('wrun_b', 'step_001')
    );
  });
});

describe('queue idempotency keys', () => {
  /**
   * A key that is not run-scoped is dropped silently by the world's dedupe for
   * the length of its retention window (24h on Vercel Queues): the send is
   * answered normally, no callback is dispatched, and the step is never
   * executed. There is no error to find afterwards, so the only defence is that
   * no site produces a key any other way.
   */
  it('are all produced by the run-scoping builders', () => {
    const sites = sourceFiles(CORE_SRC).flatMap((file) =>
      keySites(file, readFileSync(file, 'utf8').split('\n'))
    );

    expect(sites.filter((site) => !RUN_SCOPED_VALUE.test(site.value))).toEqual(
      []
    );
    // Guard the scan itself: a pattern that matches nothing would pass above.
    expect(sites.length).toBeGreaterThanOrEqual(4);
  });
});
