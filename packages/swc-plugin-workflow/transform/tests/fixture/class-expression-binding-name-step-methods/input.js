// Test class expression where binding name differs from internal class name
// AND the class has step methods (instance + static).
// The registration code must reference the binding name (LanguageModel),
// not the internal name (_LanguageModel) which is only scoped inside the class body.
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';

var LanguageModel = class _LanguageModel {
  constructor(modelId, config) {
    this.modelId = modelId;
    this.config = config;
  }

  static [WORKFLOW_SERIALIZE](instance) {
    return { modelId: instance.modelId, config: instance.config };
  }

  static [WORKFLOW_DESERIALIZE](data) {
    return new _LanguageModel(data.modelId, data.config);
  }

  async doStream(prompt) {
    "use step";
    return { stream: prompt };
  }

  static async generate(input) {
    "use step";
    return { result: input };
  }
};

export { LanguageModel };
