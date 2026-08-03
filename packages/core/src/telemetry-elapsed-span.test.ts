import { trace as otelTrace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { recordElapsedSpan } from './telemetry.js';

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

afterEach(() => {
  exporter.reset();
});

describe('recordElapsedSpan (back-dated timing span)', () => {
  it('emits a span whose duration reflects the back-dated interval', async () => {
    const startMs = Date.now() - 250;
    await recordElapsedSpan('workflow.stream.read', startMs, {
      attributes: { 'workflow.stream.read.ttfc_ms': 250 },
    });

    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === 'workflow.stream.read');
    expect(span).toBeDefined();
    expect(span!.attributes['workflow.stream.read.ttfc_ms']).toBe(250);
    // duration is hrtime [seconds, nanos]; the 250ms back-date should show up.
    const durationSec = span!.duration[0] + span!.duration[1] / 1e9;
    expect(durationSec).toBeGreaterThanOrEqual(0.2);
  });
});
