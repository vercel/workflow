import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 60_000,
    // The e2e suites drive real deployments, so individual tests can lose
    // timing races (queue delays, cold starts, watcher latency) that a
    // second attempt absorbs. One CI retry keeps a single racy test from
    // failing a 20+ minute matrix job; retried tests stay visible — the
    // github-reporter annotates them and the PR comment lists them — so
    // real races still get looked at. Harnesses where a failure is itself
    // the signal (event-log-race-repro) pin `retry: 0` locally.
    // Local runs keep retry at 0 so races reproduce while debugging.
    retry: process.env.CI ? 1 : 0,
  },
  benchmark: {
    include: ['**/*.bench.ts'],
  },
});
