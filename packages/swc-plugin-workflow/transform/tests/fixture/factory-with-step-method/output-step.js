import fs from 'fs/promises';
/**__internal_workflows{"steps":{"input.js":{"myFactory/myStep":{"stepId":"step//./input//myFactory/myStep"}}}}*/;
var myFactory$myStep = async function() {
    await fs.mkdir('test');
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "myFactory$myStep",
        configurable: true
    });
})(myFactory$myStep, "step//./input//myFactory/myStep");
const myFactory = ()=>({
        myStep: async ()=>{
            await fs.mkdir('test');
        }
    });
export default myFactory;
