/**__internal_workflows{"steps":{"input.js":{"syncFunc":{"stepId":"step//./input//syncFunc"},"validStep":{"stepId":"step//./input//validStep"}}}}*/;
'use step';
// These should all error - not functions
export const value = 42;
export class MyClass {
    method() {}
}
export * from './other';
// This is ok - sync functions are allowed in "use step" files
export var syncFunc = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//syncFunc");
// This is ok
export var validStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//validStep");
