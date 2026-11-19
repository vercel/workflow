export async function nestedStepBranchWorkflow(branch: 'a' | 'b') {
  'use workflow';

  if (branch === 'a') {
    const act = async () => {
      'use step';
      return 'body-a';
    };
    return act();
  }

  const act = async () => {
    'use step';
    return 'body-b';
  };
  return act();
}

export async function nestedStepFunctionExpressionWorkflow(
  n: number,
  label: string
) {
  'use workflow';

  // Function expressions bound to a const are nested steps like the arrow
  // form: hoisted, namespaced, and handed the variables they capture.
  const named = async function summarize() {
    'use step';
    return `${label}:${n + 1}`;
  };
  const anonymous = async function () {
    'use step';
    return n * 2;
  };
  return [await named(), await anonymous()];
}
