import { registerStepFunction } from "workflow/internal/private";
/**__internal_workflows{"steps":{"step//./input//destructure":{"name":"destructure","source":"input.js"},"step//./input//multiple":{"name":"multiple","source":"input.js"},"step//./input//nested_destructure":{"name":"nested_destructure","source":"input.js"},"step//./input//process_array":{"name":"process_array","source":"input.js"},"step//./input//rest_top_level":{"name":"rest_top_level","source":"input.js"},"step//./input//with_defaults":{"name":"with_defaults","source":"input.js"},"step//./input//with_rest":{"name":"with_rest","source":"input.js"}}}*/;
export async function destructure({ a, b }) {
    return a + b;
}
export async function process_array([first, second]) {
    return first + second;
}
export async function nested_destructure({ user: { name, age } }) {
    return `${name} is ${age} years old`;
}
export async function with_defaults({ x = 10, y = 20 }) {
    return x + y;
}
export async function with_rest({ a, b, ...rest }) {
    return {
        a,
        b,
        rest
    };
}
export async function multiple({ a, b }, { c, d }) {
    return {
        a,
        b,
        c,
        d
    };
}
export async function rest_top_level(a, b, ...rest) {
    return {
        a,
        b,
        rest
    };
}
registerStepFunction("step//./input//destructure", destructure);
registerStepFunction("step//./input//process_array", process_array);
registerStepFunction("step//./input//nested_destructure", nested_destructure);
registerStepFunction("step//./input//with_defaults", with_defaults);
registerStepFunction("step//./input//with_rest", with_rest);
registerStepFunction("step//./input//multiple", multiple);
registerStepFunction("step//./input//rest_top_level", rest_top_level);
