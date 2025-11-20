// Test default export arrow workflow
/**__internal_workflows{"workflows":{"input.js":{"default":{"workflowId":"workflow//input.js//default"}}}}*/;
export default (async (data)=>new Error("You attempted to execute workflow defaultWorkflow function directly. To start a workflow, use start(defaultWorkflow) from workflow/api"));
