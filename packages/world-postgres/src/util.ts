export class Mutex {
  promise: Promise<unknown> = Promise.resolve();
  andThen<T>(fn: () => Promise<T> | T): Promise<T> {
    this.promise = this.promise.then(
      () => fn(),
      () => fn()
    );
    return this.promise as Promise<T>;
  }
}

export function compact<T extends object>(obj: T) {
  const value = {} as {
    [key in keyof T]: null extends T[key]
      ? undefined | NonNullable<T[key]>
      : T[key];
  };
  for (const key in obj) {
    if (obj[key] !== null) {
      value[key] = obj[key] as any;
    } else {
      value[key] = undefined as any;
    }
  }
  return value;
}

/**
 * Clones client connection configuration while preserving non-enumerable
 * properties such as `password` from `pg.Pool`, optionally applying overrides.
 */
export function cloneClientConfig<T extends object>(
  options: T,
  overrides?: Record<string, unknown>
): T {
  const config = Object.defineProperties(
    {},
    Object.getOwnPropertyDescriptors(options)
  ) as T;
  if (overrides) {
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(overrides)
    )) {
      Object.defineProperty(config, key, descriptor);
    }
  }
  return config;
}
