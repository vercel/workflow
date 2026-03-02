export async function stepWithThis() {
  'use step';
  // `this` is allowed in step functions
  return this.value;
}

export async function stepWithArguments() {
  'use step';
  // `arguments` is allowed in step functions
  return arguments[0];
}

class TestClass extends BaseClass {
  async stepMethod() {
    'use step';
    // `super` is allowed in step functions
    return super.method();
  }
}
