// https://github.com/vercel/workflow/issues/1365
/**__internal_workflows{"steps":{"input.js":{"_anonymousStep0":{"stepId":"step//./input//_anonymousStep0"},"_anonymousStep1":{"stepId":"step//./input//_anonymousStep1"},"_anonymousStep10":{"stepId":"step//./input//_anonymousStep10"},"_anonymousStep11":{"stepId":"step//./input//_anonymousStep11"},"_anonymousStep12":{"stepId":"step//./input//_anonymousStep12"},"_anonymousStep13":{"stepId":"step//./input//_anonymousStep13"},"_anonymousStep2":{"stepId":"step//./input//_anonymousStep2"},"_anonymousStep3":{"stepId":"step//./input//_anonymousStep3"},"_anonymousStep4":{"stepId":"step//./input//_anonymousStep4"},"_anonymousStep5":{"stepId":"step//./input//_anonymousStep5"},"_anonymousStep6":{"stepId":"step//./input//_anonymousStep6"},"_anonymousStep7":{"stepId":"step//./input//_anonymousStep7"},"_anonymousStep8":{"stepId":"step//./input//_anonymousStep8"},"_anonymousStep9":{"stepId":"step//./input//_anonymousStep9"}}}}*/;
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
export function configuredStep(url) {
    return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//configuredStep/_anonymousStep3", ()=>({
            url
        }));
}
// --- Additional expression patterns for closure variable coverage ---
// Optional chaining on a closure variable
export function withOptionalChaining(client) {
    return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//withOptionalChaining/_anonymousStep4", ()=>({
            client
        }));
}
// Sequence expressions (comma operator)
export function withSequenceExpr(a, b) {
    return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//withSequenceExpr/_anonymousStep5", ()=>({
            a,
            b
        }));
}
// Try/catch/finally referencing closure vars
export function withTryCatch(fn, fallback) {
    return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//withTryCatch/_anonymousStep6", ()=>({
            fallback,
            fn
        }));
}
// Throw expression with closure var
export function withThrow(message) {
    return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//withThrow/_anonymousStep7", ()=>({
            message
        }));
}
// Switch statement referencing closure vars
export function withSwitch(mode, a, b) {
    return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//withSwitch/_anonymousStep8", ()=>({
            a,
            b,
            mode
        }));
}
// For-of loop with closure var
export function withForOf(items, transform) {
    return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//withForOf/_anonymousStep9", ()=>({
            items,
            transform
        }));
}
// For-in loop with closure var
export function withForIn(obj) {
    return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//withForIn/_anonymousStep10", ()=>({
            obj
        }));
}
// Do-while loop with closure var
export function withDoWhile(getNext) {
    return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//withDoWhile/_anonymousStep11", ()=>({
            getNext
        }));
}
// Object shorthand properties referencing closure vars
export function withShorthandProps(name, value) {
    return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//withShorthandProps/_anonymousStep12", ()=>({
            name,
            value
        }));
}
// Computed property keys referencing closure vars
export function withComputedKey(key, value) {
    return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//withComputedKey/_anonymousStep13", ()=>({
            key,
            value
        }));
}
