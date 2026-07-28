import { runInNewContext } from 'node:vm';
import { FatalError } from '@workflow/errors';
import type {
  EventRequestOfType,
  EventResultFor,
  Step,
  WorkflowRun,
} from '@workflow/world';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { isAbortError, promoteAbortErrorToFatal } from './types.js';

describe('EventResultFor', () => {
  it('requires the entity returned by runtime setup events', () => {
    expectTypeOf<
      EventResultFor<EventRequestOfType<'run_created'>>['run']
    >().toEqualTypeOf<WorkflowRun>();
    expectTypeOf<
      EventResultFor<EventRequestOfType<'run_started'>>['run']
    >().toEqualTypeOf<WorkflowRun>();
    expectTypeOf<
      EventResultFor<EventRequestOfType<'step_started'>>['step']
    >().toEqualTypeOf<Step>();
    expectTypeOf<
      EventResultFor<EventRequestOfType<'run_started'>>['run']['startedAt']
    >().toEqualTypeOf<Date | undefined>();
    expectTypeOf<
      EventResultFor<EventRequestOfType<'step_started'>>['step']['startedAt']
    >().toEqualTypeOf<Date | undefined>();
  });
});

describe('isAbortError', () => {
  it('recognizes an AbortError from another realm', () => {
    const error = runInNewContext(
      'Object.assign(new Error("cancelled"), { name: "AbortError" })'
    );

    expect(error).not.toBeInstanceOf(Error);
    expect(isAbortError(error)).toBe(true);
  });

  it.each([
    { name: 'AbortError', message: 'serialized abort' },
    new DOMException('dom abort', 'AbortError'),
  ])('recognizes abort-shaped values', (error) => {
    expect(isAbortError(error)).toBe(true);
  });

  it.each([
    null,
    undefined,
    { name: 'TypeError', message: 'not an abort' },
    { name: 'AbortError' },
    { name: 'AbortError', message: 42 },
    { name: 'AbortError', message: 'bad stack', stack: 42 },
  ])('rejects non-abort values', (value) => {
    expect(isAbortError(value)).toBe(false);
  });
});

describe('promoteAbortErrorToFatal', () => {
  it('promotes an abort-shaped value to FatalError and preserves its stack', () => {
    const error = {
      name: 'AbortError',
      message: 'cancelled',
      stack: 'AbortError: cancelled',
    };

    const promoted = promoteAbortErrorToFatal(error);

    expect(FatalError.is(promoted)).toBe(true);
    expect(promoted).toMatchObject({
      name: 'FatalError',
      message: 'Aborted: cancelled',
      stack: error.stack,
    });
  });

  it('preserves an already fatal abort error', () => {
    const error = Object.assign(new FatalError('already fatal'), {
      name: 'AbortError',
    });

    expect(promoteAbortErrorToFatal(error)).toBe(error);
  });
});
