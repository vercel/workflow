export async function wf(input) {
  'use workflow';
  const prefix = input.prefix;
  const helper = async (x) => {
    'use step';
    const obj = {
      get label() { return prefix + x; },
      set label(v) { console.log(prefix, v); },
    };
    return obj.label;
  };
  return await helper(1);
}

export const api = {
  get value() { 'use step'; return 1; },
  set value(v) { console.log(v); },
  get ['~id']() { 'use step'; return 2; },
};

export async function outer() {
  'use workflow';
  const nested = {
    get thing() { 'use step'; return 3; },
  };
  return nested.thing;
}
