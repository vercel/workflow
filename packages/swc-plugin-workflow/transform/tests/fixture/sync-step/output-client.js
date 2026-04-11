/**__internal_workflows{"steps":{"input.js":{"asyncStep":{"stepId":"step//./input//asyncStep"},"obj/syncMethod":{"stepId":"step//./input//obj/syncMethod"},"syncArrow":{"stepId":"step//./input//syncArrow"},"syncStep":{"stepId":"step//./input//syncStep"}}}}*/;
var obj$syncMethod = function() {
    return true;
};
obj$syncMethod.stepId = "step//./input//obj/syncMethod";
// Sync functions with "use step" are allowed.
// This enables using "use step" as a mechanism to strip Node.js-dependent
// code from the workflow VM bundle.
export function syncStep() {
    return 42;
}
syncStep.stepId = "step//./input//syncStep";
export const syncArrow = ()=>{
    return 'hello';
};
syncArrow.stepId = "step//./input//syncArrow";
export const obj = {
    syncMethod: obj$syncMethod
};
// Async steps still work as before
export async function asyncStep(a, b) {
    return a + b;
}
asyncStep.stepId = "step//./input//asyncStep";
