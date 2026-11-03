import { afterEach, describe, expect, test, vi } from 'vitest';
import { createWorld } from '../src/index.js';

// `createWorld()`'s default configuration reads WORKFLOW_POSTGRES_ENQUEUE_ONLY,
// and an enqueue-only World logs one line when it is created. Creating and
// closing a World opens no connection, so this needs no database.
describe('WORKFLOW_POSTGRES_ENQUEUE_ONLY', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const logsEnqueueOnly = async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const world = createWorld();
    await world.close?.();
    return warn.mock.calls.some(([message]) =>
      String(message).includes('Enqueue-only')
    );
  };

  test.each([
    '1',
    'true',
    'TRUE',
    ' True ',
  ])('%j turns it on', async (value) => {
    vi.stubEnv('WORKFLOW_POSTGRES_ENQUEUE_ONLY', value);
    expect(await logsEnqueueOnly()).toBe(true);
  });

  test.each(['0', 'false', '', 'yes'])('%j leaves it off', async (value) => {
    vi.stubEnv('WORKFLOW_POSTGRES_ENQUEUE_ONLY', value);
    expect(await logsEnqueueOnly()).toBe(false);
  });

  // A CLI run with `--json` (the e2e harness's `wf inspect --json`) prints
  // its result to stdout and parses it back, so the line must not go there.
  test('logs to stderr, never stdout', async () => {
    vi.stubEnv('WORKFLOW_POSTGRES_ENQUEUE_ONLY', '1');
    const stdout = vi.spyOn(process.stdout, 'write');
    const info = vi.spyOn(console, 'info');
    const log = vi.spyOn(console, 'log');
    expect(await logsEnqueueOnly()).toBe(true);
    const written = [
      ...stdout.mock.calls.map(([chunk]) => String(chunk)),
      ...info.mock.calls.map(([message]) => String(message)),
      ...log.mock.calls.map(([message]) => String(message)),
    ];
    expect(written.some((line) => line.includes('Enqueue-only'))).toBe(false);
  });

  test('is off when unset', async () => {
    vi.stubEnv('WORKFLOW_POSTGRES_ENQUEUE_ONLY', undefined);
    expect(await logsEnqueueOnly()).toBe(false);
  });
});
