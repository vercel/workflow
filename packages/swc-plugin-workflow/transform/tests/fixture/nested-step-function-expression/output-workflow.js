/**__internal_workflows{"workflows":{"input.js":{"closureSteps":{"workflowId":"workflow//./input//closureSteps"},"usesModuleLevel":{"workflowId":"workflow//./input//usesModuleLevel"},"usesWrapper":{"workflowId":"workflow//./input//usesWrapper"}}},"steps":{"input.js":{"closureSteps/anonymous":{"stepId":"step//./input//closureSteps/anonymous"},"closureSteps/named":{"stepId":"step//./input//closureSteps/named"},"moduleLevel":{"stepId":"step//./input//moduleLevel"},"stepWrapperReturnNamedFunctionExprVar/fn":{"stepId":"step//./input//stepWrapperReturnNamedFunctionExprVar/fn"}}}}*/;
// A `"use step"` function expression bound to a const inside a function is a
// nested step, like the arrow form: hoisted, namespaced by the enclosing
// function, and given the closure variables it captures.
export async function closureSteps(n, label) {
    const named = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//closureSteps/named", ()=>({
            label,
            n
        }));
    const anonymous = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//closureSteps/anonymous", ()=>({
            n
        }));
    return [
        await named(),
        await anonymous()
    ];
}
closureSteps.workflowId = "workflow//./input//closureSteps";
globalThis.__private_workflows.set("workflow//./input//closureSteps", closureSteps);
function stepWrapperReturnNamedFunctionExprVar(a, b) {
    const fn = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//stepWrapperReturnNamedFunctionExprVar/fn", ()=>({
            a,
            b
        }));
    return fn;
}
export async function usesWrapper() {
    return stepWrapperReturnNamedFunctionExprVar(1, 2)();
}
usesWrapper.workflowId = "workflow//./input//usesWrapper";
globalThis.__private_workflows.set("workflow//./input//usesWrapper", usesWrapper);
// At module level it stays a module-level step.
const moduleLevel = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//moduleLevel");
export async function usesModuleLevel() {
    return moduleLevel();
}
usesModuleLevel.workflowId = "workflow//./input//usesModuleLevel";
globalThis.__private_workflows.set("workflow//./input//usesModuleLevel", usesModuleLevel);
