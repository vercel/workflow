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
    return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//withTsAs/_anonymousStep0", ()=>({
            config
        }));
}
// `satisfies` operator
export function withTsSatisfies(config: Record<string, number>) {
    return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//withTsSatisfies/_anonymousStep1", ()=>({
            config
        }));
}
// Non-null assertion operator (!)
export function withTsNonNull(value: string | null) {
    return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//withTsNonNull/_anonymousStep2", ()=>({
            value
        }));
}
// Angle-bracket type assertion
export function withTsTypeAssertion(data: unknown) {
    return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//withTsTypeAssertion/_anonymousStep3", ()=>({
            data
        }));
}
// `as const` assertion
export function withTsConstAssertion(label: string) {
    return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//withTsConstAssertion/_anonymousStep4", ()=>({
            label
        }));
}
// Closure var used in a typed context with generics
export function withGenericCall<T>(items: T[], transform: (item: T) => string) {
    return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//withGenericCall/_anonymousStep5", ()=>({
            items,
            transform
        }));
}
