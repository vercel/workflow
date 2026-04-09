/**__internal_workflows{"steps":{"input.js":{"syncStep":{"stepId":"step//./input//syncStep"}}}}*/;
// Sync "use workflow" should still error (workflow functions must be async)
export function syncWorkflow() {
    'use workflow';
    return 'not allowed';
}
// Sync "use step" should NOT error (sync steps are allowed)
export var syncStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//syncStep");
