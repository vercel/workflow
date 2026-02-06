import { registerStepFunction } from "workflow/internal/private";
/**__internal_workflows{"steps":{"step//./input//fn1":{"name":"fn1","source":"input.js"},"step//./input//fn2":{"name":"fn2","source":"input.js"},"step//./input//fn3":{"name":"fn3","source":"input.js"},"step//./input//fn4":{"name":"fn4","source":"input.js"},"step//./input//stepAfterRegular":{"name":"stepAfterRegular","source":"input.js"},"step//./input//stepAfterRegularFn":{"name":"stepAfterRegularFn","source":"input.js"}}}*/;
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
// Test case: regular function BEFORE step function in same declaration
// This verifies that processing doesn't skip the step function
const regularArrow = ()=>1, stepAfterRegular = async ()=>{
    return 5;
};
// Test case: regular function expression BEFORE step function
const regularFn = function() {
    return 2;
}, stepAfterRegularFn = async function() {
    return 6;
};
registerStepFunction("step//./input//fn1", fn1);
registerStepFunction("step//./input//fn2", fn2);
registerStepFunction("step//./input//fn3", fn3);
registerStepFunction("step//./input//fn4", fn4);
registerStepFunction("step//./input//stepAfterRegular", stepAfterRegular);
registerStepFunction("step//./input//stepAfterRegularFn", stepAfterRegularFn);
