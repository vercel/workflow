/**__internal_workflows{"steps":{"input.js":{"destructure":{"stepId":"step//./input//destructure"},"multiple":{"stepId":"step//./input//multiple"},"nested_destructure":{"stepId":"step//./input//nested_destructure"},"process_array":{"stepId":"step//./input//process_array"},"rest_top_level":{"stepId":"step//./input//rest_top_level"},"with_defaults":{"stepId":"step//./input//with_defaults"},"with_rest":{"stepId":"step//./input//with_rest"}}}}*/;
export async function destructure({ a, b }) {
    return a + b;
}
destructure.stepId = "step//./input//destructure";
export async function process_array([first, second]) {
    return first + second;
}
process_array.stepId = "step//./input//process_array";
export async function nested_destructure({ user: { name, age } }) {
    return `${name} is ${age} years old`;
}
nested_destructure.stepId = "step//./input//nested_destructure";
export async function with_defaults({ x = 10, y = 20 }) {
    return x + y;
}
with_defaults.stepId = "step//./input//with_defaults";
export async function with_rest({ a, b, ...rest }) {
    return {
        a,
        b,
        rest
    };
}
with_rest.stepId = "step//./input//with_rest";
export async function multiple({ a, b }, { c, d }) {
    return {
        a,
        b,
        c,
        d
    };
}
multiple.stepId = "step//./input//multiple";
export async function rest_top_level(a, b, ...rest) {
    return {
        a,
        b,
        rest
    };
}
rest_top_level.stepId = "step//./input//rest_top_level";
