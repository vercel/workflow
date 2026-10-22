// Steps with the same local name in different block scopes are distinct
// functions and must get distinct hoisted bindings and step IDs.
// Unrelated names elsewhere in the file don't affect generated suffixes.
/**__internal_workflows{"workflows":{"input.js":{"collisionWorkflow":{"workflowId":"workflow//./input//collisionWorkflow"},"fnDeclWorkflow":{"workflowId":"workflow//./input//fnDeclWorkflow"},"objectWorkflow":{"workflowId":"workflow//./input//objectWorkflow"},"reservedSuffixWorkflow":{"workflowId":"workflow//./input//reservedSuffixWorkflow"},"suffixWorkflow":{"workflowId":"workflow//./input//suffixWorkflow"}}},"steps":{"input.js":{"collisionWorkflow/act":{"stepId":"step//./input//collisionWorkflow/act"},"collisionWorkflow/act~1":{"stepId":"step//./input//collisionWorkflow/act~1"},"fnDeclWorkflow/act":{"stepId":"step//./input//fnDeclWorkflow/act"},"fnDeclWorkflow/act~1":{"stepId":"step//./input//fnDeclWorkflow/act~1"},"objectWorkflow/helpers/act":{"stepId":"step//./input//objectWorkflow/helpers/act"},"objectWorkflow/helpers/act~1":{"stepId":"step//./input//objectWorkflow/helpers/act~1"},"reservedSuffixWorkflow/act":{"stepId":"step//./input//reservedSuffixWorkflow/act"},"reservedSuffixWorkflow/act$1":{"stepId":"step//./input//reservedSuffixWorkflow/act$1"},"reservedSuffixWorkflow/act~1":{"stepId":"step//./input//reservedSuffixWorkflow/act~1"},"suffixWorkflow/act":{"stepId":"step//./input//suffixWorkflow/act"},"suffixWorkflow/act$1":{"stepId":"step//./input//suffixWorkflow/act$1"},"suffixWorkflow/act~1":{"stepId":"step//./input//suffixWorkflow/act~1"}}}}*/;
export async function collisionWorkflow(operation, requestId) {
    if (operation === "validate") {
        const act = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//collisionWorkflow/act");
        return await act(requestId);
    } else {
        const act = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//collisionWorkflow/act~1");
        return await act(requestId);
    }
}
collisionWorkflow.workflowId = "workflow//./input//collisionWorkflow";
globalThis.__private_workflows.set("workflow//./input//collisionWorkflow", collisionWorkflow);
export async function fnDeclWorkflow(operation) {
    if (operation === "a") {
        var act = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//fnDeclWorkflow/act");
        return await act();
    }
    {
        var act = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//fnDeclWorkflow/act~1");
        return await act();
    }
}
fnDeclWorkflow.workflowId = "workflow//./input//fnDeclWorkflow";
globalThis.__private_workflows.set("workflow//./input//fnDeclWorkflow", fnDeclWorkflow);
export async function objectWorkflow(operation) {
    if (operation === "a") {
        const helpers = {
            act: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//objectWorkflow/helpers/act")
        };
        return await helpers.act();
    } else {
        const helpers = {
            act: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//objectWorkflow/helpers/act~1")
        };
        return await helpers.act();
    }
}
objectWorkflow.workflowId = "workflow//./input//objectWorkflow";
globalThis.__private_workflows.set("workflow//./input//objectWorkflow", objectWorkflow);
// A user-declared step named `act$1` doesn't affect the generated `act~1`
// step ID; only the hoisted bindings are renamed to stay unique.
export async function suffixWorkflow(operation) {
    if (operation === "a") {
        const act = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//suffixWorkflow/act");
        return await act();
    } else if (operation === "b") {
        const act$1 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//suffixWorkflow/act$1");
        return await act$1();
    } else {
        const act = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//suffixWorkflow/act~1");
        return await act();
    }
}
suffixWorkflow.workflowId = "workflow//./input//suffixWorkflow";
globalThis.__private_workflows.set("workflow//./input//suffixWorkflow", suffixWorkflow);
// An explicitly named step declared after the duplicates keeps its own name
// and ID regardless of source order.
export async function reservedSuffixWorkflow(operation) {
    if (operation === "a") {
        const act = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//reservedSuffixWorkflow/act");
        return await act();
    } else if (operation === "b") {
        const act = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//reservedSuffixWorkflow/act~1");
        return await act();
    } else {
        const act$1 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//reservedSuffixWorkflow/act$1");
        return await act$1();
    }
}
reservedSuffixWorkflow.workflowId = "workflow//./input//reservedSuffixWorkflow";
globalThis.__private_workflows.set("workflow//./input//reservedSuffixWorkflow", reservedSuffixWorkflow);
