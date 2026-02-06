/**__internal_workflows{"steps":{"step//./input//step":{"name":"step","source":"input.js"},"step//./input//stepArrow":{"name":"stepArrow","source":"input.js"}}}*/;
export async function step(input) {
    return input.foo;
}
export const stepArrow = async (input)=>{
    return input.bar;
};
