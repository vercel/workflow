import type { ReplayInputCapture } from './replay-inputs.js';

// Shared by the host and the build-time QuickJS capture bundle.
// Descriptors avoid invoking getters or custom serialization during capture.
function encodeReplayValue(
  value: unknown,
  seen = new Map<object, number>(),
  depth = 0,
  isProxy?: (value: unknown) => boolean
): unknown {
  if (value === undefined) return ['undefined'];
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Object.is(value, -0) ? ['negative-zero'] : value;
  }
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('replayInputs supports only plain state data');
  }
  if (isProxy?.(value))
    throw new TypeError('replayInputs does not support proxies');
  if (depth > 512)
    throw new TypeError(
      'replayInputs state exceeds the maximum nesting depth (512)'
    );
  const reference = seen.get(value);
  if (reference !== undefined) return ['reference', reference];
  const prototype = Object.getPrototypeOf(value);
  const array = Array.isArray(value);
  if (
    array
      ? Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value
          ?.name !== 'Array'
      : prototype !== null &&
        (Object.getPrototypeOf(prototype) !== null ||
          Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value
            ?.name !== 'Object')
  ) {
    throw new TypeError('replayInputs supports only plain objects and arrays');
  }
  const id = seen.size;
  seen.set(value, id);
  return [
    array ? 'array' : prototype === null ? 'null-object' : 'object',
    id,
    array ? (value as unknown[]).length : 0,
    Reflect.ownKeys(value)
      .filter((key) => !(array && key === 'length'))
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (
          typeof key !== 'string' ||
          !descriptor.enumerable ||
          !('value' in descriptor)
        ) {
          throw new TypeError(
            'replayInputs does not support symbols, accessors, or non-enumerable properties'
          );
        }
        return [
          key,
          encodeReplayValue(descriptor.value, seen, depth + 1, isProxy),
        ];
      }),
  ];
}

export function captureReplayInputs(
  args: unknown[],
  indices?: readonly number[],
  isProxy?: (value: unknown) => boolean
): ReplayInputCapture[] | undefined {
  if (indices === undefined) return undefined;
  if (
    isProxy?.(indices) ||
    !Array.isArray(indices) ||
    indices.some((index) => !Number.isSafeInteger(index) || index < 0) ||
    new Set(indices).size !== indices.length
  ) {
    throw new TypeError(
      'replayInputs must contain distinct non-negative argument indices'
    );
  }
  if (indices.length === 0) return undefined;
  return indices.map((index) => ({
    index,
    encoded: JSON.stringify(
      encodeReplayValue(args[index], new Map(), 0, isProxy)
    ),
  }));
}
