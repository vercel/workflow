import { globalSingleton } from '@workflow/utils';
import { COMPUTE_INSTANCE_ID } from './compute-instance.js';

/**
 * Stdout diagnostics for single-owner runs: start-up phase timings, slow
 * phases, and a process heartbeat while an owner is active. A silent owner is
 * then distinguishable: heartbeats keep arriving while it waits, a large
 * `event_loop_lag` follows a blocked event loop, and nothing at all means the
 * process ended.
 *
 * Every line here is attributed to the request that started the owner, and
 * the platform keeps at most 256 lines per request: a 10 s heartbeat stays
 * within that for a whole 800 s owner lifetime.
 */
const HEARTBEAT_MS = 10_000;
const TICK_MS = 1000;
const LAG_LOG_MS = 500;

export interface OwnerDiagnosticsSource {
  diagnostics(): Record<string, unknown>;
}

export function ownerLog(event: string, fields: Record<string, unknown>) {
  console.info(
    JSON.stringify({
      component: 'workflow-owner',
      event,
      at: new Date().toISOString(),
      processInstanceId: COMPUTE_INSTANCE_ID,
      ...fields,
    })
  );
}

const monitor = globalSingleton('@workflow/core//ownerDiagnostics', 1, () => ({
  sources: new Set<OwnerDiagnosticsSource>(),
  timer: undefined as ReturnType<typeof setInterval> | undefined,
}));

function snapshot() {
  const memory = process.memoryUsage();
  return {
    rssMb: Math.round(memory.rss / 2 ** 20),
    heapUsedMb: Math.round(memory.heapUsed / 2 ** 20),
    owners: [...monitor.sources].map((source) => {
      try {
        return source.diagnostics();
      } catch {
        return { error: 'diagnostics unavailable' };
      }
    }),
  };
}

/** Track an active owner; the returned function stops tracking it. */
export function trackOwner(source: OwnerDiagnosticsSource): () => void {
  monitor.sources.add(source);
  if (!monitor.timer) {
    let expected = Date.now() + TICK_MS;
    let lastBeat = Date.now();
    monitor.timer = setInterval(() => {
      const now = Date.now();
      const lagMs = now - expected;
      expected = now + TICK_MS;
      if (lagMs > LAG_LOG_MS) {
        ownerLog('event_loop_lag', { lagMs, ...snapshot() });
        lastBeat = now;
      } else if (now - lastBeat >= HEARTBEAT_MS) {
        ownerLog('heartbeat', { lagMs, ...snapshot() });
        lastBeat = now;
      }
    }, TICK_MS);
    monitor.timer.unref?.();
  }
  return () => {
    monitor.sources.delete(source);
    if (!monitor.sources.size && monitor.timer) {
      clearInterval(monitor.timer);
      monitor.timer = undefined;
    }
  };
}
