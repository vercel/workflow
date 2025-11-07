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
