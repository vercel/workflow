import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '@oclif/core';
import { SPEC_VERSION_CURRENT, type World } from '@workflow/world';
import { createWorld } from '@workflow/world-local';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setJsonMode } from '../lib/config/log.js';

const state = vi.hoisted(() => ({
  world: null as World | null,
  setupCliWorld: vi.fn(),
}));

// The command runs against a real world-local World over a temporary data
// directory; only the backend discovery (env inference, auth) is replaced.
vi.mock('../lib/inspect/setup.js', () => ({
  setupCliWorld: state.setupCliWorld,
}));

const { default: Inspect } = await import('./inspect.js');

const WORKFLOW = 'workflow//./src/workflows/order//processOrder';
const CHARGE = 'step//./src/workflows/order//chargeCard';
const EMAIL = 'step//./src/workflows/order//sendEmail';

let dataDir: string;
let world: World;

beforeEach(() => {
  vi.stubEnv('WORKFLOW_LOCAL_SQLITE_KEEP_CONNECTIONS', '1');
  dataDir = mkdtempSync(path.join(tmpdir(), 'inspect-usage-'));
  world = createWorld({ dataDir });
  state.world = world;
  state.setupCliWorld.mockReset().mockImplementation(async (flags) => {
    setJsonMode(Boolean(flags.json));
    return state.world;
  });
  process.exitCode = 0;
});

afterEach(async () => {
  setJsonMode(false);
  await world.close?.();
  rmSync(dataDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const bytes = (n: number) => new Uint8Array(n).fill(7);

async function create(
  runId: string | null,
  event: Record<string, unknown>
): Promise<Awaited<ReturnType<World['events']['create']>>> {
  return world.events.create(runId, {
    specVersion: SPEC_VERSION_CURRENT,
    ...event,
  } as never);
}

async function step(runId: string, stepId: string, stepName: string) {
  await create(runId, {
    eventType: 'step_created',
    correlationId: stepId,
    eventData: { stepName, input: bytes(8) },
  });
  await create(runId, { eventType: 'step_started', correlationId: stepId });
}

/**
 * A finished run with one retried step, several step names, a hook and a
 * stream: every row of the summary has something in it.
 */
async function seedRun(): Promise<string> {
  const { run } = await create(null, {
    eventType: 'run_created',
    eventData: {
      deploymentId: 'dpl_test',
      workflowName: WORKFLOW,
      input: bytes(16),
    },
  });
  const runId = run!.runId;
  await create(runId, { eventType: 'run_started' });

  await step(runId, 'step_charge', CHARGE);
  await create(runId, {
    eventType: 'step_retrying',
    correlationId: 'step_charge',
    eventData: { error: bytes(8) },
  });
  await create(runId, {
    eventType: 'step_started',
    correlationId: 'step_charge',
  });
  await create(runId, {
    eventType: 'step_completed',
    correlationId: 'step_charge',
    eventData: { result: bytes(8) },
  });
  for (let i = 0; i < 3; i++) {
    await step(runId, `step_email_${i}`, EMAIL);
    await create(runId, {
      eventType: 'step_completed',
      correlationId: `step_email_${i}`,
      eventData: { result: bytes(8) },
    });
  }
  for (let i = 0; i < 6; i++) {
    const name = `step//./src/workflows/order//audit${i}`;
    await step(runId, `step_audit_${i}`, name);
    await create(runId, {
      eventType: 'step_completed',
      correlationId: `step_audit_${i}`,
      eventData: { result: bytes(8) },
    });
  }
  await create(runId, {
    eventType: 'hook_created',
    correlationId: 'hook_1',
    eventData: { token: 'approve-order', metadata: bytes(8) },
  });
  await create(runId, {
    eventType: 'hook_received',
    correlationId: 'hook_1',
    eventData: { payload: bytes(32) },
  });
  await world.streams.write(runId, 'strm_progress', bytes(2048));
  await world.streams.close(runId, 'strm_progress');
  await create(runId, {
    eventType: 'run_completed',
    eventData: { output: bytes(4) },
  });
  return runId;
}

/** Runs the command, returning what it wrote to stdout. */
async function runInspect(argv: string[]) {
  const config = await Config.load(
    fileURLToPath(new URL('../..', import.meta.url))
  );
  const out: string[] = [];
  const err: string[] = [];
  const logged: unknown[][] = [];
  vi.spyOn(console, 'log').mockImplementation((...args) => {
    logged.push(args);
    out.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args) => {
    err.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  // Recorded, not replaced: a replaced stdout stalls oclif's teardown.
  const write = vi.spyOn(process.stdout, 'write');
  const exit = vi
    .spyOn(process, 'exit')
    .mockImplementation((() => undefined) as never);
  try {
    await Inspect.run(argv, config).catch(() => undefined);
  } finally {
    exit.mockRestore();
  }
  const calls = write.mock.calls.slice();
  write.mockRestore();
  for (const [chunk] of calls) {
    if (chunk !== '') out.push(String(chunk));
  }
  return { stdout: out.join('\n'), stderr: err.join('\n'), logged };
}

const normalize = (text: string, runId: string) =>
  text.replaceAll(runId, 'wrun_<RUN_ID>');

describe('workflow inspect run <id> --usage', () => {
  it('prints a readable summary', async () => {
    const runId = await seedRun();
    const { stdout } = await runInspect([
      'run',
      runId,
      '--usage',
      '--backend',
      'local',
    ]);
    expect(normalize(stdout, runId)).toMatchSnapshot();
  });

  it('prints the usage shape as JSON with --json', async () => {
    const runId = await seedRun();
    const { stdout } = await runInspect([
      'run',
      runId,
      '--usage',
      '--json',
      '--backend',
      'local',
    ]);
    const usage = JSON.parse(stdout);
    // The same numbers the World computed, and so the same the UI shows.
    expect(usage).toEqual(
      JSON.parse(JSON.stringify(await world.experimental_usage!.getRun(runId)))
    );
    expect(usage).toMatchObject({
      // run 3, chargeCard 3 + 2 for its retry, sendEmail 3 × 3,
      // audit0..5 6 × 3, hook 2.
      events: 3 + 5 + 9 + 18 + 2,
      billableEvents: 37,
      retries: { count: 1, events: 2 },
    });
    expect(JSON.parse(normalize(stdout, runId))).toMatchSnapshot();
  });

  it('fails on a run the backend does not have', async () => {
    const { stderr } = await runInspect([
      'run',
      'wrun_01K4BZQ5T2J8HXFM6WD3PNAVCE',
      '--usage',
      '--backend',
      'local',
    ]);
    expect(stderr).toContain('wrun_01K4BZQ5T2J8HXFM6WD3PNAVCE');
  });

  it('fails on a backend without usage instead of printing the run', async () => {
    const runId = await seedRun();
    const { experimental_usage: _omit, ...withoutUsage } = world;
    state.world = withoutUsage as World;
    const getRun = vi.spyOn(world.runs, 'get');
    const { stdout, stderr } = await runInspect(['run', runId, '--usage']);
    expect(stderr).toContain('only available for the local backend');
    expect(stdout).toBe('');
    expect(getRun).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it.each([
    [['runs', '--usage'], 'shows one run'],
    [
      ['steps', '--runId', 'wrun_01K4BZQ5T2J8HXFM6WD3PNAVCE', '--usage'],
      'shows one run',
    ],
    [
      ['run', 'wrun_01K4BZQ5T2J8HXFM6WD3PNAVCE', '--usage', '--web'],
      'cannot be forwarded',
    ],
    [
      ['run', 'wrun_01K4BZQ5T2J8HXFM6WD3PNAVCE', '--usage', '--withData'],
      'not payloads',
    ],
  ])('rejects %j before any backend setup', async (argv, message) => {
    const errors: string[] = [];
    vi.spyOn(
      Inspect.prototype as unknown as Record<string, (m: string) => void>,
      'logError'
    ).mockImplementation((m: string) => {
      errors.push(m);
    });
    await runInspect(argv);
    expect(errors.join('\n')).toContain(message);
    expect(state.setupCliWorld).not.toHaveBeenCalled();
  });
});

describe('default output is unchanged', () => {
  it('`inspect run <id>` prints the run, not its usage', async () => {
    const runId = await seedRun();
    const usage = vi.spyOn(world.experimental_usage!, 'getRun');
    const { stdout } = await runInspect([
      'run',
      runId,
      '--json',
      '--backend',
      'local',
    ]);
    expect(usage).not.toHaveBeenCalled();
    const printed = JSON.parse(stdout);
    expect(printed).toMatchObject({
      runId,
      status: 'completed',
      workflowName: WORKFLOW,
    });
    expect(printed).not.toHaveProperty('events');
    expect(printed).not.toHaveProperty('eventsBySpan');
  });

  it('`inspect run <id>` without --json logs the run object, as before', async () => {
    const runId = await seedRun();
    const usage = vi.spyOn(world.experimental_usage!, 'getRun');
    const { logged } = await runInspect(['run', runId, '--backend', 'local']);
    expect(usage).not.toHaveBeenCalled();
    // One log call carrying the run itself, exactly as `showRun` printed it
    // before `--usage` existed.
    expect(logged).toHaveLength(1);
    const [printed] = logged[0] as [Record<string, unknown>];
    expect(printed).toMatchObject({
      runId,
      status: 'completed',
      workflowName: WORKFLOW,
    });
    for (const key of ['events', 'billableEvents', 'eventsBySpan']) {
      expect(printed).not.toHaveProperty(key);
    }
  });
});
