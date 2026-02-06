/**__internal_workflows{"workflows":{"workflow//./input//default":{"name":"default","source":"input.js"}}}*/;
// Existing variable named __default
const __default = "existing variable";
// Use it to avoid unused variable
console.log(__default);
const __default$1 = async function() {
    throw new Error("You attempted to execute workflow __default$1 function directly. To start a workflow, use start(__default$1) from workflow/api");
};
__default$1.workflowId = "workflow//./input//default";
export default __default$1;
