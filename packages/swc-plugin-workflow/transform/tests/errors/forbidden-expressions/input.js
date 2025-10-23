export async function stepWithThis() {
  'use step';
  // Error: this is not allowed
  return this.value;
}

export async function stepWithArguments() {
  'use step';
  // Error: arguments is not allowed
  return arguments[0];
}

class TestClass extends BaseClass {
  async stepMethod() {
    'use step';
    // Error: super is not allowed
    return super.method();
  }
}
