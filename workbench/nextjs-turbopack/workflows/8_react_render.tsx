async function render(a: number, b: number): Promise<string> {
  'use step';

  const ReactDOM = await import('react-dom/server');
  return ReactDOM.renderToString(<div>hello world {a + b}</div>);
}

export async function reactWorkflow() {
  'use workflow';

  console.log('calling render step');
  const result = await render(1, 1);

  return result;
}
