/**__internal_workflows{"workflows":{"input.js":{"arrowWorkflow":{"workflowId":"workflow//./input//arrowWorkflow"},"workflow":{"workflowId":"workflow//./input//workflow"}}}}*/;
export async function workflow(input) {
    return input.foo;
}
workflow.workflowId = "workflow//./input//workflow";
export const arrowWorkflow = async (input)=>{
    return input.bar;
};
arrowWorkflow.workflowId = "workflow//./input//arrowWorkflow";
