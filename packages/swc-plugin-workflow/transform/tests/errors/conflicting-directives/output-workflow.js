/**__internal_workflows{"steps":{"input.js":{"test":{"stepId":"step//./input//test"}}}}*/;
// Error: Can't have both directives in the same file
'use step';
'use workflow';
export var test = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//test");
