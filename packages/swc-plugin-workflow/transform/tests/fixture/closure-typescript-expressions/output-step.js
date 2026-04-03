import { __private_getClosureVars, registerStepFunction } from "workflow/internal/private";
/**__internal_workflows{"steps":{"input.ts":{"_anonymousStep0":{"stepId":"step//./input//_anonymousStep0"},"_anonymousStep1":{"stepId":"step//./input//_anonymousStep1"},"_anonymousStep2":{"stepId":"step//./input//_anonymousStep2"},"_anonymousStep3":{"stepId":"step//./input//_anonymousStep3"},"_anonymousStep4":{"stepId":"step//./input//_anonymousStep4"},"_anonymousStep5":{"stepId":"step//./input//_anonymousStep5"}}}}*/;
var withTsAs$_anonymousStep0 = async ()=>{
    const { config } = __private_getClosureVars();
    return config as Config.timeout;
};
var withTsSatisfies$_anonymousStep1 = async ()=>{
    const { config } = __private_getClosureVars();
    return config satisfies Record<string, number>;
};
var withTsNonNull$_anonymousStep2 = async ()=>{
    const { value } = __private_getClosureVars();
    return value!.length;
};
var withTsTypeAssertion$_anonymousStep3 = async ()=>{
    const { data } = __private_getClosureVars();
    return <Config>data.retries;
};
var withTsConstAssertion$_anonymousStep4 = async ()=>{
    const { label } = __private_getClosureVars();
    return {
        label
    } as const;
};
var withGenericCall$_anonymousStep5 = async ()=>{
    const { items, transform } = __private_getClosureVars();
    return items.map(transform);
};
// TypeScript expression wrappers should not prevent closure variable detection.
// The plugin must traverse through `as`, `satisfies`, `!`, type assertions,
// const assertions, and instantiation expressions to reach the inner expression.
interface Config {
    timeout: number;
    retries: number;
}
type BaseClass = {
    new(): any;
};
// `as` type assertion
export function withTsAs(config: unknown) {
    return async ()=>{
        return config as Config.timeout;
    };
}
// `satisfies` operator
export function withTsSatisfies(config: Record<string, number>) {
    return async ()=>{
        return config satisfies Record<string, number>;
    };
}
// Non-null assertion operator (!)
export function withTsNonNull(value: string | null) {
    return async ()=>{
        return value!.length;
    };
}
// Angle-bracket type assertion
export function withTsTypeAssertion(data: unknown) {
    return async ()=>{
        return <Config>data.retries;
    };
}
// `as const` assertion
export function withTsConstAssertion(label: string) {
    return async ()=>{
        return {
            label
        } as const;
    };
}
// Closure var used in a typed context with generics
export function withGenericCall<T>(items: T[], transform: (item: T) => string) {
    return async ()=>{
        return items.map(transform);
    };
}
registerStepFunction("step//./input//withTsAs/_anonymousStep0", withTsAs$_anonymousStep0);
registerStepFunction("step//./input//withTsSatisfies/_anonymousStep1", withTsSatisfies$_anonymousStep1);
registerStepFunction("step//./input//withTsNonNull/_anonymousStep2", withTsNonNull$_anonymousStep2);
registerStepFunction("step//./input//withTsTypeAssertion/_anonymousStep3", withTsTypeAssertion$_anonymousStep3);
registerStepFunction("step//./input//withTsConstAssertion/_anonymousStep4", withTsConstAssertion$_anonymousStep4);
registerStepFunction("step//./input//withGenericCall/_anonymousStep5", withGenericCall$_anonymousStep5);
