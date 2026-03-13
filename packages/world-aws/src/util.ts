import { decode, encode } from 'cbor-x';

/** Encode a value to CBOR binary. */
export function cborEncode(value: unknown): Uint8Array {
  return encode(value);
}

/** Decode CBOR binary to a value. */
export function cborDecode<T = unknown>(data: Uint8Array | Buffer): T {
  return decode(Buffer.from(data));
}

/** Convert a Date to an ISO string for DynamoDB storage. */
export function toIso(date: Date): string {
  return date.toISOString();
}

/** Parse an ISO string from DynamoDB back to a Date. */
export function fromIso(iso: string): Date {
  return new Date(iso);
}

/** Convert null values to undefined. */
export function compact<T extends object>(obj: T) {
  const value = {} as {
    [key in keyof T]: null extends T[key]
      ? undefined | NonNullable<T[key]>
      : T[key];
  };
  for (const key in obj) {
    if (obj[key] !== null && obj[key] !== undefined) {
      value[key] = obj[key] as any;
    } else {
      value[key] = undefined as any;
    }
  }
  return value;
}

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
