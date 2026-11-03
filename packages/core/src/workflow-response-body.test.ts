import type { Event, WorkflowRun } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { __builtin_response_read_chunk } from '../../workflow/src/internal/builtins.js';
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
  for (let attempt = 0; attempt < 20; attempt++) {
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

/**
 * Reads every chunk of a body and reports chunk sizes plus an
 * order-sensitive checksum, so large bodies compare cheaply.
 */
const collectChunks = `
  async function collect(body) {
    const reader = body.getReader();
    const sizes = [];
    let sum = 0;
    let index = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sizes.push(value.byteLength);
      for (let i = 0; i < value.length; i++) sum = (sum * 31 + value[i] + index++) % 1000000007;
    }
    return { sizes, sum };
  }
`;

function checksum(bytes: Uint8Array) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i++)
    sum = (sum * 31 + bytes[i] + i) % 1000000007;
  return sum;
}

function patterned(length: number) {
  return Uint8Array.from({ length }, (_, i) => (i * 7) % 251);
}

/**
 * Answers `__builtin_response_read_chunk` with the real host builtin over a
 * stored payload, delivered in transport chunks of `transportChunk` bytes.
 */
function readStoredChunk(payload: Uint8Array, transportChunk = 7777) {
  return (item: QueueItem & { type: 'step' }) => {
    expect(item.stepName).toBe('__builtin_response_read_chunk');
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= payload.length) return controller.close();
        const end = Math.min(offset + transportChunk, payload.length);
        controller.enqueue(payload.slice(offset, end));
        offset = end;
      },
    });
    return __builtin_response_read_chunk.call(
      new Response(body),
      ...(item.args as [number])
    );
  };
}

describe('reading Response bodies inside the workflow VM', () => {
  it('reads multi-chunk in-memory bodies of every init type without a step', async () => {
    const { value, steps } = await runToCompletion(
      `${collectChunks}
      async function workflow() {
        const bytes = new Uint8Array(300007);
        for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) % 251;
        const padded = new Uint8Array(bytes.length + 5);
        padded.set(bytes, 3);
        return {
          string: await collect(new Response("a".repeat(300007)).body),
          arrayBuffer: await collect(new Response(bytes.buffer).body),
          view: await collect(new Response(padded.subarray(3, 3 + bytes.length)).body),
          nested: await collect(new Response(new Response(bytes).body).body),
          exact: await collect(new Response(new Uint8Array(262144)).body),
        };
      }${workflowRegistration('workflow')}`,
      async () => {
        throw new Error('no step expected');
      }
    );
    const sizes = [65536, 65536, 131072, 37863];
    const binary = { sizes, sum: checksum(patterned(300007)) };
    expect(value).toEqual({
      string: {
        sizes,
        sum: checksum(new TextEncoder().encode('a'.repeat(300007))),
      },
      arrayBuffer: binary,
      view: binary,
      nested: binary,
      // In memory the end is known, so no trailing empty read is needed.
      exact: {
        sizes: [65536, 65536, 131072],
        sum: checksum(new Uint8Array(262144)),
      },
    });
    expect(steps).toHaveLength(0);
  });

  it('reads a stored body through the real host builtin with growing chunks', async () => {
    const payload = patterned(300007);
    const { value, steps } = await runToCompletion(
      `const fetchStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("fetch");
      ${collectChunks}
      async function workflow() {
        const response = await fetchStep("https://example.com");
        return [await collect(response.body), await collect(new Response(response.body).body)];
      }${workflowRegistration('workflow')}`,
      async (item) =>
        item.stepName === 'fetch'
          ? new Response(namedStream('strm_stored'))
          : readStoredChunk(payload)(item)
    );
    const expected = {
      sizes: [65536, 65536, 131072, 37863],
      sum: checksum(payload),
    };
    // A second reader, even through a wrapping Response, restarts at byte 0.
    expect(value).toEqual([expected, expected]);
    expect(steps.slice(1).map((step) => step.args)).toEqual([
      [0],
      [65536],
      [131072],
      [262144],
      [0],
      [65536],
      [131072],
      [262144],
    ]);
  });

  it('takes one trailing empty step for a stored body that fills its last chunk', async () => {
    const payload = patterned(262144);
    const { value, steps } = await runToCompletion(
      `const fetchStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("fetch");
      ${collectChunks}
      async function workflow() {
        return collect((await fetchStep("https://example.com")).body);
      }${workflowRegistration('workflow')}`,
      async (item) =>
        item.stepName === 'fetch'
          ? new Response(namedStream('strm_exact'))
          : readStoredChunk(payload, 65536)(item)
    );
    expect(value).toEqual({
      sizes: [65536, 65536, 131072],
      sum: checksum(payload),
    });
    expect(steps.slice(1).map((step) => step.args)).toEqual([
      [0],
      [65536],
      [131072],
      [262144],
    ]);
  });

  it('cancels and releases the reader when for-await exits early', async () => {
    const { value, steps } = await runToCompletion(
      `const fetchStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("fetch");
      async function workflow() {
        const body = (await fetchStep("https://example.com")).body;
        const calls = [];
        const getReader = body.getReader;
        body.getReader = function () {
          const reader = getReader.call(this);
          const { cancel, releaseLock } = reader;
          reader.cancel = () => { calls.push("cancel"); return cancel(); };
          reader.releaseLock = () => { calls.push("releaseLock"); releaseLock(); };
          return reader;
        };
        let seen = 0;
        for await (const chunk of body) {
          seen += chunk.byteLength;
          break;
        }
        return { seen, calls };
      }${workflowRegistration('workflow')}`,
      async (item) =>
        item.stepName === 'fetch'
          ? new Response(namedStream('strm_break'))
          : { buffer: new ArrayBuffer(65536), done: false }
    );
    expect(value).toEqual({ seen: 65536, calls: ['cancel', 'releaseLock'] });
    expect(steps).toHaveLength(2);
  });

  it('stops requesting stored chunks when a consumer cancels at its limit', async () => {
    const { value, steps } = await runToCompletion(
      `const fetchStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("fetch");
      async function workflow() {
        const reader = (await fetchStep("https://example.com")).body.getReader();
        const first = await reader.read();
        const exceeded = first.value.byteLength > 1024;
        if (exceeded) await reader.cancel();
        return { size: first.value.length, exceeded, done: (await reader.read()).done };
      }${workflowRegistration('workflow')}`,
      async (item) => {
        if (item.stepName === 'fetch')
          return new Response(namedStream('strm_large'));
        expect(item.stepName).toBe('__builtin_response_read_chunk');
        expect(item.args).toEqual([0]);
        return { buffer: new ArrayBuffer(65536), done: false };
      }
    );
    expect(value).toEqual({ size: 65536, exceeded: true, done: true });
    expect(steps).toHaveLength(2);
  });

  it('serializes overlapping chunk reads and replays byte offsets', async () => {
    const { value, steps } = await runToCompletion(
      `const fetchStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("fetch");
      async function workflow() {
        const reader = (await fetchStep("https://example.com")).body.getReader();
        const chunks = await Promise.all([reader.read(), reader.read(), reader.read()]);
        await reader.closed;
        return chunks.map(chunk => chunk.value[0]);
      }${workflowRegistration('workflow')}`,
      async (item) => {
        if (item.stepName === 'fetch')
          return new Response(namedStream('strm_chunks'));
        const offset = item.args[0] as number;
        return {
          buffer: new Uint8Array([offset + 1]).buffer,
          done: offset === 2,
        };
      }
    );
    expect(value).toEqual([1, 2, 3]);
    expect(steps.slice(1).map((step) => step.args)).toEqual([[0], [1], [2]]);
  });

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
        expect(item.stepName).toBe('__builtin_response_read_chunk');
        return { buffer: new TextEncoder().encode(payload).buffer, done: true };
      }
    );

    expect(value).toEqual({ status: 200, first: payload, second: payload });
    const bodyReads = steps.filter(
      (s) => s.stepName === '__builtin_response_read_chunk'
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
          : { buffer: new TextEncoder().encode('ok').buffer, done: true }
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
          : { buffer: new ArrayBuffer(0), done: true }
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

  it('delivers the body once to overlapping reads and settles `closed` with it', async () => {
    const { value, steps } = await runToCompletion(
      `const fetchStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("fetch");
      async function workflow() {
        const response = await fetchStep("https://example.com");
        const reader = response.body.getReader();
        // A consumer that prefetches issues the next read before the
        // previous one settles.
        const [first, second] = await Promise.all([reader.read(), reader.read()]);
        // No further read: \`closed\` must already be settled, so it wins a
        // race against a promise that settles a few microtasks later.
        const closed = await Promise.race([
          reader.closed.then(() => "closed"),
          Promise.resolve().then(() => undefined).then(() => "pending"),
        ]);
        return {
          first: { done: first.done, text: new TextDecoder().decode(first.value) },
          second: { done: second.done, value: second.value },
          third: await reader.read(),
          closed,
        };
      }${workflowRegistration('workflow')}`,
      async (item) =>
        item.stepName === 'fetch'
          ? new Response(namedStream('strm_overlapping'))
          : { buffer: new TextEncoder().encode('payload').buffer, done: true }
    );
    expect(value).toEqual({
      first: { done: false, text: 'payload' },
      second: { done: true, value: undefined },
      third: { done: true, value: undefined },
      closed: 'closed',
    });
    expect(
      steps.filter((s) => s.stepName === '__builtin_response_read_chunk')
    ).toHaveLength(1);
  });

  it('settles `closed` after reading an in-VM body without a trailing read', async () => {
    const { value } = await runToCompletion(
      `async function workflow() {
        const reader = new Response("hi").body.getReader();
        const [first, second] = await Promise.all([reader.read(), reader.read()]);
        const closed = await Promise.race([
          reader.closed.then(() => "closed"),
          Promise.resolve().then(() => undefined).then(() => "pending"),
        ]);
        return { first: first.value.length, second: second.done, closed };
      }${workflowRegistration('workflow')}`,
      async () => {
        throw new Error('no step expected');
      }
    );
    expect(value).toEqual({ first: 2, second: true, closed: 'closed' });
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
