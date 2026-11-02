import { describe, expect, it } from 'vitest';
import { __builtin_response_read_chunk } from '../../../workflow/src/internal/builtins.js';
import { deserialize, serialize } from '../serialization/workflow-vm.js';
import {
  dehydrateStepReturnValue,
  hydrateStepArguments,
} from '../serialization.js';
import { STREAM_NAME_SYMBOL, STREAM_TYPE_SYMBOL } from '../symbols.js';
import { runQuickJSWorkflow } from './quickjs-runtime.js';
import { isClientDisconnectError } from './step-streams.js';
import { setWorld } from './world.js';

const workflowId = 'workflow//test//workflow';

function makeRun() {
  return {
    runId: 'wrun_quickjs_body',
    deploymentId: 'dpl_test',
    workflowName: 'test-workflow',
    input: undefined,
    status: 'running' as const,
    output: undefined,
    error: undefined,
    completedAt: undefined,
    startedAt: new Date('2025-01-01T00:00:00Z'),
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    specVersion: 2,
  };
}

// Reads `response.body` the way `readResponseWithSizeLimit` in
// `@ai-sdk/provider-utils` does.
const readBodyWithReader = `
  async function readBody(response) {
    var reader = response.body.getReader();
    var chunks = [];
    var total = 0;
    try {
      while (true) {
        var r = await reader.read();
        if (r.done) break;
        total += r.value.length;
        chunks.push(r.value);
      }
    } finally {
      try { await reader.cancel(); } finally { reader.releaseLock(); }
    }
    var out = new Uint8Array(total);
    var offset = 0;
    for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], offset); offset += chunks[i].length; }
    return new TextDecoder().decode(out);
  }
`;

function namedStream(name: string) {
  const stream = new ReadableStream<Uint8Array>();
  (stream as any)[STREAM_NAME_SYMBOL] = name;
  return stream;
}

async function runToCompletion(
  body: string,
  resolveStep: (stepId: string, input: Uint8Array) => unknown
) {
  const code = `
    var fetchStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//test//fetch");
    ${readBodyWithReader}
    async function workflow() { ${body} }
    workflow.workflowId = ${JSON.stringify(workflowId)};
    globalThis.__private_workflows.set(${JSON.stringify(workflowId)}, workflow);
  `;
  const run = makeRun();
  const events: any[] = [
    {
      eventId: 'evnt_run_created',
      runId: run.runId,
      eventType: 'run_created',
      eventData: { input: serialize([]) },
      createdAt: new Date('2025-01-01T00:00:00Z'),
    },
  ];
  const stepIds: string[] = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await runQuickJSWorkflow({
      workflowCode: code,
      workflowId,
      workflowRun: run,
      events,
    });
    if (result.completed) {
      return { value: deserialize(result.completed.result), stepIds };
    }
    expect(result.suspended).toBeDefined();
    for (const op of result.suspended!.pendingOperations) {
      expect(op.type).toBe('step');
      // A step whose arguments failed to serialize would fail at runtime.
      expect((op as any).serializationError).toBeUndefined();
      const stepId = (op as any).stepId as string;
      stepIds.push(stepId);
      const ops: Promise<void>[] = [];
      const output = await dehydrateStepReturnValue(
        await resolveStep(stepId, (op as any).input),
        run.runId,
        undefined,
        ops
      );
      await Promise.all(ops);
      events.push(
        {
          eventId: `evnt_${events.length}`,
          runId: run.runId,
          eventType: 'step_created',
          correlationId: op.correlationId,
          eventData: { stepName: stepId },
          createdAt: new Date('2025-01-01T00:00:01Z'),
        },
        {
          eventId: `evnt_${events.length + 1}`,
          runId: run.runId,
          eventType: 'step_completed',
          correlationId: op.correlationId,
          eventData: { result: output },
          createdAt: new Date('2025-01-01T00:00:02Z'),
        }
      );
    }
  }
  throw new Error('workflow did not complete');
}

// Same helper as the node:vm tests: chunk sizes plus a checksum.
const collectChunks = `
  async function collect(body) {
    var reader = body.getReader();
    var sizes = [];
    var sum = 0;
    var index = 0;
    while (true) {
      var r = await reader.read();
      if (r.done) break;
      sizes.push(r.value.byteLength);
      for (var i = 0; i < r.value.length; i++) sum = (sum * 31 + r.value[i] + index++) % 1000000007;
    }
    return { sizes: sizes, sum: sum };
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
 * Runs the real `__builtin_response_read_chunk` the way a step executor
 * does: hydrate the step input (a Response over a stored stream, served by
 * a World that delivers `payload` in `transportChunk`-byte frames), call the
 * builtin, and settle background stream operations.
 */
async function withStoredPayload<T>(
  payload: Uint8Array,
  transportChunk: number,
  run: (readChunk: (input: Uint8Array) => Promise<unknown>) => Promise<T>
): Promise<T> {
  setWorld({
    specVersion: 9,
    streams: {
      get: async () => {
        let offset = 0;
        return new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset >= payload.length) return controller.close();
            const end = Math.min(offset + transportChunk, payload.length);
            controller.enqueue(payload.slice(offset, end));
            offset = end;
          },
        });
      },
    },
  } as any);
  try {
    return await run(async (input) => {
      const ops: Promise<void>[] = [];
      const { args, thisVal } = (await hydrateStepArguments(
        input,
        'wrun_quickjs_body',
        undefined,
        ops,
        globalThis,
        {},
        'dpl_test'
      )) as any;
      const result = await __builtin_response_read_chunk.call(
        thisVal,
        ...(args as [number])
      );
      await Promise.all(
        ops.map((op) =>
          op.catch((error) => {
            if (!isClientDisconnectError(error)) throw error;
          })
        )
      );
      return result;
    });
  } finally {
    setWorld(undefined);
  }
}

function storedStream(name: string) {
  const stream = namedStream(name);
  (stream as any)[STREAM_TYPE_SYMBOL] = 'bytes';
  return stream;
}

describe('QuickJS: reading Response bodies inside the workflow', () => {
  it('reads multi-chunk in-memory bodies of every init type without a step', async () => {
    const { value, stepIds } = await runToCompletion(
      `${collectChunks}
      var bytes = new Uint8Array(300007);
      for (var i = 0; i < bytes.length; i++) bytes[i] = (i * 7) % 251;
      var padded = new Uint8Array(bytes.length + 5);
      padded.set(bytes, 3);
      return {
        string: await collect(new Response("a".repeat(300007)).body),
        arrayBuffer: await collect(new Response(bytes.buffer).body),
        view: await collect(new Response(padded.subarray(3, 3 + bytes.length)).body),
        nested: await collect(new Response(new Response(bytes).body).body),
        exact: await collect(new Response(new Uint8Array(262144)).body),
      };`,
      () => {
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
      exact: {
        sizes: [65536, 65536, 131072],
        sum: checksum(new Uint8Array(262144)),
      },
    });
    expect(stepIds).toHaveLength(0);
  });

  it('reads a stored body through the real host builtin with growing chunks', async () => {
    const payload = patterned(300007);
    const { value, stepIds } = await withStoredPayload(
      payload,
      7777,
      (readChunk) =>
        runToCompletion(
          `${collectChunks}
          var response = await fetchStep("https://example.com");
          return [await collect(response.body), await collect(new Response(response.body).body)];`,
          (stepId, input) =>
            stepId === 'step//test//fetch'
              ? new Response(storedStream('strm_quickjs_stored'))
              : readChunk(input)
        )
    );
    const expected = {
      sizes: [65536, 65536, 131072, 37863],
      sum: checksum(payload),
    };
    expect(value).toEqual([expected, expected]);
    expect(stepIds.slice(1)).toEqual(
      Array(8).fill('__builtin_response_read_chunk')
    );
  });

  it('takes one trailing empty step for a stored body that fills its last chunk', async () => {
    const payload = patterned(262144);
    const { value, stepIds } = await withStoredPayload(
      payload,
      65536,
      (readChunk) =>
        runToCompletion(
          `${collectChunks}
          return collect((await fetchStep("https://example.com")).body);`,
          (stepId, input) =>
            stepId === 'step//test//fetch'
              ? new Response(storedStream('strm_quickjs_exact'))
              : readChunk(input)
        )
    );
    expect(value).toEqual({
      sizes: [65536, 65536, 131072],
      sum: checksum(payload),
    });
    expect(stepIds.slice(1)).toEqual(
      Array(4).fill('__builtin_response_read_chunk')
    );
  });

  it('cancels and releases the reader when for-await finishes or exits early', async () => {
    const { value } = await runToCompletion(
      `function track(body, calls) {
        var getReader = body.getReader;
        body.getReader = function() {
          var reader = getReader.call(this);
          var cancel = reader.cancel;
          var releaseLock = reader.releaseLock;
          reader.cancel = function() { calls.push("cancel"); return cancel(); };
          reader.releaseLock = function() { calls.push("releaseLock"); releaseLock(); };
          return reader;
        };
        return body;
      }
      var finished = [];
      var seen = 0;
      for await (var chunk of track(new Response(new Uint8Array(100000)).body, finished)) seen += chunk.length;
      var broke = [];
      for await (var first of track(new Response("hello").body, broke)) break;
      return { seen: seen, finished: finished, broke: broke };`,
      () => {
        throw new Error('no step expected');
      }
    );
    expect(value).toEqual({
      seen: 100000,
      finished: ['cancel', 'releaseLock'],
      broke: ['cancel', 'releaseLock'],
    });
  });

  it('does not request another stored chunk after cancellation at a size limit', async () => {
    const { value, stepIds } = await runToCompletion(
      `var reader = (await fetchStep("https://example.com")).body.getReader();
      var first = await reader.read();
      var exceeded = first.value.byteLength > 1024;
      if (exceeded) await reader.cancel();
      return { size: first.value.length, exceeded: exceeded, done: (await reader.read()).done };`,
      (stepId) => {
        if (stepId === 'step//test//fetch')
          return new Response(namedStream('strm_large'));
        expect(stepId).toBe('__builtin_response_read_chunk');
        return { buffer: new ArrayBuffer(65536), done: false };
      }
    );
    expect(value).toEqual({ size: 65536, exceeded: true, done: true });
    expect(stepIds).toEqual([
      'step//test//fetch',
      '__builtin_response_read_chunk',
    ]);
  });

  it('serializes overlapping reads of a multi-chunk stored body', async () => {
    let chunk = 0;
    const { value, stepIds } = await runToCompletion(
      `var reader = (await fetchStep("https://example.com")).body.getReader();
      var chunks = await Promise.all([reader.read(), reader.read(), reader.read()]);
      await reader.closed;
      return chunks.map(function(chunk) { return chunk.value[0]; });`,
      (stepId) => {
        if (stepId === 'step//test//fetch')
          return new Response(namedStream('strm_chunks'));
        chunk++;
        return { buffer: new Uint8Array([chunk]).buffer, done: chunk === 3 };
      }
    );
    expect(value).toEqual([1, 2, 3]);
    expect(stepIds.slice(1)).toEqual(
      Array(3).fill('__builtin_response_read_chunk')
    );
  });

  it('reads the body of a Response returned by a step through getReader()', async () => {
    const payload = JSON.stringify({ text: 'hello from the provider' });
    const { value, stepIds } = await runToCompletion(
      `
      var response = await fetchStep("https://example.com");
      var first = await readBody(response);
      var second = await readBody(response);
      return { status: response.status, first: first, second: second };
      `,
      (stepId) =>
        stepId === 'step//test//fetch'
          ? new Response(namedStream('strm_quickjs_body'), { status: 200 })
          : { buffer: new TextEncoder().encode(payload).buffer, done: true }
    );
    expect(value).toEqual({ status: 200, first: payload, second: payload });
    expect(stepIds).toEqual([
      'step//test//fetch',
      '__builtin_response_read_chunk',
      '__builtin_response_read_chunk',
    ]);
  });

  it('calls the fetch step with AI SDK request options (`signal: undefined`)', async () => {
    // `postToApi` in `@ai-sdk/provider-utils` always passes `signal`, which
    // is undefined unless the caller provides an abort signal.
    const payload = JSON.stringify({ text: 'hello from the provider' });
    const { value, stepIds } = await runToCompletion(
      `
      var response = await fetchStep("https://example.com/v1/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "hi" }),
        signal: undefined,
      });
      return JSON.parse(await readBody(response));
      `,
      (stepId) =>
        stepId === 'step//test//fetch'
          ? new Response(namedStream('strm_quickjs_ai_sdk'), { status: 200 })
          : { buffer: new TextEncoder().encode(payload).buffer, done: true }
    );
    expect(value).toEqual({ text: 'hello from the provider' });
    expect(stepIds).toEqual([
      'step//test//fetch',
      '__builtin_response_read_chunk',
    ]);
  });

  it('delivers the body once to overlapping reads and settles `closed` with it', async () => {
    const { value, stepIds } = await runToCompletion(
      `
      var response = await fetchStep("https://example.com");
      var reader = response.body.getReader();
      var reads = await Promise.all([reader.read(), reader.read()]);
      var closed = await Promise.race([
        reader.closed.then(function() { return "closed"; }),
        Promise.resolve().then(function() {}).then(function() { return "pending"; }),
      ]);
      var third = await reader.read();
      return {
        first: { done: reads[0].done, text: new TextDecoder().decode(reads[0].value) },
        second: { done: reads[1].done, value: reads[1].value },
        third: { done: third.done, value: third.value },
        closed: closed,
      };
      `,
      (stepId) =>
        stepId === 'step//test//fetch'
          ? new Response(namedStream('strm_quickjs_overlapping'))
          : { buffer: new TextEncoder().encode('payload').buffer, done: true }
    );
    expect(value).toEqual({
      first: { done: false, text: 'payload' },
      second: { done: true, value: undefined },
      third: { done: true, value: undefined },
      closed: 'closed',
    });
    expect(stepIds).toEqual([
      'step//test//fetch',
      '__builtin_response_read_chunk',
    ]);
  });

  it('settles `closed` after reading an in-VM body without a trailing read', async () => {
    const { value } = await runToCompletion(
      `
      var reader = new Response("hi").body.getReader();
      var reads = await Promise.all([reader.read(), reader.read()]);
      var closed = await Promise.race([
        reader.closed.then(function() { return "closed"; }),
        Promise.resolve().then(function() {}).then(function() { return "pending"; }),
      ]);
      return { first: reads[0].value.length, second: reads[1].done, closed: closed };
      `,
      () => {
        throw new Error('no step expected');
      }
    );
    expect(value).toEqual({ first: 2, second: true, closed: 'closed' });
  });

  it('reads in-VM Response bodies without running a step', async () => {
    const { value, stepIds } = await runToCompletion(
      `
      var chunks = [];
      for await (var chunk of new Response(new Uint8Array([104, 105])).body) {
        for (var i = 0; i < chunk.length; i++) chunks.push(chunk[i]);
      }
      return {
        text: await readBody(new Response("hello")),
        json: await readBody(Response.json({ a: 1 })),
        iterated: chunks,
      };
      `,
      () => {
        throw new Error('no step expected');
      }
    );
    expect(value).toEqual({
      text: 'hello',
      json: '{"a":1}',
      iterated: [104, 105],
    });
    expect(stepIds).toHaveLength(0);
  });
});
