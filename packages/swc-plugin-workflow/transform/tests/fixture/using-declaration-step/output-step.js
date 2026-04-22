/**__internal_workflows{"steps":{"input.js":{"testStep":{"stepId":"step//./input//testStep"}}}}*/;
// This is the TypeScript-transformed output of:
// async function testStep() {
//   'use step';
//   using resource = getResource();
//   await doWork(resource);
// }
export async function testStep() {
    const env = {
        stack: [],
        error: void 0,
        hasError: false
    };
    try {
        const resource = env.stack.push({
            value: "test"
        });
        await Promise.resolve(resource);
    } catch (e) {
        env.error = e;
        env.hasError = true;
    } finally{
        env.stack.pop();
    }
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "testStep",
        configurable: true
    });
})(testStep, "step//./input//testStep");
