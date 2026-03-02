/**__internal_workflows{"steps":{"input.js":{"badStep":{"stepId":"step//./input//badStep"}}}}*/;
export async function badStep() {
    const x = 42;
    // Error: directive must be at the top of function
    'use step';
    return x;
}
badStep.stepId = "step//./input//badStep";
export const badWorkflow = async ()=>{
    console.log('hello');
    // Error: directive must be at the top of function
    'use workflow';
    return true;
};
