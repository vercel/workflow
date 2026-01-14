export class TestClass {
  // OK: instance methods can have "use step" directive
  async instanceMethod() {
    'use step';
    return 'allowed';
  }

  // Error: instance methods can't have "use workflow" directive
  async anotherInstance() {
    'use workflow';
    return 'not allowed';
  }

  // OK: static methods can have directives
  static async staticMethod() {
    'use step';
    return 'allowed';
  }
}
