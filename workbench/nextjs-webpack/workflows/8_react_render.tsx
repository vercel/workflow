async function render(a: number, b: number): Promise<string> {
  'use step';

  // biome-ignore lint/security/noGlobalEval: need to avoid next.js rule about using react-dom directly
  const ReactDOM = eval('require("react-dom/server")');
  return ReactDOM.renderToString(<div>hello world {a + b}</div>);
}

export async function reactWorkflow() {
  'use workflow';

  console.log('calling render step');
  const result = await render(1, 1);

  return result;
}
