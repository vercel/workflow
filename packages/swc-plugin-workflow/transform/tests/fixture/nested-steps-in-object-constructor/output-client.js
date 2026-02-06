/**__internal_workflows{"workflows":{"workflow//./input//test":{"name":"test","source":"input.js"}}}*/;
export async function test() {
    throw new Error("You attempted to execute workflow test function directly. To start a workflow, use start(test) from workflow/api");
}
test.workflowId = "workflow//./input//test";
