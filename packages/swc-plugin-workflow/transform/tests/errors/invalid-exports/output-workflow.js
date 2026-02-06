/**__internal_workflows{"steps":{"step//./input//validStep":{"name":"validStep","source":"input.js"}}}*/;
'use step';
// These should all error - only async functions allowed
export const value = 42;
export function syncFunc() {
    return 'not allowed';
}
export class MyClass {
    method() {}
}
export * from './other';
// This is ok
export var validStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//validStep");
