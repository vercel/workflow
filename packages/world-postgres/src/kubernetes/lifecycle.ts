/**
 * What a process runs as in the Helm chart (`WORKFLOW_ROLE`):
 *
 * - `service`: the main Deployment. Serves the application, the probes and
 *   the backlog endpoints, and runs its own deployment's workflows.
 * - `worker`: a deployment's worker Deployment. Runs its workflows and
 *   serves only the probes.
 * - `prune`: the prune CronJob. Prunes once and exits.
 */
export type WorkflowRole = 'service' | 'worker' | 'prune';

/** `WORKFLOW_ROLE`, defaulting to `service`. */
export function resolveWorkflowRole(
  env: Record<string, string | undefined> = process.env
): WorkflowRole {
  const role = env.WORKFLOW_ROLE || 'service';
  if (role !== 'service' && role !== 'worker' && role !== 'prune') {
    throw new Error(
      `WORKFLOW_ROLE must be service, worker or prune, got ${JSON.stringify(role)}`
    );
  }
  return role;
}

export interface LifecycleOptions {
  /**
   * Stops the process's work, in order: typically closing the HTTP server,
   * then `world.close()`, which stops claiming deliveries and waits for the
   * running ones, then the pool. Called once.
   */
  close: () => Promise<void>;
  /**
   * How long to keep serving after the first signal while reporting not
   * ready, so the endpoints controller removes the pod from its Service
   * before it stops accepting connections. Default 5000.
   */
  propagationDelayMs?: number;
  /** Signals that start the drain. Default `SIGTERM` and `SIGINT`. */
  signals?: NodeJS.Signals[];
  /** Called with the exit code once closed. Default `process.exit`. */
  exit?: (code: number) => void;
  /** Liveness and readiness paths. Defaults `/healthz` and `/readyz`. */
  livenessPath?: string;
  readinessPath?: string;
}

export interface Lifecycle {
  /** Whether a drain has started; readiness reports 503 from then on. */
  readonly draining: boolean;
  /**
   * The probe response for a path, or `undefined` when the path is not a
   * probe: liveness is always 200, readiness 503 once draining.
   */
  probe(pathname: string): { status: number; body: unknown } | undefined;
  /** Starts the drain as a signal would; resolves once closed. */
  drain(): Promise<void>;
  /** Removes the signal handlers. */
  dispose(): void;
}

/**
 * Graceful shutdown for a pod running this World: on SIGTERM it reports not
 * ready, waits for the pod to leave its Service, then closes. A delivery that
 * does not finish within the pod's `terminationGracePeriodSeconds` is
 * redelivered to another pod of the same deployment once its job lock goes
 * stale, so keep that period above the longest delivery you expect.
 */
export function createLifecycle({
  close,
  propagationDelayMs = 5000,
  signals = ['SIGTERM', 'SIGINT'],
  exit = (code) => process.exit(code),
  livenessPath = '/healthz',
  readinessPath = '/readyz',
}: LifecycleOptions): Lifecycle {
  let draining = false;
  let drained: Promise<void> | undefined;

  const drain = () => {
    drained ??= (async () => {
      draining = true;
      await new Promise((resolve) => setTimeout(resolve, propagationDelayMs));
      let code = 0;
      try {
        await close();
      } catch (error) {
        console.error('[world-postgres] Shutdown failed:', error);
        code = 1;
      }
      exit(code);
    })();
    return drained;
  };
  const onSignal = () => {
    void drain();
  };
  for (const signal of signals) process.once(signal, onSignal);

  return {
    get draining() {
      return draining;
    },
    probe(pathname) {
      if (pathname === livenessPath) return { status: 200, body: { ok: true } };
      if (pathname === readinessPath) {
        return {
          status: draining ? 503 : 200,
          body: { ready: !draining },
        };
      }
      return undefined;
    },
    drain,
    dispose() {
      for (const signal of signals) process.removeListener(signal, onSignal);
    },
  };
}
