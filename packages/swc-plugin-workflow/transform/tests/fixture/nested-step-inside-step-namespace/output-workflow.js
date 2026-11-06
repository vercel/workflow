/**__internal_workflows{"workflows":{"input.js":{"wf":{"workflowId":"workflow//./input//wf"}}},"steps":{"input.js":{"foo":{"stepId":"step//./input//foo"},"foo/x~1":{"stepId":"step//./input//foo/x~1"}}}}*/;
// A step nested inside a step body is only seen by step mode. It shares the
// `foo/x` namespace with a step nested in a workflow's helper `foo`, which both
// modes see, so it must not take that step's ID.
export var foo = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//foo");
export async function wf() {
    function foo() {
        const x = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//foo/x~1");
        return x;
    }
    return await foo()();
}
wf.workflowId = "workflow//./input//wf";
globalThis.__private_workflows.set("workflow//./input//wf", wf);
