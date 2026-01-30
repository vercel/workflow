import { registerStepFunction } from "workflow/internal/private";
/**__internal_workflows{"steps":{"input.js":{"multiply":{"stepId":"step//./input//multiply"}}}}*/;
export const multiply = async (a, b)=>{
    return a * b;
};
registerStepFunction("step//./input//multiply", multiply);
