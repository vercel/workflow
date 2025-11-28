/**__internal_workflows{"steps":{"input.js":{"fn1":{"stepId":"step//input.js//fn1"},"fn2":{"stepId":"step//input.js//fn2"},"fn3":{"stepId":"step//input.js//fn3"},"fn4":{"stepId":"step//input.js//fn4"},"stepAfterRegular":{"stepId":"step//input.js//stepAfterRegular"},"stepAfterRegularFn":{"stepId":"step//input.js//stepAfterRegularFn"}}}}*/;
const fn1 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//fn1"), fn2 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//fn2");
export const fn3 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//fn3"), fn4 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//fn4");
// Test case: regular function BEFORE step function in same declaration
// This verifies that processing doesn't skip the step function
const regularArrow = ()=>1, stepAfterRegular = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//stepAfterRegular");
// Test case: regular function expression BEFORE step function
const regularFn = function() {
    return 2;
}, stepAfterRegularFn = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//stepAfterRegularFn");
