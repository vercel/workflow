/**
 * Browser-safe serialization format utilities.
 *
 * This module contains the format prefix handling, generic hydrate/dehydrate
 * dispatch, and shared types/classes used by all environments (runtime, web
 * o11y, CLI o11y). It has NO Node.js dependencies.
 */

import { parse, unflatten } from 'devalue';

// ---------------------------------------------------------------------------
// Format prefix constants and encoding/decoding
// ---------------------------------------------------------------------------

export const SerializationFormat = {
  /** devalue stringify/parse with TextEncoder/TextDecoder */
  DEVALUE_V1: 'devl',
} as const;

export type SerializationFormatType =
  (typeof SerializationFormat)[keyof typeof SerializationFormat];

/** Length of the format prefix in bytes */
const FORMAT_PREFIX_LENGTH = 4;

const formatEncoder = new TextEncoder();
const formatDecoder = new TextDecoder();

/**
 * Encode a payload with a format prefix.
 */
export function encodeWithFormatPrefix(
  format: SerializationFormatType,
  payload: Uint8Array | unknown
): Uint8Array | unknown {
  if (!(payload instanceof Uint8Array)) {
    return payload;
  }

  const prefixBytes = formatEncoder.encode(format);
  if (prefixBytes.length !== FORMAT_PREFIX_LENGTH) {
    throw new Error(
      `Format identifier must be exactly ${FORMAT_PREFIX_LENGTH} ASCII characters, got "${format}" (${prefixBytes.length} bytes)`
    );
  }

  const result = new Uint8Array(FORMAT_PREFIX_LENGTH + payload.length);
  result.set(prefixBytes, 0);
  result.set(payload, FORMAT_PREFIX_LENGTH);
  return result;
}

/**
 * Decode a format-prefixed payload.
 */
export function decodeFormatPrefix(data: Uint8Array | unknown): {
  format: SerializationFormatType;
  payload: Uint8Array;
} {
  if (!(data instanceof Uint8Array)) {
    return {
      format: SerializationFormat.DEVALUE_V1,
      payload: new TextEncoder().encode(JSON.stringify(data)),
    };
  }

  if (data.length < FORMAT_PREFIX_LENGTH) {
    throw new Error(
      `Data too short to contain format prefix: expected at least ${FORMAT_PREFIX_LENGTH} bytes, got ${data.length}`
    );
  }

  const prefixBytes = data.subarray(0, FORMAT_PREFIX_LENGTH);
  const format = formatDecoder.decode(prefixBytes);

  const knownFormats = Object.values(SerializationFormat) as string[];
  if (!knownFormats.includes(format)) {
    throw new Error(
      `Unknown serialization format: "${format}". Known formats: ${knownFormats.join(', ')}`
    );
  }

  const payload = data.subarray(FORMAT_PREFIX_LENGTH);
  return { format: format as SerializationFormatType, payload };
}

// ---------------------------------------------------------------------------
// Revivers type (shared across all environments)
// ---------------------------------------------------------------------------

/**
 * A map of type name → reviver function, used by devalue's `parse`/`unflatten`.
 * Each environment (runtime, web, CLI) provides its own set.
 */
export type Revivers = Record<string, (value: any) => any>;

// ---------------------------------------------------------------------------
// Generic hydrate/dehydrate dispatch
// ---------------------------------------------------------------------------

/**
 * Hydrate (deserialize) a value that was stored in the database.
 *
 * Handles three data shapes:
 * 1. `Uint8Array` with a format prefix (specVersion 2+) → decode prefix, parse
 * 2. `Array` (legacy specVersion 1, "revived devalue") → unflatten
 * 3. Other (already a plain JS value) → return as-is
 */
export function hydrateData(value: unknown, revivers: Revivers): unknown {
  if (value instanceof Uint8Array) {
    const { format, payload } = decodeFormatPrefix(value);
    if (format === SerializationFormat.DEVALUE_V1) {
      const str = new TextDecoder().decode(payload);
      return parse(str, revivers);
    }
    throw new Error(`Unsupported serialization format: ${format}`);
  }

  if (Array.isArray(value)) {
    return unflatten(value, revivers);
  }

  // Already a plain JS value (e.g., number, string, null)
  return value;
}

// ---------------------------------------------------------------------------
// Shared marker types for o11y display
// ---------------------------------------------------------------------------

const STREAM_ID_PREFIX = 'strm_';

/** Marker for stream reference objects rendered as links in the UI */
export const STREAM_REF_TYPE = '__workflow_stream_ref__';

/** A stream reference for UI display */
export interface StreamRef {
  __type: typeof STREAM_REF_TYPE;
  streamId: string;
}

/** Marker for custom class instance references */
export const CLASS_INSTANCE_REF_TYPE = '__workflow_class_instance_ref__';

/**
 * A class instance reference for o11y display.
 *
 * Browser-safe base class — no `util.inspect.custom`. Environment-specific
 * rendering (CLI inspect, web component) is handled by each consumer.
 */
export class ClassInstanceRef {
  readonly __type = CLASS_INSTANCE_REF_TYPE;

  constructor(
    public readonly className: string,
    public readonly classId: string,
    public readonly data: unknown
  ) {}

  toJSON(): {
    __type: string;
    className: string;
    classId: string;
    data: unknown;
  } {
    return {
      __type: this.__type,
      className: this.className,
      classId: this.classId,
      data: this.data,
    };
  }
}

/** Check if a value is a ClassInstanceRef object */
export const isClassInstanceRef = (
  value: unknown
): value is ClassInstanceRef => {
  return (
    value instanceof ClassInstanceRef ||
    (value !== null &&
      typeof value === 'object' &&
      '__type' in value &&
      value.__type === CLASS_INSTANCE_REF_TYPE &&
      'className' in value &&
      typeof value.className === 'string')
  );
};

/** Check if a value is a stream ID string */
export const isStreamId = (value: unknown): boolean => {
  return typeof value === 'string' && value.startsWith(STREAM_ID_PREFIX);
};

/** Check if a value is a StreamRef object */
export const isStreamRef = (value: unknown): value is StreamRef => {
  return (
    value !== null &&
    typeof value === 'object' &&
    '__type' in value &&
    value.__type === STREAM_REF_TYPE &&
    'streamId' in value &&
    typeof value.streamId === 'string'
  );
};

// ---------------------------------------------------------------------------
// Shared o11y reviver helpers
// ---------------------------------------------------------------------------

/**
 * Convert a serialized stream value to a StreamRef for display.
 */
export const streamToStreamRef = (value: any): StreamRef => {
  let streamId: string;
  if ('name' in value) {
    const name = String(value.name);
    if (!name.startsWith(STREAM_ID_PREFIX)) {
      streamId = `${STREAM_ID_PREFIX}${name}`;
    } else {
      streamId = name;
    }
  } else {
    streamId = `${STREAM_ID_PREFIX}null`;
  }
  return { __type: STREAM_REF_TYPE, streamId };
};

/** Convert a serialized step function to a display string */
export const serializedStepFunctionToString = (value: unknown): string => {
  if (!value) return 'null';
  if (typeof value !== 'object') return 'null';
  if ('stepId' in value) {
    return `<step:${(value as { stepId: string }).stepId}>`;
  }
  return '<function>';
};

/** Extract the class name from a classId */
export const extractClassName = (classId: string): string => {
  if (!classId) return 'Unknown';
  const parts = classId.split('/');
  return parts[parts.length - 1] || classId;
};

/** Convert a serialized class instance to a ClassInstanceRef for display */
export const serializedInstanceToRef = (value: {
  classId: string;
  data: unknown;
}): ClassInstanceRef => {
  return new ClassInstanceRef(
    extractClassName(value.classId),
    value.classId,
    value.data
  );
};

/** Convert a serialized class reference to a display string */
export const serializedClassToString = (value: { classId: string }): string => {
  return `<class:${extractClassName(value.classId)}>`;
};

/**
 * Standard o11y revivers that override runtime-specific types with
 * display-friendly values. Used by both web and CLI hydration.
 */
export const observabilityRevivers: Revivers = {
  ReadableStream: streamToStreamRef,
  WritableStream: streamToStreamRef,
  TransformStream: streamToStreamRef,
  StepFunction: serializedStepFunctionToString,
  Instance: serializedInstanceToRef,
  Class: serializedClassToString,
};

// ---------------------------------------------------------------------------
// Resource-level hydration dispatch (for o11y)
// ---------------------------------------------------------------------------

/**
 * Hydrate the data fields of a step resource.
 */
function hydrateStepIO<
  T extends { stepId?: string; input?: any; output?: any },
>(resource: T, revivers: Revivers): T {
  let hydratedInput = resource.input;
  let hydratedOutput = resource.output;

  if (resource.input != null) {
    try {
      hydratedInput = hydrateData(resource.input, revivers);
    } catch {
      // Leave un-hydrated
    }
  }

  if (resource.output != null) {
    try {
      hydratedOutput = hydrateData(resource.output, revivers);
    } catch {
      // Leave un-hydrated
    }
  }

  return { ...resource, input: hydratedInput, output: hydratedOutput };
}

/**
 * Hydrate the data fields of a workflow run resource.
 */
function hydrateWorkflowIO<T extends { input?: any; output?: any }>(
  resource: T,
  revivers: Revivers
): T {
  let hydratedInput = resource.input;
  let hydratedOutput = resource.output;

  if (resource.input != null) {
    try {
      hydratedInput = hydrateData(resource.input, revivers);
    } catch {
      // Leave un-hydrated
    }
  }

  if (resource.output != null) {
    try {
      hydratedOutput = hydrateData(resource.output, revivers);
    } catch {
      // Leave un-hydrated
    }
  }

  return { ...resource, input: hydratedInput, output: hydratedOutput };
}

/**
 * Hydrate the eventData fields of an event resource.
 */
function hydrateEventData<T extends { eventId?: string; eventData?: any }>(
  resource: T,
  revivers: Revivers
): T {
  if (!resource.eventData) return resource;

  const eventData = { ...resource.eventData };
  if ('result' in eventData && eventData.result != null) {
    try {
      eventData.result = hydrateData(eventData.result, revivers);
    } catch {
      // Leave un-hydrated
    }
  }

  return { ...resource, eventData };
}

/**
 * Hydrate the metadata field of a hook resource.
 */
function hydrateHookMetadata<T extends { hookId?: string; metadata?: any }>(
  resource: T,
  revivers: Revivers
): T {
  if (resource.metadata == null) return resource;

  let hydratedMetadata = resource.metadata;
  try {
    hydratedMetadata = hydrateData(resource.metadata, revivers);
  } catch {
    // Leave un-hydrated
  }

  return { ...resource, metadata: hydratedMetadata };
}

/**
 * Hydrate the serialized data fields of any resource for o11y display.
 *
 * Dispatches by resource type (step, hook, event, workflow) and calls
 * `hydrateData` with the provided revivers for each data field.
 *
 * Each environment (web, CLI) provides its own revivers — this function
 * only handles the dispatch logic and field mapping.
 */
export function hydrateResourceIO<
  T extends {
    stepId?: string;
    hookId?: string;
    eventId?: string;
    input?: any;
    output?: any;
    metadata?: any;
    eventData?: any;
    executionContext?: any;
  },
>(resource: T, revivers: Revivers): T {
  if (!resource) return resource;

  let hydrated: T;
  if ('stepId' in resource) {
    hydrated = hydrateStepIO(resource, revivers);
  } else if ('hookId' in resource) {
    hydrated = hydrateHookMetadata(resource, revivers);
  } else if ('eventId' in resource) {
    hydrated = hydrateEventData(resource, revivers);
  } else {
    hydrated = hydrateWorkflowIO(resource, revivers);
  }

  // Strip executionContext, preserving only workflowCoreVersion for display
  if ('executionContext' in hydrated) {
    const { executionContext, ...rest } = hydrated;
    const workflowCoreVersion =
      executionContext &&
      typeof executionContext === 'object' &&
      'workflowCoreVersion' in executionContext
        ? executionContext.workflowCoreVersion
        : undefined;
    if (workflowCoreVersion) {
      return { ...rest, workflowCoreVersion } as unknown as T;
    }
    return rest as T;
  }

  return hydrated;
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/** Extract all stream IDs from a value (recursively traverses objects/arrays) */
export function extractStreamIds(obj: unknown): string[] {
  const streamIds: string[] = [];

  function traverse(value: unknown): void {
    if (isStreamId(value)) {
      streamIds.push(value as string);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        traverse(item);
      }
    } else if (value && typeof value === 'object') {
      for (const val of Object.values(value)) {
        traverse(val);
      }
    }
  }

  traverse(obj);
  return Array.from(new Set(streamIds));
}

/** Truncate a string to a maximum length, adding ellipsis if needed */
export function truncateId(id: string, maxLength = 12): string {
  if (id.length <= maxLength) return id;
  return `${id.slice(0, maxLength)}...`;
}
