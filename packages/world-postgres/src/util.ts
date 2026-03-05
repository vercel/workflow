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
