import { describe, expect, it } from 'vitest';

// Simulates a step function as it would be compiled in client mode
// The "use step" directive is removed but the function body remains intact
async function add(a: number, b: number) {
  // Original function body - not transformed
  return a + b;
}

async function multiply(a: number, b: number) {
  // Original function body - not transformed
  return a * b;
}

async function processData(data: { value: number }) {
  // Original function body - not transformed
  const doubled = data.value * 2;
  return { result: doubled };
}

describe('Step functions called directly (outside workflow)', () => {
  it('should execute step function directly without workflow context', async () => {
    const result = await add(2, 3);
    expect(result).toBe(5);
  });

  it('should execute another step function directly', async () => {
    const result = await multiply(4, 5);
    expect(result).toBe(20);
  });

  it('should execute step function with object parameter', async () => {
    const result = await processData({ value: 10 });
    expect(result).toEqual({ result: 20 });
  });

  it('should allow calling step functions in sequence', async () => {
    const sum = await add(1, 2);
    const product = await multiply(sum, 3);
    expect(product).toBe(9);
  });

  it('should allow calling step functions in parallel', async () => {
    const [sum, product] = await Promise.all([add(1, 2), multiply(3, 4)]);
    expect(sum).toBe(3);
    expect(product).toBe(12);
  });
});
