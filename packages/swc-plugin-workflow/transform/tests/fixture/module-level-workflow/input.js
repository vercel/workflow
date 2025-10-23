'use workflow';

async function local(input) {
  return input.foo;
}

const localArrow = async (input) => {
  return input.bar;
};

export async function workflow(input) {
  return input.foo;
}

export const arrowWorkflow = async (input) => {
  return input.bar;
};
