/**
 * Step functions that use the Vector class for cross-context serialization testing.
 *
 * These steps import Vector from serde-models.ts. The workflow code does NOT
 * directly import Vector - it only receives/passes Vector instances through
 * step calls. This tests cross-context class registration.
 */

import { Vector } from './serde-models.js';

/**
 * Step that receives a Vector and scales it.
 * Tests: workflow -> step deserialization, step -> workflow serialization
 */
export async function scaleVector(vector: Vector, factor: number) {
  'use step';
  // Verify the vector was properly deserialized and has its methods
  console.log('Vector magnitude:', vector.magnitude());
  // Scale and return (will be serialized on return)
  return vector.scale(factor);
}

/**
 * Step that receives two Vectors and adds them.
 * Tests: workflow -> step deserialization of multiple instances
 */
export async function addVectors(v1: Vector, v2: Vector) {
  'use step';
  // Verify both vectors have their methods
  console.log('v1 magnitude:', v1.magnitude());
  console.log('v2 magnitude:', v2.magnitude());
  return v1.add(v2);
}

/**
 * Step that creates and returns a new Vector.
 * Tests: step creating new instance -> workflow deserialization
 */
export async function createVector(x: number, y: number, z: number) {
  'use step';
  return new Vector(x, y, z);
}

/**
 * Step that receives an array of Vectors.
 * Tests: serialization of arrays containing custom class instances
 */
export async function sumVectors(vectors: Vector[]) {
  'use step';
  let totalX = 0;
  let totalY = 0;
  let totalZ = 0;
  for (const v of vectors) {
    // Verify each vector has its methods
    console.log('Vector magnitude:', v.magnitude());
    totalX += v.x;
    totalY += v.y;
    totalZ += v.z;
  }
  return new Vector(totalX, totalY, totalZ);
}
