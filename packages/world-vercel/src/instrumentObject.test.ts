import { beforeEach, describe, expect, it, vi } from 'vitest';

type SpanCallback = (span?: {
  setAttributes: (attributes: Record<string, unknown>) => void;
}) => Promise<unknown>;

const mocks = vi.hoisted(() => {
  const span = { setAttributes: vi.fn() };
  return {
    span,
    trace: vi.fn(async (_spanName: string, _opts: unknown, fn: SpanCallback) =>
      fn(span)
    ),
    getSpanKind: vi.fn(async () => undefined),
  };
});

vi.mock('./telemetry.js', () => ({
  trace: mocks.trace,
  getSpanKind: mocks.getSpanKind,
  PeerService: (value: string) => ({ 'peer.service': value }),
  RpcSystem: (value: string) => ({ 'rpc.system': value }),
  RpcService: (value: string) => ({ 'rpc.service': value }),
  RpcMethod: (value: string) => ({ 'rpc.method': value }),
  WorkflowRunId: (value: string) => ({ 'workflow.run.id': value }),
  StepId: (value: string) => ({ 'step.id': value }),
}));

import { instrumentObject } from './instrumentObject.js';

describe('instrumentObject', () => {
  beforeEach(() => {
    mocks.span.setAttributes.mockClear();
    mocks.trace.mockClear();
  });

  it('stamps runs.get spans with workflow.run.id from the run id argument', async () => {
    const runs = instrumentObject('world.runs', {
      get: vi.fn(async (runId: string) => ({ runId })),
    });

    await runs.get('wrun_test');

    expect(mocks.span.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({ 'workflow.run.id': 'wrun_test' })
    );
  });

  it('stamps steps.get spans with workflow.run.id and step.id', async () => {
    const steps = instrumentObject('world.steps', {
      get: vi.fn(async () => ({ ok: true })),
    });

    await steps.get('wrun_test', 'step_test');

    expect(mocks.span.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        'workflow.run.id': 'wrun_test',
        'step.id': 'step_test',
      })
    );
  });

  it('stamps list spans with workflow.run.id from run-scoped params', async () => {
    const events = instrumentObject('world.events', {
      list: vi.fn(async () => ({ data: [] })),
    });

    await events.list({ runId: 'wrun_test' });

    expect(mocks.span.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({ 'workflow.run.id': 'wrun_test' })
    );
  });

  it('stamps hook lookup spans with workflow.run.id from the result', async () => {
    const hooks = instrumentObject('world.hooks', {
      getByToken: vi.fn(async () => ({ runId: 'wrun_test' })),
    });

    await hooks.getByToken('hook_token');

    expect(mocks.span.setAttributes).toHaveBeenCalledWith({
      'workflow.run.id': 'wrun_test',
    });
  });
});
