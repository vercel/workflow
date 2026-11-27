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
  overrides?: Partial<T>
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

/**
 * The code of a failed connection or query, for a log line: the SQLSTATE of
 * a server error (`28P01` for a failed password, `57P01` for a terminated
 * backend) or the Node.js code of a socket error (`ECONNREFUSED`), else the
 * error's name. Never its message, which can quote connection options.
 */
export function connectionErrorCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const { code } = error as { code?: unknown };
    if (typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code)) return code;
    if (error instanceof Error) return error.name;
  }
  return 'unknown';
}
