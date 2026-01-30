/**__internal_workflows{"steps":{"input.js":{"fn1":{"stepId":"step//./input//fn1"},"fn2":{"stepId":"step//./input//fn2"},"fn3":{"stepId":"step//./input//fn3"},"fn4":{"stepId":"step//./input//fn4"},"stepAfterRegular":{"stepId":"step//./input//stepAfterRegular"},"stepAfterRegularFn":{"stepId":"step//./input//stepAfterRegularFn"}}}}*/;
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
