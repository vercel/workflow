// Test anonymous default export workflow
/**__internal_workflows{"workflows":{"input.js":{"default":{"workflowId":"workflow//input.js//defaultWorkflow"}}}}*/;
export default async function() {
    'use workflow';
    const result = await someStep();
    return result;
}
