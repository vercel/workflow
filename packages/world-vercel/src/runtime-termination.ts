import { request as httpRequest } from 'node:http';

/**
 * Notice that Vercel has begun stopping this function instance.
 *
 * A stopping instance's runtime drains: it admits no new requests while
 * in-flight work, including `waitUntil`, continues, and it signals the
 * function process only after that work ends. Long-lived work that waits for
 * new requests (a single-owner run's owner) would otherwise idle until its own
 * timeout. The runtime does report its state on its local API server: the
 * readiness endpoint (the preflight admission check, without reserving a
 * slot) answers 502 with a reason code once the instance is shutting down or
 * terminating. 503 means only busy, and 200 accepting.
 *
 * The endpoint is internal to the Vercel runtime and undocumented; this is a
 * best-effort signal. It is read only while someone is subscribed, and only
 * on Vercel.
 */
const PROBE_INTERVAL_MS = 1000;
const PROBE_TIMEOUT_MS = 500;
/** Status changes logged per process. */
const CHANGE_LINES = 30;

interface Probe {
  status?: number;
  code?: string;
  error?: string;
  ms: number;
}

type Listener = (reason: string) => void;

interface Target {
  host: string;
  port: number;
  intervalMs: number;
  /** Whether this process runs where the target exists. */
  enabled: () => boolean;
}

function probe(target: Target): Promise<Probe> {
  const started = performance.now();
  return new Promise((resolve) => {
    const done = (result: Omit<Probe, 'ms'>) =>
      resolve({ ...result, ms: Math.round(performance.now() - started) });
    const req = httpRequest(
      {
        host: target.host,
        port: target.port,
        method: 'HEAD',
        path: '/.well-known/vercel/ready',
        timeout: PROBE_TIMEOUT_MS,
      },
      (res) => {
        res.resume();
        const code = res.headers['x-vercel-internal-rusty-error'];
        done({
          status: res.statusCode,
          ...(code ? { code: String(code).slice(0, 100) } : {}),
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error) => done({ error: error.message.slice(0, 100) }));
    req.end();
  });
}

function log(event: string, fields: Record<string, unknown>) {
  console.info(
    JSON.stringify({
      component: 'workflow-runtime-termination',
      event,
      at: new Date().toISOString(),
      ...fields,
    })
  );
}

/** A process-wide watcher of one runtime's readiness (internal; tests use
 * their own target). */
export function createRuntimeTermination(target: Target) {
  const state = {
    listeners: new Set<Listener>(),
    timer: undefined as ReturnType<typeof setInterval> | undefined,
    probing: false,
    last: undefined as Probe | undefined,
    changes: 0,
    /** Set once the instance is known to be stopping; it never recovers. */
    terminated: undefined as string | undefined,
  };

  function stop() {
    if (!state.timer) return;
    clearInterval(state.timer);
    state.timer = undefined;
  }

  function terminate(reason: string) {
    if (state.terminated) return;
    state.terminated = reason;
    log('terminating', { reason });
    stop();
    for (const listener of [...state.listeners]) {
      state.listeners.delete(listener);
      try {
        listener(reason);
      } catch (error) {
        console.error('[workflow] Runtime termination listener failed', error);
      }
    }
  }

  async function sample() {
    if (state.probing || state.terminated) return;
    state.probing = true;
    const result = await probe(target);
    state.probing = false;
    const previous = state.last;
    state.last = result;
    if (
      (previous?.status !== result.status ||
        previous?.code !== result.code ||
        previous?.error !== result.error) &&
      state.changes < CHANGE_LINES
    ) {
      state.changes++;
      log('readiness', { ...result, previous });
    }
    // 502 is the runtime's answer once it is shutting down, terminating, or
    // its child has failed: in every case it admits no new request again.
    if (result.status === 502) terminate(result.code ?? 'runtime_unavailable');
  }

  return function onRuntimeTermination(listener: Listener): () => void {
    if (state.terminated) {
      const reason = state.terminated;
      queueMicrotask(() => listener(reason));
      return () => {};
    }
    if (!target.enabled()) return () => {};
    state.listeners.add(listener);
    if (!state.timer) {
      state.timer = setInterval(() => void sample(), target.intervalMs);
      state.timer.unref?.();
    }
    return () => {
      state.listeners.delete(listener);
      if (!state.listeners.size) stop();
    };
  };
}

/** `World.onRuntimeTermination` for Vercel: the function runtime's local API
 * server, polled once a second while subscribed. */
export const onRuntimeTermination = createRuntimeTermination({
  host: '127.0.0.1',
  port: 80,
  intervalMs: PROBE_INTERVAL_MS,
  enabled: () => process.env.VERCEL === '1',
});
