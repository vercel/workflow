/**
 * Custom serializable classes for cross-context serialization e2e tests.
 *
 * This file is ONLY imported by steps (not directly by workflows or client code).
 * The cross-context class registration feature ensures these classes are
 * registered in ALL bundle contexts (client, workflow, step) even though
 * they're only directly imported by step code.
 *
 * This tests the scenario where:
 * 1. Client passes a Vector instance to start() -> needs to serialize it
 * 2. Workflow receives the Vector -> needs to deserialize it
 * 3. Workflow passes Vector to step -> needs to serialize it
 * 4. Step receives Vector -> needs to deserialize it
 * 5. Step returns Vector -> needs to serialize it
 * 6. Workflow receives Vector result -> needs to deserialize it
 * 7. Workflow returns Vector -> needs to serialize it
 * 8. Client receives Vector result -> needs to deserialize it
 */

/**
 * A 3D vector class with custom serialization.
 * This class is only imported in step code but needs to be
 * serializable/deserializable in all contexts.
 */
export class Vector {
  x: number;
  y: number;
  z: number;

  constructor(x: number, y: number, z: number) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  /** Custom serialization - converts instance to plain object */
  static [Symbol.for('workflow-serialize')](instance: Vector) {
    return { x: instance.x, y: instance.y, z: instance.z };
  }

  /** Custom deserialization - reconstructs instance from plain object */
  static [Symbol.for('workflow-deserialize')](data: {
    x: number;
    y: number;
    z: number;
  }) {
    return new Vector(data.x, data.y, data.z);
  }

  /** Helper method to compute magnitude */
  magnitude(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
  }

  /** Helper method to add two vectors */
  add(other: Vector): Vector {
    return new Vector(this.x + other.x, this.y + other.y, this.z + other.z);
  }

  /** Helper method to scale vector */
  scale(factor: number): Vector {
    return new Vector(this.x * factor, this.y * factor, this.z * factor);
  }
}
