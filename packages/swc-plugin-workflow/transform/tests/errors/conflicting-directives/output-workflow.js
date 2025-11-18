// Error: Can't have both directives in the same file
/**__internal_workflows{"steps":{"input.js":{"test":{"stepId":"step//input.js//test"}}}}*/;
'use step';
'use workflow';
export var test = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//test");
