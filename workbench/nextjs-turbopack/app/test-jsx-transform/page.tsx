// Test file WITHOUT "use workflow" or "use step" directives
// This should use automatic JSX transform and NOT fail with "React is not defined"

export default function TestPage() {
  return (
    <div>
      <h1>JSX Transform Test</h1>
      <p>This component has JSX but no React import.</p>
      <p>If the automatic JSX transform works, this will render correctly.</p>
      <ul>
        <li>Item 1</li>
        <li>Item 2</li>
        <li>Item 3</li>
      </ul>
    </div>
  );
}
