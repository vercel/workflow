/**__internal_workflows{"workflows":{"workflow//./input//default":{"name":"default","source":"input.js"}}}*/;
// Existing variable named __default
const __default = "existing variable";
// Use it to avoid unused variable
console.log(__default);
const __default$1 = async function() {
    const result = await someStep();
    return result;
};
__default$1.workflowId = "workflow//./input//default";
globalThis.__private_workflows.set("workflow//./input//default", __default$1);
export default __default$1;
