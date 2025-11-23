async function nullByteStep() {
  'use step';
  return 'null byte \0';
}

export async function nullByteWorkflow() {
  'use workflow';
  const a = await nullByteStep();
  return a;
}
