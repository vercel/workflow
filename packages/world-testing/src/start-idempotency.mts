import { hydrateWorkflowReturnValue } from '@workflow/core/serialization';
import { expect, type TestContext, test, vi } from 'vitest';
import { createFetcher, startServer } from './util.mjs';

type Fetcher = ReturnType<typeof createFetcher>;

const FILE = 'workflows/start-idempotency.ts';

const newKey = (label: string) =>
  `idem-${label}-${Math.random().toString(36).slice(2)}`;

/** Start a server for this World, or skip when it does not support keys. */
async function keyedServer(world: string, ctx: TestContext): Promise<Fetcher> {
  const server = await startServer({ world }).then(createFetcher);
  if ((await server.getCapabilities()).runIdempotencyKeys !== true) {
    ctx.skip(
      'run idempotency keys unavailable: the World does not declare capabilities.runIdempotencyKeys'
    );
  }
  return server;
}

const awaitStatus = (server: Fetcher, runId: string, status: string) =>
  vi.waitFor(
    async () => {
      const run = await server.getRun(runId);
      expect(run.status).toBe(status);
      return run;
    },
    { interval: 200, timeout: 20_000 }
  );

const outputOf = (run: { output?: unknown; runId: string }) =>
  hydrateWorkflowReturnValue(run.output!, run.runId, undefined);

/**
 * `start({ experimental_idempotencyKey })` end to end against the World under
 * test (`WorldCapabilities.runIdempotencyKeys`). Skipped for a World that
 * does not declare the capability. The storage-level contract, including the
 * full policy matrix, is `@workflow/world`'s run idempotency conformance
 * suite; this checks what `start()` makes of it.
 */
export function startIdempotency(world: string) {
  test(
    'concurrent keyed starts converge on one run, created exactly once',
    { timeout: 60_000 },
    async (ctx) => {
      const server = await keyedServer(world, ctx);
      const key = newKey('concurrent');

      const outcomes = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          server.invokeKeyed(FILE, 'keyedEcho', [`caller-${i}`], { key })
        )
      );

      const runs = outcomes.map((outcome) => {
        if (outcome.refused) throw new Error('unexpected refusal');
        return outcome;
      });
      expect(new Set(runs.map((run) => run.runId)).size).toBe(1);
      expect(runs.filter((run) => run.started === true)).toHaveLength(1);
      expect(runs.filter((run) => run.started === false)).toHaveLength(9);

      // The creator's arguments win.
      const winner = runs.findIndex((run) => run.started === true);
      const run = await awaitStatus(server, runs[0].runId, 'completed');
      expect(run.idempotencyKey).toBe(key);
      expect(await outputOf(run)).toBe(`caller-${winner}`);
    }
  );

  test(
    'a keyed restart after completion returns the same run; ALLOW_DUPLICATE starts a new one',
    { timeout: 60_000 },
    async (ctx) => {
      const server = await keyedServer(world, ctx);
      const key = newKey('restart');

      const first = await server.invokeKeyed(FILE, 'keyedEcho', ['first'], {
        key,
      });
      if (first.refused) throw new Error('unexpected refusal');
      expect(first.started).toBe(true);
      await awaitStatus(server, first.runId, 'completed');

      const again = await server.invokeKeyed(FILE, 'keyedEcho', ['second'], {
        key,
      });
      expect(again).toEqual({
        refused: false,
        runId: first.runId,
        started: false,
      });

      const duplicate = await server.invokeKeyed(FILE, 'keyedEcho', ['third'], {
        key,
        reusePolicy: 'ALLOW_DUPLICATE',
      });
      if (duplicate.refused) throw new Error('unexpected refusal');
      expect(duplicate.runId).not.toBe(first.runId);
      expect(duplicate.started).toBe(true);
      const run = await awaitStatus(server, duplicate.runId, 'completed');
      expect(await outputOf(run)).toBe('third');
    }
  );

  test(
    'FAIL against a running holder is refused, from a caller and from workflow code',
    { timeout: 60_000 },
    async (ctx) => {
      const server = await keyedServer(world, ctx);
      const key = newKey('fail');
      const token = newKey('token');

      const holder = await server.invokeKeyed(FILE, 'keyedHold', [token], {
        key,
      });
      if (holder.refused) throw new Error('unexpected refusal');
      await awaitStatus(server, holder.runId, 'running');

      const refused = await server.invokeKeyed(
        FILE,
        'keyedHold',
        [newKey('other')],
        { key, conflictPolicy: 'FAIL' }
      );
      expect(refused).toEqual({
        refused: true,
        name: 'WorkflowRunAlreadyStartedError',
        runId: holder.runId,
        runStatus: 'running',
      });

      // The same refusal, raised by start() inside a step and caught by the
      // workflow that called it.
      const { runId: callerRunId } = await server.invoke(
        FILE,
        'keyedFailFromWorkflow',
        [key]
      );
      const caller = await awaitStatus(server, callerRunId, 'completed');
      expect(await outputOf(caller)).toEqual({
        refused: true,
        runId: holder.runId,
      });

      await server.resumeHook(token, { done: true } as never);
      await awaitStatus(server, holder.runId, 'completed');
    }
  );
}
