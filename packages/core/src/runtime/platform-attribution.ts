/**
 * Tells the hosting runtime which Workflow run the current request is
 * executing, so the platform can attribute the invocation to it.
 *
 * A delivery used to run only in the generated flow route, so the platform
 * recognized Workflow work from the request path and the queue's delivery
 * headers. A delivery can now also run inline, inside the route that called
 * `start()` or `resumeHook()`, usually after its response was sent. That
 * request carries neither, so every delivery reports its run here instead.
 * On Vercel, the platform uses it to mark the invocation as Workflow work in
 * usage reporting and to tag the request's logs with the run ID, which is how
 * a run's logs include an inline delivery.
 *
 * The hook is optional: outside Vercel, or on a runtime that predates it,
 * this does nothing. It never throws.
 */

const RUNTIME_IPC = Symbol.for('@vercel/rusty-runtime-ipc');

interface RuntimeIpc {
  reportWorkflowInvocation?: (info: { runId: string }) => void;
}

export function reportWorkflowInvocation(runId: string): void {
  try {
    const ipc = (globalThis as { [RUNTIME_IPC]?: RuntimeIpc })[RUNTIME_IPC];
    ipc?.reportWorkflowInvocation?.({ runId });
  } catch {
    // Attribution is best effort and must not fail the delivery.
  }
}
