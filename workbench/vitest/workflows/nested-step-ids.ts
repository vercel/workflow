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
