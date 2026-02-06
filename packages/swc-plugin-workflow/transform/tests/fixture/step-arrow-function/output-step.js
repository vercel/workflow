import { registerStepFunction } from "workflow/internal/private";
/**__internal_workflows{"steps":{"step//./input//multiply":{"name":"multiply","source":"input.js"}}}*/;
export const multiply = async (a, b)=>{
    return a * b;
};
registerStepFunction("step//./input//multiply", multiply);
