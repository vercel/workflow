/**__internal_workflows{"workflows":{"input.js":{"arrowWorkflow":{"workflowId":"workflow//input.js//arrowWorkflow"},"workflow":{"workflowId":"workflow//input.js//workflow"}}}}*/;
export async function workflow(input) {
    return input.foo;
}
workflow.workflowId = "workflow//input.js//workflow";
globalThis.__private_workflows.set("workflow//input.js//workflow", workflow);
export const arrowWorkflow = async (input)=>{
    return input.bar;
};
arrowWorkflow.workflowId = "workflow//input.js//arrowWorkflow";
globalThis.__private_workflows.set("workflow//input.js//arrowWorkflow", arrowWorkflow);
