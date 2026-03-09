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
});
