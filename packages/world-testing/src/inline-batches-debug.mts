import { expect, test, vi } from 'vitest';
import { hydrateWorkflowReturnValue } from '@workflow/core/serialization';
import { createFetcher, startServer } from './util.mjs';

/**
 * Instrumented test: runs `threeBatchesOfFiveWorkflow` with
 * DEBUG=workflow:runtime:* and prints a summary of V2 handler behavior:
 *   - total flow invocations
 *   - per-invocation replay iterations
 *   - event loads (full vs incremental) and sizes
 *   - redundant/skipped step executions
 *   - concurrent "all parallel steps done" replay races
 *   - unconsumed-event skips
 *
 * Not part of the default suite; run with:
 *   pnpm vitest run packages/world-testing/test/inline-batches-debug.test.ts
 */
export function inlineBatchesDebug(world: string) {
  test(
    'three batches of five parallel steps — report V2 handler behavior',
    { timeout: 60_000 },
    async () => {
      const server = await startServer({
        world,
        env: {
          DEBUG: 'workflow:runtime:*',
        },
      });
      const client = createFetcher(server);

      const result = await client.invoke(
        'workflows/inline-execution.ts',
        'threeBatchesOfFiveWorkflow',
        []
      );

      const run = await vi.waitFor(
        async () => {
          const run = await client.getRun(result.runId);
          expect(run.status).toBe('completed');
          return run;
        },
        { interval: 200, timeout: 59_000 }
      );

      const output = await hydrateWorkflowReturnValue(
        run.output!,
        run.runId,
        undefined
      );
      // Expected output: 3 batches × [11, 21, 31, 41, 51] | [12, 22, ...] | ...
      expect(output).toEqual([
        11, 21, 31, 41, 51, 12, 22, 32, 42, 52, 13, 23, 33, 43, 53,
      ]);

      const flowInvocations = await client.getFlowInvocationCount(result.runId);

      // Wait a short moment to flush late log lines
      await new Promise((r) => setTimeout(r, 500));
      const logs = server.getOutput();

      // --- Parse log lines ---

      // 1) Replay iterations + the `eventCount` passed into each replay.
      // The runtime logs: "Starting workflow replay" with `eventCount: N`.
      const replayEventCounts: number[] = [];
      for (const line of logs.split('\n')) {
        if (!line.includes(result.runId)) continue;
        if (!line.includes('Starting workflow replay')) continue;
      }
      // eventCount is often on the next line in a multi-line object literal
      // (console.debug prints the second argument with util.inspect). Pull all
      // eventCount occurrences that are within ~6 lines of a replay start
      // line referencing this runId.
      const lines = logs.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i]!.includes('Starting workflow replay')) continue;
        // find the runId in the surrounding 8 lines
        const window = lines.slice(i, i + 8).join('\n');
        if (!window.includes(result.runId)) continue;
        const m = window.match(/eventCount:\s*(\d+)/);
        if (m) replayEventCounts.push(Number.parseInt(m[1]!, 10));
      }
      const replayStarts = replayEventCounts.length;

      // 3) "All parallel steps done, replaying inline" (per-run)
      const allDoneInlineReplays = matchCount(
        logs,
        /All parallel steps done, replaying inline/g,
        result.runId
      );

      // 4) "Background step done but other steps pending" (per-run)
      const backgroundStepPendingReturns = matchCount(
        logs,
        /Background step done but other steps pending/g,
        result.runId
      );

      // 5) Step skipped because step was already in terminal state
      // (background handler arrived after inline path already completed it).
      // This is emitted from the step_started conflict path in step-executor.ts
      // ("Step in terminal state, skipping"). The step_completed 409 path
      // ("Tried completing step, but step has already finished") fires only
      // when two handlers both ran the step body concurrently.
      const stepsSkippedAlreadyDone = matchCount(
        logs,
        /Step in terminal state, skipping/g,
        result.runId
      );
      const stepCompletedRaces = matchCount(
        logs,
        /Tried completing step, but step has already finished/g,
        result.runId
      );

      // 6) Unconsumed event skips (debug message emitted by workflow.ts skip logic)
      const unconsumedEventSkips = matchCount(
        logs,
        /Skipping unconsumed step event/g,
        result.runId
      );

      // 7) Hook/step started with already-running: via concurrent handler
      const maxDeliveries = matchCount(logs, /Max retries reached/g);

      console.log('\n====================================');
      console.log('V2 handler behavior — 3 batches × 5 steps');
      console.log('====================================');
      console.log(`Flow handler invocations: ${flowInvocations}`);
      console.log(`Replay iterations (total): ${replayStarts}`);
      console.log(`Event counts per replay: [${replayEventCounts.join(', ')}]`);
      console.log(
        `"All steps done, replay inline" hits: ${allDoneInlineReplays}`
      );
      console.log(
        `"Background step pending, return" hits: ${backgroundStepPendingReturns}`
      );
      console.log(
        `Step skipped (already terminal, step_started 409): ${stepsSkippedAlreadyDone}`
      );
      console.log(
        `Step body ran twice (step_completed 409):           ${stepCompletedRaces}`
      );
      console.log(
        `Unconsumed events skipped by consumer: ${unconsumedEventSkips}`
      );
      console.log(`Max retries reached (bad): ${maxDeliveries}`);
      console.log('====================================\n');

      // Also print the key timeline: one line per "significant" runtime
      // debug event, in order. Many debug lines put the runId in the
      // metadata object on a following line, so look at a small forward
      // window around each match.
      const timeline: string[] = [];
      const sigRegex =
        /Starting workflow replay|All parallel steps done|Background step done but|Workflow suspended|Workflow replay completed|Run already finished, skipping background step|Step in terminal state|Tried completing step|Max retries reached|Skipping unconsumed step event/;
      for (let i = 0; i < lines.length; i++) {
        if (!sigRegex.test(lines[i]!)) continue;
        const window = lines.slice(i, i + 8).join('\n');
        if (!window.includes(result.runId)) continue;
        timeline.push(lines[i]!);
      }
      console.log('--- Timeline (runtime debug events for this run) ---');
      for (const line of timeline) {
        const short = line.replace(/\s+/g, ' ').slice(0, 180);
        console.log(short);
      }
      console.log(`Timeline entries: ${timeline.length}`);
      console.log('----------------------------------------------------\n');

      // Raw counts — total occurrences in the whole log regardless of runId
      // (for sanity-checking the windowed matcher above).
      const rawUnconsumed = (
        logs.match(/Skipping unconsumed step event/g) || []
      ).length;
      const rawAllDone = (
        logs.match(/All parallel steps done, replaying inline/g) || []
      ).length;
      const rawPending = (
        logs.match(/Background step done but other steps pending/g) || []
      ).length;
      const rawTerminal = (
        logs.match(/Step in terminal state, skipping/g) || []
      ).length;
      const rawCompleted409 = (
        logs.match(/Tried completing step, but step has already finished/g) ||
        []
      ).length;
      console.log('--- Raw counts (no runId filter) ---');
      console.log(`Skipping unconsumed step event: ${rawUnconsumed}`);
      console.log(`All parallel steps done, replaying inline: ${rawAllDone}`);
      console.log(
        `Background step done but other steps pending: ${rawPending}`
      );
      console.log(`Step in terminal state, skipping: ${rawTerminal}`);
      console.log(
        `Tried completing step, but step has already finished: ${rawCompleted409}`
      );
      console.log('-------------------------------------\n');

      // Breakdown of unconsumed event types. The log format emits the
      // message on one line and the metadata object (eventType,
      // correlationId) on the following lines. Walk a 12-line window after
      // each match and extract the fields.
      const skippedByEventType = new Map<string, number>();
      const skippedEvents: { eventType: string; correlationId: string }[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i]!.includes('Skipping unconsumed step event')) continue;
        const window = lines.slice(i, i + 12).join('\n');
        const et = window.match(/eventType:\s*'([^']+)'/);
        const cid = window.match(/correlationId:\s*'([^']+)'/);
        if (et && cid) {
          skippedByEventType.set(
            et[1]!,
            (skippedByEventType.get(et[1]!) ?? 0) + 1
          );
          skippedEvents.push({ eventType: et[1]!, correlationId: cid[1]! });
        }
      }
      console.log('--- Unconsumed event type breakdown ---');
      for (const [eventType, count] of skippedByEventType) {
        console.log(`  ${eventType}: ${count}`);
      }

      // For each skipped event, look up all occurrences of its correlationId
      // in the event log order so we can see whether it's a trailing
      // duplicate lifecycle event after step_completed.
      // We reconstruct event order from the "replaying iteration" logs isn't
      // reliable, so instead ask the server directly.
      const eventsResp = await fetch(
        `http://localhost:${server.info.port}/runs/${encodeURIComponent(result.runId)}/events`
      );
      const eventsData = (await eventsResp.json().catch(() => null)) as {
        events: { eventType: string; correlationId?: string }[];
      } | null;
      if (eventsData?.events) {
        console.log(`  Total events in log: ${eventsData.events.length}`);
        // For each correlationId that had a skipped event, show the event
        // sequence in the log for that correlationId.
        const shownCids = new Set<string>();
        for (const skip of skippedEvents.slice(0, 6)) {
          if (shownCids.has(skip.correlationId)) continue;
          shownCids.add(skip.correlationId);
          const seq = eventsData.events
            .filter((e) => e.correlationId === skip.correlationId)
            .map((e) => e.eventType);
          console.log(
            `  cid=${skip.correlationId.slice(0, 20)}... seq=[${seq.join(', ')}]`
          );
        }
      } else {
        console.log(
          '  (events endpoint not available, skipping sequence dump)'
        );
      }
      console.log('-----------------------------------------\n');

      // Sanity: the run did complete. Everything else is diagnostic.
      expect(run.status).toBe('completed');
      // Hard assertion: no step should have hit max retries for this workflow.
      expect(maxDeliveries).toBe(0);
    }
  );
}

/**
 * Count matches of `pattern` in `logs`. If `runId` is provided, only count
 * matches where `runId` appears within an 8-line window starting at the
 * match — many debug lines put `workflowRunId` in the metadata object on
 * a following line.
 */
function matchCount(logs: string, pattern: RegExp, runId?: string): number {
  const lines = logs.split('\n');
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    pattern.lastIndex = 0;
    if (!pattern.test(lines[i]!)) continue;
    if (runId) {
      const window = lines.slice(i, i + 8).join('\n');
      if (!window.includes(runId)) continue;
    }
    n++;
  }
  return n;
}
