/**__internal_workflows{"steps":{"input.js":{"step":{"stepId":"step//input.js//step"},"stepArrow":{"stepId":"step//input.js//stepArrow"}}}}*/;
const localArrow = async (input)=>{
    return input.bar;
};
export async function step(input) {
    return input.foo;
}
export const stepArrow = async (input)=>{
    return input.bar;
};
