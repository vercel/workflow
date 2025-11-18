import { registerStepFunction } from "workflow/internal/private";
/**__internal_workflows{"steps":{"input.js":{"fn1":{"stepId":"step//input.js//fn1"},"fn2":{"stepId":"step//input.js//fn2"},"fn3":{"stepId":"step//input.js//fn3"},"fn4":{"stepId":"step//input.js//fn4"}}}}*/;
const fn1 = async ()=>{
    return 1;
}, fn2 = async ()=>{
    return 2;
};
export const fn3 = async ()=>{
    return 3;
}, fn4 = async ()=>{
    return 4;
};
registerStepFunction("step//input.js//fn1", fn1);
registerStepFunction("step//input.js//fn2", fn2);
registerStepFunction("step//input.js//fn3", fn3);
registerStepFunction("step//input.js//fn4", fn4);
