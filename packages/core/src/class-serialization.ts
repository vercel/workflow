/**
 * Class serialization utilities.
 *
 * This module is separate from private.ts to avoid pulling in Node.js-only
 * dependencies (like async_hooks via get-closure-vars.ts) when used in
 * workflow bundles.
 */

import { WORKFLOW_CLASS_REGISTRY } from './symbols.js';

// biome-ignore lint/complexity/noBannedTypes: We need to use Function to represent class constructors
type ClassRegistry = Map<string, Function>;

/**
 * Get or create the class registry on globalThis.
 * This works isomorphically in both step mode (main context) and workflow mode (VM context).
 */
function getRegistry(): ClassRegistry {
  let registry = (globalThis as any)[WORKFLOW_CLASS_REGISTRY] as
    | ClassRegistry
    | undefined;
  if (!registry) {
    registry = new Map();
    (globalThis as any)[WORKFLOW_CLASS_REGISTRY] = registry;
  }
  return registry;
}

/**
 * Register a class constructor for serialization.
 * This allows class constructors to be deserialized by looking up the classId.
 * Called by the SWC plugin in both step mode and workflow mode.
 *
 * Also sets the `classId` property on the class so the serializer can find it
 * when serializing instances (e.g., step return values).
 */
// biome-ignore lint/complexity/noBannedTypes: We need to use Function to represent class constructors
export function registerSerializationClass(classId: string, cls: Function) {
  getRegistry().set(classId, cls);
  // Set classId on the class for serialization
  Object.defineProperty(cls, 'classId', {
    value: classId,
    writable: false,
    enumerable: false,
    configurable: false,
  });
}

/**
 * Find a registered class constructor by ID (used during deserialization)
 */
// biome-ignore lint/complexity/noBannedTypes: We need to use Function to represent class constructors
export function getSerializationClass(classId: string): Function | undefined {
  return getRegistry().get(classId);
}
