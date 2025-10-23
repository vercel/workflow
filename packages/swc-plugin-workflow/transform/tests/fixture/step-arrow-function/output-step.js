import { registerStepFunction } from "workflow/internal/private";
/**__internal_workflows{"steps":{"input.js":{"multiply":{"stepId":"step//input.js//multiply"}}}}*/;
export const multiply = async (a, b)=>{
    return a * b;
};
registerStepFunction("step//input.js//multiply", multiply);
