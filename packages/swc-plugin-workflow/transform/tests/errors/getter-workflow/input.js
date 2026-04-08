export class TestClass {
  // OK: getter with "use step" is allowed
  get value() {
    'use step';
    return 42;
  }

  // Error: getter with "use workflow" is not allowed
  get entry() {
    'use workflow';
    return 'not allowed';
  }
}
