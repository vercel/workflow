/**__internal_workflows{"workflows":{"input.js":{"default":{"workflowId":"workflow//input.js//default"}}}}*/;
const __default = async function() {
    const result = await someStep();
    return result;
};
__default.workflowId = "workflow//input.js//default";
globalThis.__private_workflows.set("workflow//input.js//default", __default);
export default __default;
