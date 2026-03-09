/**
 * Tests for AbortController/AbortSignal behavior in the workflow VM context.
 *
 * These tests verify that `new AbortController()` inside a workflow function
 * creates a durable controller backed by a hook (for replay) and a stream
 * (for real-time step propagation).
 */

import { describe, expect, it } from 'vitest';

// import { createContext } from './vm/index.js';

describe('AbortController in workflow VM', () => {
  // const { context, globalThis: vmGlobalThis } = createContext({
  //   seed: 'test-abort',
  //   fixedTimestamp: 1714857600000,
  // });

  describe('standard AbortController API', () => {
    it.todo('new AbortController() returns object with .signal and .abort()');

    it.todo('controller.abort() sets signal.aborted to true');

    it.todo('controller.abort(reason) sets signal.reason');

    it.todo('controller.abort() called twice is a no-op');

    it.todo('signal.aborted is false initially');

    it.todo('signal.addEventListener("abort", fn) fires callback when aborted');

    it.todo(
      'signal.removeEventListener("abort", fn) prevents callback from firing'
    );

    it.todo('signal.throwIfAborted() throws when aborted');

    it.todo('signal.throwIfAborted() is a no-op when not aborted');

    it.todo('multiple controllers have independent state');
  });

  describe('AbortSignal static methods', () => {
    it.todo('AbortSignal.abort() returns a pre-aborted signal');

    it.todo(
      'AbortSignal.abort(reason) returns a pre-aborted signal with reason'
    );

    it.todo(
      'AbortSignal.any([signal1, signal2]) fires when any input signal fires'
    );

    it.todo(
      'AbortSignal.any() with a pre-aborted input is immediately aborted'
    );

    it.todo(
      'AbortSignal.timeout() throws an error with ABORT_SIGNAL_TIMEOUT_IN_WORKFLOW slug'
    );
  });

  describe('hook integration', () => {
    it.todo('new AbortController() creates a hook entry in invocations queue');

    it.todo('controller.abort() marks the hook for resumption in the queue');

    it.todo(
      'deterministic hook correlationId: same seed produces same ID across runs'
    );
  });
});
