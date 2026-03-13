// https://github.com/vercel/workflow/issues/1365
/**__internal_workflows{"steps":{"input.js":{"_anonymousStep0":{"stepId":"step//./input//_anonymousStep0"},"_anonymousStep1":{"stepId":"step//./input//_anonymousStep1"},"_anonymousStep2":{"stepId":"step//./input//_anonymousStep2"}}}}*/;
// Bug 1: `new` expressions should have their arguments captured as closure vars
export function mockModel(...args) {
    return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//mockModel/_anonymousStep0", ()=>({
            args
        }));
}
// Regular function call for comparison (already worked before the fix)
export function xai(...args) {
    return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//xai/_anonymousStep1", ()=>({
            args
        }));
}
export function mockModelWrapped(...args) {
    return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//mockModelWrapped/_anonymousStep2", ()=>({
            args
        }));
}
