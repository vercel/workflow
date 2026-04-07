/**__internal_workflows{"steps":{"input.ts":{"_anonymousStep0":{"stepId":"step//./input//_anonymousStep0"},"_anonymousStep1":{"stepId":"step//./input//_anonymousStep1"},"_anonymousStep2":{"stepId":"step//./input//_anonymousStep2"},"_anonymousStep3":{"stepId":"step//./input//_anonymousStep3"},"_anonymousStep4":{"stepId":"step//./input//_anonymousStep4"},"_anonymousStep5":{"stepId":"step//./input//_anonymousStep5"}}}}*/;
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
