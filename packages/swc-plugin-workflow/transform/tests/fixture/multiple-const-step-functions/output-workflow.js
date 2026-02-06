/**__internal_workflows{"steps":{"step//./input//fn1":{"name":"fn1","source":"input.js"},"step//./input//fn2":{"name":"fn2","source":"input.js"},"step//./input//fn3":{"name":"fn3","source":"input.js"},"step//./input//fn4":{"name":"fn4","source":"input.js"},"step//./input//stepAfterRegular":{"name":"stepAfterRegular","source":"input.js"},"step//./input//stepAfterRegularFn":{"name":"stepAfterRegularFn","source":"input.js"}}}*/;
const fn1 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//fn1"), fn2 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//fn2");
export const fn3 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//fn3"), fn4 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//fn4");
// Test case: regular function BEFORE step function in same declaration
// This verifies that processing doesn't skip the step function
const regularArrow = ()=>1, stepAfterRegular = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//stepAfterRegular");
// Test case: regular function expression BEFORE step function
const regularFn = function() {
    return 2;
}, stepAfterRegularFn = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//stepAfterRegularFn");
