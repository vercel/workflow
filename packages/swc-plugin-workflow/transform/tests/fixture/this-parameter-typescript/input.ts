interface Ctx { prefix: string }

export async function stepWithThis(this: Ctx, name: string) {
  'use step';
  return this.prefix + name;
}

export async function wf(input: { name: string }) {
  'use workflow';
  const local = 'x';
  const nested = async function (this: Ctx, n: number) {
    'use step';
    return local + n;
  };
  return await nested.call({ prefix: '' }, 1);
}

export class Svc {
  async method(this: Svc, id: string) {
    'use step';
    return id;
  }
}
