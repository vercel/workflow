/**__internal_workflows{"steps":{"step//./input//myFactory/myStep":{"name":"myFactory/myStep","source":"input.js"}}}*/;
const myFactory = ()=>({
        myStep: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//myFactory/myStep")
    });
export default myFactory;
