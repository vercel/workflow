// Existing variable named __default
/**__internal_workflows{"workflows":{"input.js":{"default":{"workflowId":"workflow//input.js//__default$1"}}}}*/;
const __default = "existing variable";
// Use it to avoid unused variable
console.log(__default);
// Anonymous default export should get unique name (__default$1)
export default async function() {
    'use workflow';
    const result = await someStep();
    return result;
}
