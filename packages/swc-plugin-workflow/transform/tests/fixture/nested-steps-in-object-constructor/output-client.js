/**__internal_workflows{"workflows":{"input.js":{"test":{"workflowId":"workflow//./input//test"}}}}*/;
export async function test() {
    throw new Error("You attempted to execute workflow test function directly. To start a workflow, use start(test) from workflow/api");
}
test.workflowId = "workflow//./input//test";
