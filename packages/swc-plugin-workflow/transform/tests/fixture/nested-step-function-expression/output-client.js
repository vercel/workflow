/**__internal_workflows{"workflows":{"input.js":{"closureSteps":{"workflowId":"workflow//./input//closureSteps"},"usesModuleLevel":{"workflowId":"workflow//./input//usesModuleLevel"},"usesWrapper":{"workflowId":"workflow//./input//usesWrapper"}}},"steps":{"input.js":{"fn":{"stepId":"step//./input//fn"},"moduleLevel":{"stepId":"step//./input//moduleLevel"}}}}*/;
// A `"use step"` function expression bound to a const inside a function is a
// nested step, like the arrow form: hoisted, namespaced by the enclosing
// function, and given the closure variables it captures.
export async function closureSteps(n, label) {
    throw new Error("You attempted to execute workflow closureSteps function directly. To start a workflow, use start(closureSteps) from workflow/api");
}
closureSteps.workflowId = "workflow//./input//closureSteps";
export async function usesWrapper() {
    throw new Error("You attempted to execute workflow usesWrapper function directly. To start a workflow, use start(usesWrapper) from workflow/api");
}
usesWrapper.workflowId = "workflow//./input//usesWrapper";
// At module level it stays a module-level step.
const moduleLevel = async function() {
    return 1;
};
moduleLevel.stepId = "step//./input//moduleLevel";
export async function usesModuleLevel() {
    throw new Error("You attempted to execute workflow usesModuleLevel function directly. To start a workflow, use start(usesModuleLevel) from workflow/api");
}
usesModuleLevel.workflowId = "workflow//./input//usesModuleLevel";
