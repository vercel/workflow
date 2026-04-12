// Test anonymous default class export with step methods but NO serde methods.
// This exercises the rewrite path where has_serde=false but has_step_methods=true.
// The plugin should still rewrite to a const declaration so registration code
// can reference the class at module scope.

export default class {
  constructor(config) {
    this.config = config;
  }

  async process(input) {
    "use step";
    return { result: input, config: this.config };
  }

  async validate(data) {
    "use step";
    return { valid: true, data };
  }
}
