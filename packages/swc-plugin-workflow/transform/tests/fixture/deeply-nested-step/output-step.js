import { createConfig } from "some-library";
/**__internal_workflows{"steps":{"input.js":{"config/level1/level2/level3/myStep":{"stepId":"step//./input//config/level1/level2/level3/myStep"}}}}*/;
var config$level1$level2$level3$myStep = async function(input) {
    return input * 2;
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "config$level1$level2$level3$myStep",
        configurable: true
    });
})(config$level1$level2$level3$myStep, "step//./input//config/level1/level2/level3/myStep");
// Test deeply nested step functions (4 levels deep)
export const config = createConfig({
    level1: {
        level2: {
            level3: {
                myStep: async (input)=>{
                    return input * 2;
                }
            }
        }
    }
});
