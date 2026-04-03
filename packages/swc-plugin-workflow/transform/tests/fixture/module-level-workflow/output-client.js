/**__internal_workflows{"workflows":{"input.js":{"arrowWorkflow":{"workflowId":"workflow//./input//arrowWorkflow"},"workflow":{"workflowId":"workflow//./input//workflow"}}}}*/;
export async function workflow(input) {
    throw new Error("You attempted to execute workflow workflow function directly. To start a workflow, use start(workflow) from workflow/api");
}
workflow.workflowId = "workflow//./input//workflow";
export const arrowWorkflow = async (input)=>{
    return input.bar;
};
arrowWorkflow.workflowId = "workflow//./input//arrowWorkflow";
