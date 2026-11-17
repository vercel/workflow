import { __private_getClosureVars, registerStepFunction } from "workflow/internal/private";
/**__internal_workflows{"workflows":{"input.js":{"closureSteps":{"workflowId":"workflow//./input//closureSteps"},"usesModuleLevel":{"workflowId":"workflow//./input//usesModuleLevel"},"usesWrapper":{"workflowId":"workflow//./input//usesWrapper"}}},"steps":{"input.js":{"anonymous":{"stepId":"step//./input//closureSteps/anonymous"},"fn":{"stepId":"step//./input//stepWrapperReturnNamedFunctionExprVar/fn"},"moduleLevel":{"stepId":"step//./input//moduleLevel"},"named":{"stepId":"step//./input//closureSteps/named"}}}}*/;
async function closureSteps$named() {
    const { label, n } = __private_getClosureVars();
    return `${label}:${n + 1}`;
}
async function closureSteps$anonymous() {
    const { n } = __private_getClosureVars();
    return n * 2;
}
async function stepWrapperReturnNamedFunctionExprVar$fn() {
    const { a, b } = __private_getClosureVars();
    return a + b;
}
// A `"use step"` function expression bound to a const inside a function is a
// nested step, like the arrow form: hoisted, namespaced by the enclosing
// function, and given the closure variables it captures.
export async function closureSteps(n, label) {
    throw new Error("You attempted to execute workflow closureSteps function directly. To start a workflow, use start(closureSteps) from workflow/api");
}
closureSteps.workflowId = "workflow//./input//closureSteps";
function stepWrapperReturnNamedFunctionExprVar(a, b) {
    const fn = async function inner() {
        return a + b;
    };
    return fn;
}
export async function usesWrapper() {
    throw new Error("You attempted to execute workflow usesWrapper function directly. To start a workflow, use start(usesWrapper) from workflow/api");
}
usesWrapper.workflowId = "workflow//./input//usesWrapper";
// At module level it stays a module-level step.
const moduleLevel = async function() {
    return 1;
};
export async function usesModuleLevel() {
    throw new Error("You attempted to execute workflow usesModuleLevel function directly. To start a workflow, use start(usesModuleLevel) from workflow/api");
}
usesModuleLevel.workflowId = "workflow//./input//usesModuleLevel";
registerStepFunction("step//./input//moduleLevel", moduleLevel);
registerStepFunction("step//./input//closureSteps/named", closureSteps$named);
registerStepFunction("step//./input//closureSteps/anonymous", closureSteps$anonymous);
registerStepFunction("step//./input//stepWrapperReturnNamedFunctionExprVar/fn", stepWrapperReturnNamedFunctionExprVar$fn);
