async function add(num: number, num2: number): Promise<number> {
  'use step';
  return num + num2;
}

export async function addition(num: number, num2: number): Promise<number> {
  'use workflow';
  const result = await add(num, num2);
  console.log({ result });
  return result;
}

export async function addTenWorkflow(input: number): Promise<number> {
  'use workflow';
  const a = await add(input, 2);
  const b = await add(a, 3);
  const c = await add(b, 5);
  return c;
}
