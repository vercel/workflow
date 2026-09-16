import { registerLifecycleHooks, resumeHook } from 'workflow/api';

/**
 * E2E coverage for `registerLifecycleHooks` (see the "lifecycle hooks"
 * describe in packages/core/e2e/e2e.test.ts and the fixtures in
 * workflows/99_e2e.ts).
 *
 * The handlers observe the `lifecycleHookTarget*` workflows' terminal
 * transitions and report them by resuming the `lifecycleHookObserver`
 * workflow's hook. Resuming a durable hook is deliberately the observation
 * channel: the handler runs on whichever instance wrote the terminal event,
 * which on a deployed app is generally NOT the instance serving the e2e
 * test's HTTP requests — an in-memory buffer would not travel.
 */
export function registerE2eLifecycleHooks(): void {
  registerLifecycleHooks({
    async onRunCompleted({ run }) {
      // Fires for every completed run in the app, so filter cheaply by
      // workflow name (a metadata read) before touching the return value.
      const workflowName = await run.workflowName;
      if (!workflowName?.includes('lifecycleHookTargetCompleted')) {
        return;
      }
      // Lazy hydration: the return value is only fetched for matching runs.
      const returnValue = (await run.returnValue) as {
        token: string;
        outcome: string;
      };
      await resumeHook(returnValue.token, {
        observed: 'completed',
        runId: run.runId,
        workflowName,
        returnedOutcome: returnValue.outcome,
      });
    },
    async onRunFailed({ run, error }) {
      // The hydrated thrown value is already on the error — no backend
      // reads needed to filter.
      const cause = error.cause;
      const causeMessage =
        cause instanceof Error ? cause.message : String(cause);
      const match = causeMessage.match(/lifecycle-hook-target-failed:(\S+)/);
      if (!match) {
        return;
      }
      await resumeHook(match[1], {
        observed: 'failed',
        runId: run.runId,
        errorCode: error.errorCode,
        causeName: cause instanceof Error ? cause.name : typeof cause,
        causeMessage,
      });
    },
  });
}
