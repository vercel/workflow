/**__internal_workflows{"workflows":{"workflow//./input//example":{"name":"example","source":"input.js"}}}*/;
export async function example(a, b) {
    throw new Error("You attempted to execute workflow example function directly. To start a workflow, use start(example) from workflow/api");
}
example.workflowId = "workflow//./input//example";
