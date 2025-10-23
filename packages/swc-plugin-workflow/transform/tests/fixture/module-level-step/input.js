'use step';

async function local(input) {
  return input.foo;
}

const localArrow = async (input) => {
  return input.bar;
};

export async function step(input) {
  return input.foo;
}

export const stepArrow = async (input) => {
  return input.bar;
};
