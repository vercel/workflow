// TypeScript expression wrappers should not prevent closure variable detection.
// The plugin must traverse through `as`, `satisfies`, `!`, type assertions,
// const assertions, and instantiation expressions to reach the inner expression.

interface Config {
  timeout: number;
  retries: number;
}

type BaseClass = { new(): any };

// `as` type assertion
export function withTsAs(config: unknown) {
  return async () => {
    'use step';
    return (config as Config).timeout;
  };
}

// `satisfies` operator
export function withTsSatisfies(config: Record<string, number>) {
  return async () => {
    'use step';
    return (config satisfies Record<string, number>);
  };
}

// Non-null assertion operator (!)
export function withTsNonNull(value: string | null) {
  return async () => {
    'use step';
    return value!.length;
  };
}

// Angle-bracket type assertion
export function withTsTypeAssertion(data: unknown) {
  return async () => {
    'use step';
    return (<Config>data).retries;
  };
}

// `as const` assertion
export function withTsConstAssertion(label: string) {
  return async () => {
    'use step';
    return { label } as const;
  };
}

// Closure var used in a typed context with generics
export function withGenericCall<T>(items: T[], transform: (item: T) => string) {
  return async () => {
    'use step';
    return items.map(transform);
  };
}
