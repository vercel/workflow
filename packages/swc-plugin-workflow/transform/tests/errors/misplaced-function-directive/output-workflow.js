/**__internal_workflows{"steps":{"input.js":{"badStep":{"stepId":"step//./input//badStep"}}}}*/;
export var badStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//badStep");
export const badWorkflow = async ()=>{
    console.log('hello');
    // Error: directive must be at the top of function
    'use workflow';
    return true;
};
