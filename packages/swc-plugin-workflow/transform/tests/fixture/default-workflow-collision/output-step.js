// Existing variable named defaultWorkflow
/**__internal_workflows{"workflows":{"input.js":{"default":{"workflowId":"workflow//input.js//defaultWorkflow$1"}}}}*/;
const defaultWorkflow = "existing variable";
// Use it to avoid unused variable
console.log(defaultWorkflow);
// Anonymous default export should get unique name
export default async function() {
    'use workflow';
    const result = await someStep();
    return result;
}
