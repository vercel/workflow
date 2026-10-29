import { readdirSync } from 'node:fs';
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
  /** Highest maxProcFds sampled since the last logged line. */
  peakFds: 0,
  processListeners: false,
}));

function errorFields(error: unknown) {
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: String(error instanceof Error ? error.message : error).slice(
      0,
      500
    ),
    errorStack:
      error instanceof Error ? error.stack?.slice(0, 2000) : undefined,
  };
}

/**
 * Log process-level failures while an owner is active. On Vercel the function
 * runtime treats any unhandled rejection or uncaught exception as
 * unrecoverable: the instance stops accepting requests (in-flight work,
 * including the owner's waitUntil, continues) and a strict-affinity instance
 * is retired, so the owner stops receiving inputs. The runtime does not
 * surface the error in runtime logs. Observation only: the exception monitor
 * never changes behavior, and the rejection listener is added only where one
 * is already installed (as the runtime does), so default handling is kept.
 */
function watchProcessFailures() {
  if (monitor.processListeners) return;
  monitor.processListeners = true;
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    ownerLog('uncaught_exception', { origin, ...errorFields(error) });
  });
  if (process.listenerCount('unhandledRejection') > 0)
    process.on('unhandledRejection', (reason) => {
      ownerLog('unhandled_rejection', errorFields(reason));
    });
}

/** Open file descriptors (entries, not numbers) of one process. */
function fdCount(pid: string): number | undefined {
  try {
    return readdirSync(`/proc/${pid}/fd`).length;
  } catch {
    return undefined;
  }
}

/**
 * The highest open-FD count of any visible process, as the function runtime
 * measures it (Linux only; undefined elsewhere). The runtime refuses new
 * requests while any in-flight request has seen 850 or more, and an owner's
 * starting request stays in flight for the owner's lifetime, so a brief spike
 * counts for that whole lifetime.
 */
function maxProcFds(): number | undefined {
  let pids: string[];
  try {
    pids = readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  } catch {
    return undefined;
  }
  let max: number | undefined;
  for (const pid of pids) {
    const count = fdCount(pid);
    if (count !== undefined) max = Math.max(max ?? 0, count);
  }
  return max;
}

function snapshot() {
  const memory = process.memoryUsage();
  const procMax = maxProcFds();
  const peakMaxProcFds = Math.max(monitor.peakFds, procMax ?? 0) || undefined;
  monitor.peakFds = 0;
  return {
    rssMb: Math.round(memory.rss / 2 ** 20),
    heapUsedMb: Math.round(memory.heapUsed / 2 ** 20),
    fds: fdCount('self'),
    maxProcFds: procMax,
    peakMaxProcFds,
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
  watchProcessFailures();
  if (!monitor.timer) {
    let expected = Date.now() + TICK_MS;
    let lastBeat = Date.now();
    monitor.timer = setInterval(() => {
      const now = Date.now();
      const lagMs = now - expected;
      expected = now + TICK_MS;
      monitor.peakFds = Math.max(monitor.peakFds, maxProcFds() ?? 0);
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
