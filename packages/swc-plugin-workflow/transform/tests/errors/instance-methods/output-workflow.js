export class TestClass {
  // Error: instance methods can't have directives
  async instanceMethod() {
    'use step';
    return 'not allowed';
  }
  // Error: instance methods can't have workflow directive either
  async anotherInstance() {
    'use workflow';
    return 'also not allowed';
  }
  // This is ok - static methods can have directives
  static async staticMethod() {
    'use step';
    return 'allowed';
  }
}
