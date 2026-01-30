/**__internal_workflows{"steps":{"input.js":{"step":{"stepId":"step//./input//step"},"stepArrow":{"stepId":"step//./input//stepArrow"}}}}*/;
export async function step(input) {
    return input.foo;
}
export const stepArrow = async (input)=>{
    return input.bar;
};
