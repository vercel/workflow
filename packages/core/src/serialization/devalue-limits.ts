import {
  defaultStringifyOperations,
  type ParseOptions,
  type StringifyOperations,
  type StringifyOptions,
} from 'devalue';

/** Maximum supported logical length for compact sparse-array payloads. */
export const MAX_SERIALIZED_SPARSE_ARRAY_LENGTH = 100_000;

const MAX_ARRAY_INDEX = 4_294_967_294;

export function assertSupportedSparseArrayLength(length: number): void {
  if (length > MAX_SERIALIZED_SPARSE_ARRAY_LENGTH) {
    throw new RangeError(
      `Serialized sparse array length ${length} exceeds the supported maximum of ${MAX_SERIALIZED_SPARSE_ARRAY_LENGTH}`
    );
  }
}

function assertSupportedSparseArrayEncoding(
  length: number,
  population: number
): void {
  // Keep this in sync with devalue's choice between its dense hole encoding
  // and compact sparse encoding. Dense payloads already scale with length;
  // only the compact form needs a separate logical-length bound.
  const digits = String(length).length;
  const holeCost = (length - population) * 3;
  const sparseCost = 4 + digits + population * (digits + 1);

  if (holeCost > sparseCost) {
    assertSupportedSparseArrayLength(length);
  }
}

export function withBoundedSparseArrayStringifyOperations<
  T extends Partial<StringifyOperations>,
>(operations: T): T & Pick<StringifyOperations, 'lengthOf' | 'indicesOf'> {
  const lengthOf = operations.lengthOf ?? defaultStringifyOperations.lengthOf;
  const indicesOf =
    operations.indicesOf ?? defaultStringifyOperations.indicesOf;
  const lengths = new WeakMap<object, number>();

  return {
    ...operations,
    lengthOf: (array: any) => {
      const length = lengthOf(array);
      lengths.set(array as object, length);
      return length;
    },
    indicesOf: (array: any) => {
      const indices = indicesOf(array);
      const length = lengths.get(array as object) ?? lengthOf(array);
      assertSupportedSparseArrayEncoding(length, indices.length);
      return indices;
    },
  };
}

function createBoundedSparseArray(length: number): any[] {
  assertSupportedSparseArrayLength(length);

  // Preserve devalue's dictionary-elements construction so allocation stays
  // proportional to populated entries rather than the logical array length.
  const array: any[] = [];
  array[MAX_ARRAY_INDEX] = undefined;
  delete array[MAX_ARRAY_INDEX];
  array.length = length;
  return array;
}

export const boundedDevalueParseOptions = {
  operations: {
    createSparseArray: createBoundedSparseArray,
  },
} satisfies ParseOptions;

export const boundedDevalueStringifyOperations: Partial<StringifyOperations> =
  withBoundedSparseArrayStringifyOperations({});

export const boundedDevalueStringifyOptions: StringifyOptions = {
  operations: boundedDevalueStringifyOperations,
};
