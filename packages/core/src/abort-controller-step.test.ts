/**
 * Tests for AbortController/AbortSignal behavior in step context.
 *
 * When an AbortController or AbortSignal is deserialized inside a step function,
 * it becomes a real AbortSignal backed by a stream. These tests verify that the
 * stream reader is set up correctly, abort propagation works, and the ops queue
 * is used for async work (stream write + hook resume).
 */

import { describe, it } from 'vitest';

describe('AbortSignal deserialized in step context', () => {
  describe('stream reader setup', () => {
    it.todo(
      'deserialized signal pushes a stream reader promise into ops array'
    );

    it.todo('already-aborted signal does not set up a stream reader');

    it.todo('already-aborted signal has signal.aborted === true immediately');
  });

  describe('abort propagation via stream', () => {
    it.todo('stream packet triggers abort on deserialized signal');

    it.todo('stream packet with reason propagates signal.reason');

    it.todo(
      'signal.addEventListener("abort", fn) fires when stream packet arrives'
    );

    it.todo('signal.throwIfAborted() throws after stream packet arrives');
  });

  describe('abort() on deserialized controller', () => {
    it.todo('abort() pushes stream write promise into ops array');

    it.todo('abort() pushes hook resume promise into ops array');

    it.todo(
      'abort() sets signal.aborted to true synchronously (local behavior)'
    );

    it.todo('abort() after step context is gone does not crash');
  });

  describe('multiple consumers', () => {
    it.todo('multiple steps with the same stream name all receive the abort');

    it.todo(
      'AbortSignal.any() with deserialized + local signals works correctly'
    );
  });

  describe('abort errors wrapped in FatalError', () => {
    it.todo(
      'AbortError from fetch is wrapped in FatalError (skips retries)'
    );

    it.todo(
      'error from signal.throwIfAborted() is wrapped in FatalError'
    );

    it.todo(
      'custom abort reason is preserved inside the FatalError wrapper'
    );

    it.todo(
      'abort error skips retries regardless of step maxRetries config'
    );

    it.todo(
      'non-abort errors in a step with an AbortSignal are NOT wrapped in FatalError'
    );
  });
});
