/**__internal_workflows{"steps":{"input.js":{"foo":{"stepId":"step//./input//foo"},"helpers/act~1":{"stepId":"step//./input//helpers/act~1"}}}}*/;
// An object property step inside a step body is only seen by step mode. It
// shares the `helpers/act` namespace with the module-level `helpers.act` step,
// which both modes see, so the two modes must agree on which body is which.
export var foo = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//foo");
export const helpers = {
    act: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//helpers/act~1")
};
