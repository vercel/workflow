import {
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
} from '@workflow/core/serialization';
import type { World } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatTableValue, showHook, showRun, showStep } from './output.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BigInt inspect output', () => {
  const runId = 'wrun_01K4BZQ5T2J8HXFM6WD3PNAVCE';
  const value = { count: 9007199254740993n, nested: [0n, -9007199254740993n] };
  const expected = {
    count: '9007199254740993',
    nested: ['0', '-9007199254740993'],
  };

  it.each([
    'run',
    'step',
    'hook',
  ] as const)('prints hydrated %s payloads as JSON without losing precision', async (resource) => {
    const input = await dehydrateWorkflowArguments([value], runId, undefined);
    const output = await dehydrateStepReturnValue(value, runId, undefined);
    const world = {
      runs: { get: vi.fn().mockResolvedValue({ runId, input, output }) },
      steps: {
        get: vi
          .fn()
          .mockResolvedValue({ runId, stepId: 'step-1', input, output }),
      },
      hooks: {
        get: vi
          .fn()
          .mockResolvedValue({ runId, hookId: 'hook-1', metadata: output }),
      },
    } as unknown as World;
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const show = {
      run: showRun,
      step: showStep,
      hook: showHook,
    }[resource];

    await show(world, resource === 'run' ? runId : 'resource-1', {
      runId,
      json: true,
    });

    const actual = JSON.parse(String(write.mock.calls[0][0]));
    if (resource === 'hook') {
      expect(actual.metadata).toEqual(expected);
    } else {
      expect(actual.input).toEqual([expected]);
      expect(actual.output).toEqual(expected);
    }
  });

  it.each([
    'input',
    'output',
    'error',
    'eventData',
  ])('formats nested BigInt in the %s table column', (prop) => {
    expect(String(formatTableValue(prop, { n: 1n }, {}))).toBe('{"n":"1"}');
  });

  it('shows scalar and array BigInt values in IO table columns', () => {
    expect(formatTableValue('output', 1n, {})).toBe('1');
    expect(formatTableValue('input', [0n, -1n], {})).toBe('0,-1');
  });
});
