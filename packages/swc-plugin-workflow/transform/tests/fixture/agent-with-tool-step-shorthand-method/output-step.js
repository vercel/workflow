import { agent } from "experimental-agent";
/**__internal_workflows{"steps":{"input.js":{"vade/tools/VercelRequest/execute":{"stepId":"step//./input//vade/tools/VercelRequest/execute"}}}}*/;
var vade$tools$VercelRequest$execute = async function(input, { experimental_context }) {
    return 1 + 1;
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "vade$tools$VercelRequest$execute",
        configurable: true
    });
})(vade$tools$VercelRequest$execute, "step//./input//vade/tools/VercelRequest/execute");
export const vade = agent({
    tools: {
        VercelRequest: {
            execute: vade$tools$VercelRequest$execute
        }
    }
});
