// Test custom serialization with CommonJS namespace require
const serde_1 = require("@workflow/serde");

class Sandbox {
  constructor(sandbox, routes) {
    this.sandbox = sandbox;
    this.routes = routes;
  }

  static [serde_1.WORKFLOW_SERIALIZE](instance) {
    return {
      sandbox: instance.sandbox,
      routes: instance.routes,
    };
  }

  static [serde_1.WORKFLOW_DESERIALIZE](data) {
    const instance = Object.create(Sandbox.prototype);
    instance.sandbox = data.sandbox;
    instance.routes = data.routes;
    return instance;
  }
}

// Class with only serialize (should not be registered)
class PartialClass {
  static [serde_1.WORKFLOW_SERIALIZE](instance) {
    return { value: instance.value };
  }
}

exports.Sandbox = Sandbox;
