let stepArrow = async () => {
  'use step';
  return 1;
};

export let exportedStepArrow = async () => {
  'use step';
  return 2;
};

export async function normalStep() {
  'use step';
  return 3;
}

