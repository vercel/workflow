/**
 * Class serialization utilities.
 *
 * This module is separate from private.ts to avoid pulling in Node.js-only
 * dependencies (like async_hooks via get-closure-vars.ts) when used in
 * workflow bundles.
 */

// Registry for class constructors that can be serialized
// biome-ignore lint/complexity/noBannedTypes: We need to use Function to represent class constructors
const registeredClasses = new Map<string, Function>();
// biome-ignore lint/complexity/noBannedTypes: We need to use Function to represent class constructors
const classToIdMap = new WeakMap<Function, string>();

/**
 * Register a class constructor for serialization.
 * This allows class constructors to be serialized as references and
 * restored during deserialization (e.g., when used as `this` in static method calls).
 */
// biome-ignore lint/complexity/noBannedTypes: We need to use Function to represent class constructors
export function registerSerializationClass(classId: string, cls: Function) {
  registeredClasses.set(classId, cls);
  classToIdMap.set(cls, classId);
}

/**
 * Find a registered class constructor by ID
 */
// biome-ignore lint/complexity/noBannedTypes: We need to use Function to represent class constructors
export function getSerializationClass(classId: string): Function | undefined {
  return registeredClasses.get(classId);
}

/**
 * Get the class ID for a registered class constructor
 */
// biome-ignore lint/complexity/noBannedTypes: We need to use Function to represent class constructors
export function getSerializationClassId(cls: Function): string | undefined {
  return classToIdMap.get(cls);
}
