/**
 * End-to-end tests of the Durable Objects World under local `wrangler dev`
 * (workerd + local Durable Object storage). Run with `pnpm test:poc`.
 *
 * Crash recovery is tested by killing the whole `wrangler dev` process group
 * (the isolate and every object instance die with it) and starting it again
 * on the same persisted state.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DevServer, startDev } from './wrangler.js';

const port = 8700 + Math.floor(Math.random() * 200);
const persistTo = mkdtempSync(join(tmpdir(), 'wf-cf-poc-'));
let server: DevServer;

interface LoggedEvent {
  eventId: string;
  eventType: string;
  correlationId?: string;
  createdAt: string;
}

async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${server.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json()) as T;
  if (!response.ok) {
    throw new Error(`${path} -> ${response.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function start(workflow: string, args: unknown[]): Promise<string> {
  return (await api<{ runId: string }>('/start', { workflow, args })).runId;
}

async function result(runId: string, waitMs = 30_000) {
  return api<{ status: string; value?: unknown }>(
    `/runs/${runId}?wait=${waitMs}`
  );
}

async function events(runId: string) {
  return api<LoggedEvent[]>(`/runs/${runId}/events`);
}

/** The log is dense from slot 1 and its timestamps never go backwards. */
function expectWellFormedLog(log: LoggedEvent[]) {
  log.forEach((event, index) => {
    expect(event.eventId).toBe(`evnt_${String(index + 1).padStart(26, '0')}`);
    if (index > 0) {
      expect(Date.parse(event.createdAt)).toBeGreaterThanOrEqual(
        Date.parse(log[index - 1].createdAt)
      );
    }
  });
}

const types = (log: LoggedEvent[]) => log.map((e) => e.eventType);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  server = await startDev(port, persistTo);
});

afterAll(async () => {
  await server?.stop();
  rmSync(persistTo, { recursive: true, force: true });
});

describe('Durable Objects World (local workerd)', () => {
  it('runs sequential steps', async () => {
    const runId = await start('addition', [2, 3]);
    expect(await result(runId)).toEqual({ status: 'completed', value: 15 });
    const log = await events(runId);
    expectWellFormedLog(log);
    expect(types(log)).toEqual([
      'run_created',
      'run_started',
      'step_created',
      'step_started',
      'step_completed',
      'step_created',
      'step_started',
      'step_completed',
      'run_completed',
    ]);
  });

  it('fans out steps, overflow running outside the run object', async () => {
    const runId = await start('fanOut', [8]);
    expect(await result(runId)).toEqual({ status: 'completed', value: 36 });
    const log = await events(runId);
    expectWellFormedLog(log);
    expect(log.filter((e) => e.eventType === 'step_completed')).toHaveLength(8);
  });

  it('sleeps on a durable timer', async () => {
    const runId = await start('sleeper', [2]);
    expect(await result(runId)).toEqual({ status: 'completed', value: 2 });
    const log = await events(runId);
    expectWellFormedLog(log);
    const at = (type: string) =>
      Date.parse(log.find((e) => e.eventType === type)?.createdAt ?? '');
    expect(at('wait_completed') - at('wait_created')).toBeGreaterThanOrEqual(
      1900
    );
  });

  it('lets sleep win a race against a slower inline step', async () => {
    const runId = await start('race', [4000, 1]);
    expect(await result(runId)).toEqual({
      status: 'completed',
      value: 'sleep',
    });
    const log = await events(runId);
    expectWellFormedLog(log);
    // The timer fired while the step body was still running.
    expect(types(log).indexOf('wait_completed')).toBeLessThan(
      types(log).indexOf('step_completed')
    );
  });

  it('lets a faster step win a race against sleep', async () => {
    const runId = await start('race', [200, 20]);
    expect(await result(runId)).toEqual({ status: 'completed', value: 'step' });
  });

  it('retries a failing step', async () => {
    const runId = await start('retrying', [2]);
    expect(await result(runId)).toEqual({
      status: 'completed',
      value: 'ok on attempt 3',
    });
  });

  it('streams from a step', async () => {
    const runId = await start('streaming', [3]);
    expect(await result(runId)).toEqual({ status: 'completed', value: 3 });
    expect(await api(`/runs/${runId}/stream`)).toEqual({
      text: 'line 0\nline 1\nline 2\n',
    });
  });

  it('resumes a hook and enforces token ownership across runs', async () => {
    const token = `tok-${Date.now()}`;
    const first = await start('waitForHook', [token]);
    await sleep(1000);
    const second = await start('waitForHook', [token]);
    const secondResult = await result(second);
    expect(secondResult.status).toBe('failed');
    expect(JSON.stringify(secondResult.value)).toContain('already in use');

    expect(await api(`/hooks/${token}`, { value: 41 })).toEqual({
      runId: first,
    });
    expect(await result(first)).toEqual({ status: 'completed', value: 42 });

    // The finished run no longer holds the token.
    const third = await start('waitForHook', [token]);
    await sleep(1000);
    expect(await api(`/hooks/${token}`, { value: 9 })).toEqual({
      runId: third,
    });
    expect(await result(third)).toEqual({ status: 'completed', value: 10 });
  });

  it('accepts a hook payload while a step runs inline', async () => {
    const token = `tok-step-${Date.now()}`;
    const runId = await start('hookDuringStep', [token]);
    await sleep(1000);
    expect(await api(`/hooks/${token}`, { value: 7 })).toEqual({ runId });
    expect(await result(runId)).toEqual({
      status: 'completed',
      value: 'step:7',
    });
    const log = types(await events(runId));
    // Recorded while the step body was still running.
    expect(log.indexOf('hook_received')).toBeLessThan(
      log.indexOf('step_completed')
    );
  });

  it('answers a health check through the queue', async () => {
    const health = await api('/health');
    expect(health).toMatchObject({ healthy: true });
  });

  it('snapshots the VM while it waits and drops the snapshot at the end', async () => {
    const runId = await start('snapshotted', [6, 3]);
    await sleep(1500);
    const waiting = await api(`/runs/${runId}/debug`);
    expect(waiting.snapshot).toMatchObject({ eventCount: waiting.events });
    expect(await result(runId)).toEqual({ status: 'completed', value: 1015 });
    expect((await api(`/runs/${runId}/debug`)).snapshot).toBeNull();
  });

  it('restores a snapshot after the isolate dies mid-sleep', async () => {
    const runId = await start('snapshotted', [6, 4]);
    await sleep(1500);
    expect((await api(`/runs/${runId}/debug`)).snapshot).not.toBeNull();
    await server.stop();
    server = await startDev(port, persistTo);
    expect(await result(runId, 60_000)).toEqual({
      status: 'completed',
      value: 1015,
    });
    expectWellFormedLog(await events(runId));
  });

  it('recovers a run whose isolate died mid-sleep', async () => {
    const runId = await start('sleeper', [4]);
    await sleep(1500);
    await server.stop();
    server = await startDev(port, persistTo);
    expect(await result(runId, 60_000)).toEqual({
      status: 'completed',
      value: 2,
    });
    expectWellFormedLog(await events(runId));
  });

  it('recovers a run whose isolate died mid-step', async () => {
    const runId = await start('race', [3000, 40]);
    await sleep(1500);
    await server.stop();
    server = await startDev(port, persistTo);
    // The step is re-executed by the redelivery and still beats the timer.
    expect(await result(runId, 60_000)).toEqual({
      status: 'completed',
      value: 'step',
    });
    const log = await events(runId);
    expectWellFormedLog(log);
    expect(log.filter((e) => e.eventType === 'step_started').length).toBe(2);
  });
});
