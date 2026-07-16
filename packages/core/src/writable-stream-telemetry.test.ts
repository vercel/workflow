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
import { WorkflowServerWritableStream } from './serialization.js';

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

/**
 * The write-flush span is emitted fire-and-forget after the server write
 * settles, so poll briefly instead of asserting synchronously.
 */
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

describe('WorkflowServerWritableStream write-flush telemetry', () => {
  let mockStreams: {
    write: ReturnType<typeof vi.fn>;
    writeMulti: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    exporter.reset();
    mockStreams = {
      write: vi.fn().mockResolvedValue(undefined),
      writeMulti: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      streams: mockStreams,
    } as any);
  });

  afterEach(() => {
    setWorld(undefined);
    vi.clearAllMocks();
  });

  it('emits a CLIENT workflow.stream.flush span per flushed batch with dwell/chunk/byte attributes', async () => {
    const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
    const writer = stream.getWriter();

    await writer.write(new Uint8Array([1, 2, 3]));
    await writer.close();

    const [span] = await waitForSpans('workflow.stream.flush', 1);
    expect(span).toBeDefined();
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.attributes['workflow.run.id']).toBe('run-123');
    expect(span.attributes['workflow.stream.name']).toBe('test-stream');
    expect(span.attributes['workflow.stream.operation']).toBe('flush');
    expect(span.attributes['workflow.stream.flush.chunks']).toBe(1);
    expect(span.attributes['workflow.stream.flush.bytes']).toBe(3);

    // Client-observed World RPC duration (chunk_rtt) rides the flush span.
    const rtt = span.attributes['workflow.stream.write.chunk_rtt'];
    expect(typeof rtt).toBe('number');
    expect(rtt as number).toBeGreaterThanOrEqual(0);

    const dwell = span.attributes['workflow.stream.flush.buffer_dwell_ms'];
    expect(typeof dwell).toBe('number');
    expect(dwell as number).toBeGreaterThanOrEqual(0);

    // The back-dated span covers dwell + RPC, so its duration must be at
    // least the reported dwell.
    const durationMs = span.duration[0] * 1e3 + span.duration[1] / 1e6;
    expect(durationMs).toBeGreaterThanOrEqual(dwell as number);
  });

  it('emits one span per flush cycle', async () => {
    const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
    const writer = stream.getWriter();

    await writer.write(new Uint8Array([1]));
    await writer.write(new Uint8Array([2]));
    await writer.write(new Uint8Array([3]));
    await writer.close();

    const spans = await waitForSpans('workflow.stream.flush', 3);
    expect(spans).toHaveLength(3);
    for (const span of spans) {
      expect(span.attributes['workflow.stream.flush.chunks']).toBe(1);
    }
  });

  it('counts the turbo run-ready barrier wait as buffer dwell', async () => {
    let releaseBarrier!: () => void;
    const runReadyBarrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    const stream = new WorkflowServerWritableStream(
      'run-123',
      'test-stream',
      runReadyBarrier
    );
    const writer = stream.getWriter();

    const writePromise = writer.write(new Uint8Array([1, 2, 3]));
    // Hold the first flush on the barrier long enough to dominate the dwell.
    await new Promise((r) => setTimeout(r, 50));
    releaseBarrier();
    await writePromise;
    await writer.close();

    const [span] = await waitForSpans('workflow.stream.flush', 1);
    expect(span).toBeDefined();
    const dwell = span.attributes[
      'workflow.stream.flush.buffer_dwell_ms'
    ] as number;
    expect(dwell).toBeGreaterThanOrEqual(40);
  });

  it('emits a workflow.stream.close span with the close RPC duration', async () => {
    const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
    const writer = stream.getWriter();
    await writer.write(new Uint8Array([1]));
    await writer.close();

    const [span] = await waitForSpans('workflow.stream.close', 1);
    expect(span).toBeDefined();
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.attributes['workflow.stream.operation']).toBe('close');
    const rpc = span.attributes['workflow.stream.close.rpc_ms'];
    expect(typeof rpc).toBe('number');
  });

  it('does not emit spans for an empty close', async () => {
    const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
    const writer = stream.getWriter();
    await writer.close();

    // Give any stray fire-and-forget emit a chance to land.
    await new Promise((r) => setTimeout(r, 30));
    expect(
      exporter
        .getFinishedSpans()
        .filter((s) => s.name === 'workflow.stream.flush')
    ).toHaveLength(0);
  });
});
