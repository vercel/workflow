/**__internal_workflows{"workflows":{"input.js":{"example":{"workflowId":"workflow//./input//example"}}}}*/;
export async function example(a, b) {
    throw new Error("You attempted to execute workflow example function directly. To start a workflow, use start(example) from workflow/api");
}
example.workflowId = "workflow//./input//example";
