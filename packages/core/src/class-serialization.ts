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
 * Get or create the class registry on the given global object.
 * This works isomorphically in both step mode (main context) and workflow mode (VM context).
 *
 * @param global - The global object to use. Defaults to globalThis, but can be a VM's global.
 */
function getRegistry(global: Record<string, any> = globalThis): ClassRegistry {
  const g = global as any;
  let registry = g[WORKFLOW_CLASS_REGISTRY] as ClassRegistry | undefined;
  if (!registry) {
    registry = new Map();
    g[WORKFLOW_CLASS_REGISTRY] = registry;
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
 *
 * @param classId - The class ID to look up
 * @param global - The global object to check first. Defaults to globalThis.
 *                 If the class is not found and `global` differs from `globalThis`,
 *                 it will also check `globalThis` as a fallback.
 */
export function getSerializationClass(
  classId: string,
  global: Record<string, any> = globalThis
  // biome-ignore lint/complexity/noBannedTypes: We need to use Function to represent class constructors
): Function | undefined {
  // Check the provided global first
  const cls = getRegistry(global).get(classId);
  if (cls) return cls;

  // Fallback: check globalThis if it differs from the provided global
  // This handles the case where classes are registered in the host context
  // but deserialization happens in a VM context
  if (global !== globalThis) {
    return getRegistry(globalThis).get(classId);
  }

  return undefined;
}
