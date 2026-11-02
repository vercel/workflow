import { describe, expect, it } from 'vitest';
import { dehydrateStepReturnValue } from '../serialization.js';
import { deserialize, serialize } from '../serialization/workflow-vm.js';
import { STREAM_NAME_SYMBOL } from '../symbols.js';
import { runQuickJSWorkflow } from './quickjs-runtime.js';

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
  resolveStep: (stepId: string) => unknown
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
  for (let attempt = 0; attempt < 10; attempt++) {
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
      const stepId = (op as any).stepId as string;
      stepIds.push(stepId);
      const ops: Promise<void>[] = [];
      const output = await dehydrateStepReturnValue(
        await resolveStep(stepId),
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

describe('QuickJS: reading Response bodies inside the workflow', () => {
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
          : new TextEncoder().encode(payload).buffer
    );
    expect(value).toEqual({ status: 200, first: payload, second: payload });
    expect(stepIds).toEqual([
      'step//test//fetch',
      '__builtin_response_array_buffer',
      '__builtin_response_array_buffer',
    ]);
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
