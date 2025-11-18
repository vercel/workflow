/**__internal_workflows{"steps":{"input.js":{"myFactory/myStep":{"stepId":"step//input.js//myFactory/myStep"}}}}*/;
const myFactory = ()=>({
        myStep: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//myFactory/myStep")
    });
export default myFactory;
