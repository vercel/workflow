/**__internal_workflows{"workflows":{"input.js":{"arrowWorkflow":{"workflowId":"workflow//input.js//arrowWorkflow"},"workflow":{"workflowId":"workflow//input.js//workflow"}}}}*/;
const localArrow = async (input)=>{
    return input.bar;
};
export async function workflow(input) {
    return input.foo;
}
export const arrowWorkflow = async (input)=>{
    return input.bar;
};
workflow.workflowId = "workflow//input.js//workflow";
arrowWorkflow.workflowId = "workflow//input.js//arrowWorkflow";
