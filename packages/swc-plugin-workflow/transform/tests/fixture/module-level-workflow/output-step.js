/**__internal_workflows{"workflows":{"input.js":{"arrowWorkflow":{"workflowId":"workflow//input.js//arrowWorkflow"},"workflow":{"workflowId":"workflow//input.js//workflow"}}}}*/;
'use workflow';
async function local(input) {
    return input.foo;
}
const localArrow = async (input)=>{
    return input.bar;
};
export async function workflow(input) {
    throw new Error("You attempted to execute workflow workflow function directly. To start a workflow, use start(workflow) from workflow/api");
}
workflow.workflowId = "workflow//input.js//workflow";
export const arrowWorkflow = async (input)=>{
    throw new Error("You attempted to execute workflow arrowWorkflow function directly. To start a workflow, use start(arrowWorkflow) from workflow/api");
};
arrowWorkflow.workflowId = "workflow//input.js//arrowWorkflow";
