import { expect, test, vi } from 'vitest';
import { hydrateWorkflowReturnValue } from '@workflow/core/serialization';
import { createFetcher, startServer } from './util.mjs';

/**
 * Tests that the V2 inline execution loop correctly minimizes flow
 * handler invocations. Each test verifies a specific pattern:
 *
 * - Sequential steps (no streams): 1 invocation
 * - Sequential steps with WritableStream: 1 invocation (sync flush)
 * - Sleep + step: 2 invocations (sleep requires queue round-trip)
 * - Parallel steps (Promise.all): 1-3 invocations depending on whether the
 *   embedded harness observes the background step and continuation separately
 * - Hook + resume: 2 invocations (hook requires external resume)
 */
export function inlineExecution(world: string) {
  test(
    'sequential steps complete in a single flow invocation',
    { timeout: 30_000 },
    async () => {
      const server = await startServer({ world }).then(createFetcher);
      const result = await server.invoke(
        'workflows/inline-execution.ts',
        'sequentialStepsWorkflow',
        [10]
      );

      const run = await vi.waitFor(
        async () => {
          const run = await server.getRun(result.runId);
          expect(run.status).toBe('completed');
          return run;
        },
        { interval: 200, timeout: 29_000 }
      );

      const output = await hydrateWorkflowReturnValue(
        run.output!,
        run.runId,
        undefined
      );
      expect(output).toBe(20);

      const count = await server.getFlowInvocationCount(result.runId);
      expect(count).toBe(1);
    }
  );

  test(
    'sequential steps with stream complete in a single flow invocation',
    { timeout: 30_000 },
    async () => {
      const server = await startServer({ world }).then(createFetcher);
      const result = await server.invoke(
        'workflows/inline-execution.ts',
        'sequentialStepsWithStreamWorkflow',
        []
      );

      const run = await vi.waitFor(
        async () => {
          const run = await server.getRun(result.runId);
          expect(run.status).toBe('completed');
          return run;
        },
        { interval: 200, timeout: 29_000 }
      );

      const output = await hydrateWorkflowReturnValue(
        run.output!,
        run.runId,
        undefined
      );
      expect(output).toBe('hello world');

      const count = await server.getFlowInvocationCount(result.runId);
      expect(count).toBe(1);
    }
  );

  test(
    'sleep workflow requires exactly 2 flow invocations',
    { timeout: 30_000 },
    async () => {
      const server = await startServer({ world }).then(createFetcher);
      const result = await server.invoke(
        'workflows/inline-execution.ts',
        'sleepWorkflow',
        []
      );

      const run = await vi.waitFor(
        async () => {
          const run = await server.getRun(result.runId);
          expect(run.status).toBe('completed');
          return run;
        },
        { interval: 200, timeout: 29_000 }
      );

      const output = await hydrateWorkflowReturnValue(
        run.output!,
        run.runId,
        undefined
      );
      expect(output).toBe(3);

      // Invocation 1: replay → sleep → return {timeoutSeconds}
      // Invocation 2: sleep completed → replay → step inline → complete
      const count = await server.getFlowInvocationCount(result.runId);
      expect(count).toBe(2);
    }
  );

  test(
    'parallel steps (Promise.all) complete in 1-3 flow invocations',
    { timeout: 30_000 },
    async () => {
      const server = await startServer({ world }).then(createFetcher);
      const result = await server.invoke(
        'workflows/inline-execution.ts',
        'parallelStepsWorkflow',
        []
      );

      const run = await vi.waitFor(
        async () => {
          const run = await server.getRun(result.runId);
          expect(run.status).toBe('completed');
          return run;
        },
        { interval: 200, timeout: 29_000 }
      );

      const output = await hydrateWorkflowReturnValue(
        run.output!,
        run.runId,
        undefined
      );
      expect(output).toBe(33); // (10+1) + (20+2)

      // In the embedded harness the background step can finish quickly enough
      // that the run completes before we observe a distinct continuation pass,
      // so the lower bound is 1 even though production often shows 2.
      // With higher queue concurrency, the background step's continuation may
      // also race with the inline handler's loop, adding a 3rd no-op invocation.
      const count = await server.getFlowInvocationCount(result.runId);
      expect(count).toBeGreaterThanOrEqual(1);
      expect(count).toBeLessThanOrEqual(3);
    }
  );

  test(
    'sequential steps carrying an AbortSignal still run in a single flow invocation',
    { timeout: 30_000 },
    async () => {
      // Regression for vercel/workflow#2795: a serialized AbortSignal in step
      // arguments opens a real-time abort-stream reader for the step's
      // duration. If that reader isn't torn down before the step's ops-settle
      // check, its never-resolving read() makes every signal-bearing step
      // report `hasPendingOps`, forcing a queue continuation per step (N+1
      // invocations) instead of running inline.
      const server = await startServer({ world }).then(createFetcher);
      const count = 5;
      const result = await server.invoke(
        'workflows/signal-cost.ts',
        'signalCostWorkflow',
        [{ count, withSignal: true }]
      );

      const run = await vi.waitFor(
        async () => {
          const run = await server.getRun(result.runId);
          expect(run.status).toBe('completed');
          return run;
        },
        { interval: 200, timeout: 29_000 }
      );

      const output = await hydrateWorkflowReturnValue(
        run.output!,
        run.runId,
        undefined
      );
      expect(output).toBe('done');

      const invocations = await server.getFlowInvocationCount(result.runId);
      expect(invocations).toBe(1);
    }
  );

  // Hook invocation counting is tested by the existing hooks test suite.
  // The hook pattern requires external resume, which involves complex
  // timing. The invocation count for hooks is 2: create + resume.
}
