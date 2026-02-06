// Test anonymous default export workflow
/**__internal_workflows{"workflows":{"workflow//./input//default":{"name":"default","source":"input.js"}}}*/;
const __default = async function() {
    const result = await someStep();
    return result;
};
__default.workflowId = "workflow//./input//default";
globalThis.__private_workflows.set("workflow//./input//default", __default);
export default __default;
