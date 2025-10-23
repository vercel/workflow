// Error: Can't have both directives in the same file
'use step';
'use workflow';

export async function test() {
  return 42;
}
