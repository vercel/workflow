/**__internal_workflows{"steps":{"input.js":{"syncFunc":{"stepId":"step//./input//syncFunc"},"validStep":{"stepId":"step//./input//validStep"}}}}*/;
// These should all error - not functions
export const value = 42;
export class MyClass {
    method() {}
}
export * from './other';
// This is ok - sync functions are allowed in "use step" files
export function syncFunc() {
    return 'allowed';
}
syncFunc.stepId = "step//./input//syncFunc";
// This is ok
export async function validStep() {
    return 'allowed';
}
validStep.stepId = "step//./input//validStep";
