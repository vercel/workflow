/**
 * Class serialization utilities.
 *
 * This module is separate from private.ts to avoid pulling in Node.js-only
 * dependencies (like async_hooks via get-closure-vars.ts) when used in
 * workflow bundles.
 */

// Registry for class constructors that can be serialized (used for deserialization)
// biome-ignore lint/complexity/noBannedTypes: We need to use Function to represent class constructors
const registeredClasses = new Map<string, Function>();

/**
 * Register a class constructor for serialization.
 * This allows class constructors to be deserialized by looking up the classId.
 * Called by the SWC plugin in step mode.
 *
 * Note: For serialization, the classId is read directly from the class's
 * `classId` property (set by the SWC plugin in workflow mode).
 */
// biome-ignore lint/complexity/noBannedTypes: We need to use Function to represent class constructors
export function registerSerializationClass(classId: string, cls: Function) {
  registeredClasses.set(classId, cls);
}

/**
 * Find a registered class constructor by ID (used during deserialization)
 */
// biome-ignore lint/complexity/noBannedTypes: We need to use Function to represent class constructors
export function getSerializationClass(classId: string): Function | undefined {
  return registeredClasses.get(classId);
}
