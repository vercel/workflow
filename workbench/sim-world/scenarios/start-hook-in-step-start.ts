import type { CallContext, ScenarioSpec } from '@workflow/world-sim';

/**
 * A step starts a child with a start Hook and cannot tell whether it worked:
 * either the child's `run_created` response is lost (the step sees
 * `WorkflowStartError` and retries), or the step's whole delivery dies right
 * after that write commits (the queue redelivers and the step runs again).
 * Either way the step's next attempt is a new candidate with the same token,
 * refused naming the child the first attempt created.
 */
function inStepStart(fault: 'lost-response' | 'step-dies'): ScenarioSpec {
  const token = `child:${fault}`;
  const childCreate = {
    eventType: 'run_created' as const,
    where: (ctx: CallContext) =>
      (ctx.request?.eventData as { startHook?: { token?: string } } | undefined)
        ?.startHook?.token === token,
  };
  return {
    id: `start-hook-in-step-start-${fault}`,
    name:
      fault === 'lost-response'
        ? "start Hook: a step's start() loses the child's run_created response, and the step retries"
        : "start Hook: a step's delivery dies after the child's run_created commits, and the step reruns",
    description:
      'Exactly one child run, and the retried step learns it from the ' +
      'refusal of its own second candidate.',
    workflow: 'inStepStartWorkflow',
    input: [token],
    startHooks: true,
    script: async (sim) => {
      const hit =
        fault === 'lost-response'
          ? sim.fault.loseResponse(childCreate)
          : sim.fault.die(
              childCreate,
              "the parent's delivery dies inside the step"
            );
      const child = (await hit).runId ?? '';
      const done = await sim.until(
        { eventType: 'step_completed', runId: sim.runId },
        'the step finishes'
      );
      sim.check(
        'exactly one child run',
        sim.world.runs().filter((r) => r.runId !== sim.runId).length === 1 &&
          sim.world.run(child) !== undefined
      );
      sim.check(
        "the retry's candidate was refused naming the child",
        sim.world
          .rejections()
          .some(
            (r) =>
              r.eventType === 'run_created' &&
              r.errorName === 'HookConflictError' &&
              r.message.includes(child)
          )
      );
      sim.check(
        'the step finished on a later attempt',
        sim.world
          .steps(sim.runId)
          .some(
            (st) => st.stepId === done.event?.correlationId && st.attempt > 1
          )
      );
    },
    expect: { status: 'completed' },
  };
}

export const lostResponse = inStepStart('lost-response');
export const stepDies = inStepStart('step-dies');
