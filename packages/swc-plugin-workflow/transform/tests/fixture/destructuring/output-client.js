import { runStep as __private_run_step } from "workflow/api";
/**__internal_workflows{"steps":{"input.js":{"destructure":{"stepId":"step//input.js//destructure"},"multiple":{"stepId":"step//input.js//multiple"},"nested_destructure":{"stepId":"step//input.js//nested_destructure"},"process_array":{"stepId":"step//input.js//process_array"},"rest_top_level":{"stepId":"step//input.js//rest_top_level"},"with_defaults":{"stepId":"step//input.js//with_defaults"},"with_rest":{"stepId":"step//input.js//with_rest"}}}}*/;
export async function destructure({ a, b }) {
    return __private_run_step("destructure", {
        arguments: [
            {
                a,
                b
            }
        ]
    });
}
export async function process_array([first, second]) {
    return __private_run_step("process_array", {
        arguments: [
            [
                first,
                second
            ]
        ]
    });
}
export async function nested_destructure({ user: { name, age } }) {
    return __private_run_step("nested_destructure", {
        arguments: [
            {
                user: {
                    name,
                    age
                }
            }
        ]
    });
}
export async function with_defaults({ x = 10, y = 20 }) {
    return __private_run_step("with_defaults", {
        arguments: [
            {
                x,
                y
            }
        ]
    });
}
export async function with_rest({ a, b, ...rest }) {
    return __private_run_step("with_rest", {
        arguments: [
            {
                a,
                b,
                ...rest
            }
        ]
    });
}
export async function multiple({ a, b }, { c, d }) {
    return __private_run_step("multiple", {
        arguments: [
            {
                a,
                b
            },
            {
                c,
                d
            }
        ]
    });
}
export async function rest_top_level(a, b, ...rest) {
    return __private_run_step("rest_top_level", {
        arguments: [
            a,
            b,
            ...rest
        ]
    });
}
