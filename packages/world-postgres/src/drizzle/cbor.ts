import { decode, encode } from 'cbor-x';
import { customType } from 'drizzle-orm/pg-core';

export function Cbor<T>() {
  return customType<{ data: T; driverData: Buffer }>({
    dataType: () => 'bytea',
    fromDriver: (value) => decode(value),
    toDriver: (value) => encode(value),
  });
}

/**
 * Adds a `{key}Json` property to the given type V, representing a key that was
 * migrated to CBOR and can contain a previous JSONB representation.
 *
 * We migrated from JSONB to CBOR, but to avoid breaking changes in the codebase,
 * we keep both representations in the database, and therefore we need to extend
 * the types accordingly.
 */
export type Cborized<V extends object, K extends keyof V> = V & {
  [key in `${Extract<K, string>}Json`]: unknown;
};
