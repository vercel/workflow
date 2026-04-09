/**__internal_workflows{"steps":{"input.js":{"arrowStep":{"stepId":"step//./input//arrowStep"},"asyncArrow":{"stepId":"step//./input//asyncArrow"},"syncFunc":{"stepId":"step//./input//syncFunc"},"validStep":{"stepId":"step//./input//validStep"}}}}*/;
// These should all error - not functions
export const value = 42;
export class MyClass {
    method() {}
}
export * from './other';
export let uninitVar;
// Local named exports also error (can't verify binding is a function)
const helper = 'not a function';
export { helper };
// Re-export with specifiers also errors
export { something } from './re-export';
// These are ok - sync and async functions are allowed in "use step" files
export function syncFunc() {
    return 'allowed';
}
syncFunc.stepId = "step//./input//syncFunc";
export async function validStep() {
    return 'allowed';
}
validStep.stepId = "step//./input//validStep";
export const arrowStep = ()=>'allowed';
arrowStep.stepId = "step//./input//arrowStep";
export const asyncArrow = async ()=>'allowed';
asyncArrow.stepId = "step//./input//asyncArrow";
