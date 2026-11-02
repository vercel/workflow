import type { Event, WorkflowRun } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import type { QueueItem, WorkflowSuspension } from './global.js';
import {
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
  hydrateWorkflowReturnValue,
} from './serialization.js';
import { STREAM_NAME_SYMBOL } from './symbols.js';
import { runWorkflow } from './workflow.js';

const runId = 'wrun_response_body';

// Reads `response.body` the way `readResponseWithSizeLimit` in
// `@ai-sdk/provider-utils` does: `getReader()`, a `read()` loop, then
// `cancel()` and `releaseLock()` on the reader.
const readBodyWithReader = `
  async function readBody(response) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        chunks.push(value);
      }
    } finally {
      try { await reader.cancel(); } finally { reader.releaseLock(); }
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
    return new TextDecoder().decode(out);
  }
`;

const workflowRegistration = (name: string) =>
  `;globalThis.__private_workflows = new Map();
  globalThis.__private_workflows.set(${JSON.stringify(name)}, ${name});`;

async function makeRun(): Promise<WorkflowRun> {
  return {
    runId,
    workflowName: 'workflow',
    status: 'running',
    input: await dehydrateWorkflowArguments([], runId, undefined, []),
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    startedAt: new Date('2024-01-01T00:00:00.000Z'),
    deploymentId: 'test-deployment',
  };
}

/**
 * Drives a workflow to completion, answering each step the workflow
 * suspends on with `resolveStep` and replaying from the start every time.
 */
async function runToCompletion(
  code: string,
  resolveStep: (item: QueueItem & { type: 'step' }) => Promise<unknown>
) {
  const workflowRun = await makeRun();
  const events: Event[] = [];
  const steps: (QueueItem & { type: 'step' })[] = [];
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const result = await runWorkflow(code, workflowRun, events, undefined);
      return {
        value: await hydrateWorkflowReturnValue(
          result as any,
          runId,
          undefined,
          []
        ),
        steps,
      };
    } catch (err) {
      if ((err as Error).name !== 'WorkflowSuspension') throw err;
      const pending = (err as WorkflowSuspension).items.filter(
        (item): item is QueueItem & { type: 'step' } => item.type === 'step'
      );
      expect(pending.length).toBeGreaterThan(0);
      for (const item of pending) {
        steps.push(item);
        const ops: Promise<void>[] = [];
        const result = await dehydrateStepReturnValue(
          await resolveStep(item),
          runId,
          undefined,
          ops
        );
        await Promise.all(ops);
        events.push(
          {
            eventId: `evt_${events.length}`,
            runId,
            eventType: 'step_started',
            correlationId: item.correlationId,
            eventData: { stepName: item.stepName },
            createdAt: new Date('2024-01-01T00:00:01.000Z'),
          } as Event,
          {
            eventId: `evt_${events.length + 1}`,
            runId,
            eventType: 'step_completed',
            correlationId: item.correlationId,
            eventData: { stepName: item.stepName, result },
            createdAt: new Date('2024-01-01T00:00:02.000Z'),
          } as Event
        );
      }
    }
  }
  throw new Error('workflow did not complete');
}

/** A host ReadableStream that serializes as an already-stored named stream. */
function namedStream(name: string) {
  const stream = new ReadableStream<Uint8Array>();
  (stream as any)[STREAM_NAME_SYMBOL] = name;
  return stream;
}

describe('reading Response bodies inside the workflow VM', () => {
  it('reads the body of a Response returned by a step through getReader()', async () => {
    const payload = JSON.stringify({ text: 'hello from the provider' });
    const { value, steps } = await runToCompletion(
      `const fetchStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("fetch");
      ${readBodyWithReader}
      async function workflow() {
        const response = await fetchStep("https://example.com");
        const first = await readBody(response);
        // Reading again replays the same bytes.
        const second = await readBody(response);
        return { status: response.status, first, second };
      }${workflowRegistration('workflow')}`,
      async (item) => {
        if (item.stepName === 'fetch') {
          return new Response(namedStream('strm_response_body'), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        expect(item.stepName).toBe('__builtin_response_array_buffer');
        return new TextEncoder().encode(payload).buffer;
      }
    );

    expect(value).toEqual({ status: 200, first: payload, second: payload });
    const bodyReads = steps.filter(
      (s) => s.stepName === '__builtin_response_array_buffer'
    );
    // One step per reader, each passing the stored stream back to the host.
    expect(bodyReads).toHaveLength(2);
    for (const read of bodyReads) {
      expect((read.thisVal as any).body[STREAM_NAME_SYMBOL]).toBe(
        'strm_response_body'
      );
    }
  });

  it('calls a step assigned to globalThis.fetch without capturing the global as `this`', async () => {
    const { value, steps } = await runToCompletion(
      `const fetchStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("fetch");
      ${readBodyWithReader}
      async function workflow() {
        globalThis.fetch = fetchStep;
        const response = await globalThis.fetch("https://example.com");
        return readBody(response);
      }${workflowRegistration('workflow')}`,
      async (item) =>
        item.stepName === 'fetch'
          ? new Response(namedStream('strm_global_fetch'))
          : new TextEncoder().encode('ok').buffer
    );
    expect(value).toBe('ok');
    expect(steps[0]).toMatchObject({ stepName: 'fetch' });
    expect(steps[0].thisVal).toBeUndefined();
  });

  it('reads an empty stored body as done on the first read', async () => {
    const { value } = await runToCompletion(
      `const fetchStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("fetch");
      async function workflow() {
        const response = await fetchStep("https://example.com");
        const reader = response.body.getReader();
        const result = await reader.read();
        return result.done && result.value === undefined;
      }${workflowRegistration('workflow')}`,
      async (item) =>
        item.stepName === 'fetch'
          ? new Response(namedStream('strm_empty'))
          : new ArrayBuffer(0)
    );
    expect(value).toBe(true);
  });

  it('reads in-VM Response bodies without running a step', async () => {
    const { value, steps } = await runToCompletion(
      `${readBodyWithReader}
      async function workflow() {
        const chunks = [];
        for await (const chunk of new Response(new Uint8Array([104, 105])).body) {
          chunks.push(...chunk);
        }
        return {
          text: await readBody(new Response("hello")),
          json: await readBody(Response.json({ a: 1 })),
          params: await readBody(new Response(new URLSearchParams({ q: "1" }))),
          iterated: chunks,
        };
      }${workflowRegistration('workflow')}`,
      async () => {
        throw new Error('no step expected');
      }
    );
    expect(value).toEqual({
      text: 'hello',
      json: '{"a":1}',
      params: 'q=1',
      iterated: [104, 105],
    });
    expect(steps).toHaveLength(0);
  });

  it('still rejects BYOB readers and stream construction', async () => {
    await expect(
      runToCompletion(
        `async function workflow() {
          new Response("x").body.getReader({ mode: "byob" });
        }${workflowRegistration('workflow')}`,
        async () => undefined
      )
    ).rejects.toThrow(/not available inside a workflow function/);
    await expect(
      runToCompletion(
        `async function workflow() { new ReadableStream(); }${workflowRegistration('workflow')}`,
        async () => undefined
      )
    ).rejects.toThrow(/not available inside a workflow function/);
  });
});
