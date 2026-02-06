/**__internal_workflows{"steps":{"step//./input//test":{"name":"test","source":"input.js"}}}*/;
// Error: Can't have both directives in the same file
'use step';
'use workflow';
export var test = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//test");
