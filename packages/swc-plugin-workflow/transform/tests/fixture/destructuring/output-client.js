/**__internal_workflows{"steps":{"input.js":{"destructure":{"stepId":"step//input.js//destructure"},"multiple":{"stepId":"step//input.js//multiple"},"nested_destructure":{"stepId":"step//input.js//nested_destructure"},"process_array":{"stepId":"step//input.js//process_array"},"rest_top_level":{"stepId":"step//input.js//rest_top_level"},"with_defaults":{"stepId":"step//input.js//with_defaults"},"with_rest":{"stepId":"step//input.js//with_rest"}}}}*/;
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
