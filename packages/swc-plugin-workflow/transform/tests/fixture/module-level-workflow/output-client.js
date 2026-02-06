/**__internal_workflows{"workflows":{"workflow//./input//arrowWorkflow":{"name":"arrowWorkflow","source":"input.js"},"workflow//./input//workflow":{"name":"workflow","source":"input.js"}}}*/;
export async function workflow(input) {
    return input.foo;
}
workflow.workflowId = "workflow//./input//workflow";
export const arrowWorkflow = async (input)=>{
    return input.bar;
};
arrowWorkflow.workflowId = "workflow//./input//arrowWorkflow";
