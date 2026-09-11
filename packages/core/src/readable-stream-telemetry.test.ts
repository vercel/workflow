import { trace as otelTrace, SpanKind } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { setWorld } from './runtime/world.js';
import {
  createReconnectingFramedStream,
  WorkflowServerReadableStream,
} from './serialization.js';

/** 4-byte BE length prefix + payload — the framed-v1 wire layout. */
function frame(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.byteLength);
  new DataView(out.buffer).setUint32(0, payload.byteLength, false);
  out.set(payload, 4);
  return out;
}

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider();

beforeAll(() => {
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  otelTrace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  otelTrace.disable();
});

/** The read span is emitted fire-and-forget on the first chunk; poll for it. */
async function waitForSpans(
  name: string,
  count: number
): Promise<ReadableSpan[]> {
  for (let i = 0; i < 50; i++) {
    const spans = exporter.getFinishedSpans().filter((s) => s.name === name);
    if (spans.length >= count) return spans;
    await new Promise((r) => setTimeout(r, 10));
  }
  return exporter.getFinishedSpans().filter((s) => s.name === name);
}

describe('WorkflowServerReadableStream read telemetry', () => {
  beforeEach(() => {
    exporter.reset();
    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      streams: {
        get: vi.fn().mockImplementation(
          async () =>
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array([1, 2, 3]));
                controller.close();
              },
            })
        ),
      },
    } as any);
  });

  afterEach(() => {
    setWorld(undefined);
    vi.clearAllMocks();
  });

  it('emits a workflow.stream.read span with ttfc and connect durations', async () => {
    const stream = new WorkflowServerReadableStream('run-123', 'test-stream');
    const reader = stream.getReader();
    // Drain: empty header chunk, real chunk, done.
    for (let i = 0; i < 5; i++) {
      const { done } = await reader.read();
      if (done) break;
    }

    const [span] = await waitForSpans('workflow.stream.read', 1);
    expect(span).toBeDefined();
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.attributes['workflow.run.id']).toBe('run-123');
    expect(span.attributes['workflow.stream.name']).toBe('test-stream');
    expect(span.attributes['workflow.stream.operation']).toBe('read');

    const ttfc = span.attributes['workflow.stream.read.ttfc_ms'];
    expect(typeof ttfc).toBe('number');
    expect(ttfc as number).toBeGreaterThanOrEqual(0);

    // Client-observed connect duration (the world.streams.get await).
    const connect = span.attributes['workflow.stream.read.connect_ms'];
    expect(typeof connect).toBe('number');
    expect(connect as number).toBeGreaterThanOrEqual(0);
    expect(connect as number).toBeLessThanOrEqual((ttfc as number) + 1);
  });

  it('summarizes raw reader wait and downstream demand phases at EOF', async () => {
    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      streams: {
        get: vi.fn().mockResolvedValue(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              await new Promise((resolve) => setTimeout(resolve, 260));
              controller.enqueue(new Uint8Array([1, 2, 3]));
              controller.close();
            },
          })
        ),
      },
    } as any);
    const reader = new WorkflowServerReadableStream(
      'run-123',
      'test-stream'
    ).getReader();

    expect((await reader.read()).value).toEqual(new Uint8Array([1, 2, 3]));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect((await reader.read()).done).toBe(true);

    const [span] = await waitForSpans('workflow.stream.read.complete', 1);
    expect(span.attributes).toMatchObject({
      'workflow.stream.read.first_data_observed': true,
      'workflow.stream.read.source_chunks': 1,
      'workflow.stream.read.source_empty_chunks': 0,
      'workflow.stream.read.source_bytes': 3,
      'workflow.stream.read.source_interarrival_count': 0,
      'workflow.stream.read.source_read_wait_count': 2,
      'workflow.stream.read.source_read_wait_over_250ms_count': 1,
    });
    expect(
      span.attributes['workflow.stream.read.source_read_wait_max_ms'] as number
    ).toBeGreaterThanOrEqual(250);
    expect(
      span.attributes[
        'workflow.stream.read.enqueue_to_next_pull_max_ms'
      ] as number
    ).toBeGreaterThanOrEqual(20);
    expect(
      span.attributes[
        'workflow.stream.read.stream_handle_to_first_data_ms'
      ] as number
    ).toBeGreaterThanOrEqual(250);
    expect(
      span.attributes[
        'workflow.stream.read.source_read_wait_total_ms'
      ] as number
    ).toBeGreaterThanOrEqual(250);
    expect(
      span.attributes[
        'workflow.stream.read.read_resolution_to_enqueue_max_ms'
      ] as number
    ).toBeGreaterThanOrEqual(0);
    expect(
      span.attributes['workflow.stream.read.source_interarrival_max_ms']
    ).toBeUndefined();
  });

  it('does not treat the empty header sentinel as first data', async () => {
    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      streams: {
        get: vi.fn().mockResolvedValue(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array());
              setTimeout(() => {
                controller.enqueue(new Uint8Array([1]));
                controller.close();
              }, 20);
            },
          })
        ),
      },
    } as any);
    const reader = new WorkflowServerReadableStream(
      'run-123',
      'test-stream'
    ).getReader();

    for (let i = 0; i < 5; i++) {
      if ((await reader.read()).done) break;
    }

    const [span] = await waitForSpans('workflow.stream.read.complete', 1);
    expect(span.attributes).toMatchObject({
      'workflow.stream.read.first_data_observed': true,
      'workflow.stream.read.source_chunks': 2,
      'workflow.stream.read.source_empty_chunks': 1,
      'workflow.stream.read.source_bytes': 1,
      'workflow.stream.read.source_interarrival_count': 1,
    });
    expect(
      span.attributes[
        'workflow.stream.read.stream_handle_to_first_data_ms'
      ] as number
    ).toBeGreaterThanOrEqual(15);
  });

  it('emits a workflow.stream.read.complete span with totals when the read drains', async () => {
    const stream = new WorkflowServerReadableStream('run-123', 'test-stream');
    const reader = stream.getReader();
    for (let i = 0; i < 5; i++) {
      const { done } = await reader.read();
      if (done) break;
    }

    const [span] = await waitForSpans('workflow.stream.read.complete', 1);
    expect(span).toBeDefined();
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.attributes['workflow.stream.operation']).toBe('read_complete');
    expect(span.attributes['workflow.stream.read.chunks']).toBe(1);
    expect(span.attributes['workflow.stream.read.bytes']).toBe(3);
    expect(typeof span.attributes['workflow.stream.read.total_ms']).toBe(
      'number'
    );
  });
});

describe('createReconnectingFramedStream read telemetry', () => {
  beforeEach(() => {
    exporter.reset();
    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      streams: {
        get: vi.fn().mockImplementation(
          async () =>
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(frame(new Uint8Array([1, 2, 3])));
                controller.enqueue(frame(new Uint8Array([4, 5])));
                controller.close();
              },
            })
        ),
      },
    } as any);
  });

  afterEach(() => {
    setWorld(undefined);
    vi.clearAllMocks();
  });

  it('emits read and read.complete spans with connect, ttfc, totals, and reconnects', async () => {
    const stream = createReconnectingFramedStream('run-123', 'test-stream');
    const reader = stream.getReader();
    for (let i = 0; i < 10; i++) {
      const { done } = await reader.read();
      if (done) break;
    }

    const [readSpan] = await waitForSpans('workflow.stream.read', 1);
    expect(readSpan).toBeDefined();
    expect(typeof readSpan.attributes['workflow.stream.read.ttfc_ms']).toBe(
      'number'
    );
    expect(typeof readSpan.attributes['workflow.stream.read.connect_ms']).toBe(
      'number'
    );

    const [doneSpan] = await waitForSpans('workflow.stream.read.complete', 1);
    expect(doneSpan).toBeDefined();
    expect(doneSpan.attributes['workflow.stream.read.chunks']).toBe(2);
    // 2 frames of (4-byte header + payload): (4+3) + (4+2)
    expect(doneSpan.attributes['workflow.stream.read.bytes']).toBe(13);
    expect(doneSpan.attributes['workflow.stream.read.reconnects']).toBe(0);
  });
});
