async function render(a: number, b: number): Promise<string> {
  'use step';

  const { renderToString } = await import('react-dom/server');
  return renderToString(<div>hello world {a + b}</div>);
}

export async function reactWorkflow() {
  'use workflow';

  console.log('calling render step');
  const result = await render(1, 1);

  return result;
}
