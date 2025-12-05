/**__internal_workflows{"workflows":{"input.js":{"__default":{"workflowId":"workflow//input.js//__default"}}}}*/;
// User explicitly names their workflow function __default
// The workflow ID should use "__default", not normalize to "default"
export async function __default() {
    throw new Error("You attempted to execute workflow __default function directly. To start a workflow, use start(__default) from workflow/api");
}
__default.workflowId = "workflow//input.js//__default";
