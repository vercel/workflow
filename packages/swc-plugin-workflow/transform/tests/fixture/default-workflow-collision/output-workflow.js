// Existing variable named __default
/**__internal_workflows{"workflows":{"input.js":{"default":{"workflowId":"workflow//input.js//__default$1"}}}}*/;
const __default = "existing variable";
// Use it to avoid unused variable
console.log(__default);
const __default$1 = async function() {
    const result = await someStep();
    return result;
};
__default$1.workflowId = "workflow//input.js//__default$1";
export default __default$1;
