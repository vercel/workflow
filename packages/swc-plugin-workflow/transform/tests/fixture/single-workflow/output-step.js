/**__internal_workflows{"workflows":{"workflow//./input//workflow":{"name":"workflow","source":"input.js"}}}*/;
export async function workflow(a, b) {
    throw new Error("You attempted to execute workflow workflow function directly. To start a workflow, use start(workflow) from workflow/api");
}
workflow.workflowId = "workflow//./input//workflow";
