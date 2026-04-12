// Test named default class export with serde and step methods.
// Named default exports already have the class name in scope,
// so no rewriting is needed — just ensure the name is used for registration.
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';

export default class MyService {
  constructor(config) {
    this.config = config;
  }

  static [WORKFLOW_SERIALIZE](instance) {
    return { config: instance.config };
  }

  static [WORKFLOW_DESERIALIZE](data) {
    return new MyService(data.config);
  }

  async handle(request) {
    "use step";
    return { response: request };
  }
}
