import { registerStepFunction } from "workflow/internal/private";
/**__internal_workflows{"steps":{"input.js":{"asyncStep":{"stepId":"step//./input//asyncStep"},"obj/syncMethod":{"stepId":"step//./input//obj/syncMethod"},"syncArrow":{"stepId":"step//./input//syncArrow"},"syncStep":{"stepId":"step//./input//syncStep"}}}}*/;
var obj$syncMethod = function() {
    return true;
};
// Sync functions with "use step" are allowed.
// This enables using "use step" as a mechanism to strip Node.js-dependent
// code from the workflow VM bundle.
export function syncStep() {
    return 42;
}
export const syncArrow = ()=>{
    return 'hello';
};
const obj = {
    syncMethod () {
        return true;
    }
};
// Async steps still work as before
export async function asyncStep(a, b) {
    return a + b;
}
registerStepFunction("step//./input//syncStep", syncStep);
registerStepFunction("step//./input//syncArrow", syncArrow);
registerStepFunction("step//./input//asyncStep", asyncStep);
registerStepFunction("step//./input//obj/syncMethod", obj$syncMethod);
