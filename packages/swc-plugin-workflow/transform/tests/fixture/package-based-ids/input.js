// Tests that when package_path is provided, IDs use the package specifier
// instead of the filename. This ensures stable IDs across export conditions.

const serialize = Symbol.for("workflow-serialize");
const deserialize = Symbol.for("workflow-deserialize");

export class MyClass {
  value;
  constructor(value) {
    this.value = value;
  }
  static [serialize](instance) {
    return { value: instance.value };
  }
  static [deserialize](data) {
    return new MyClass(data.value);
  }
}

export async function myWorkflow() {
  "use workflow";
  return "hello";
}

export async function myStep() {
  "use step";
  return 42;
}
