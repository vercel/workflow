import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';

export class DataProcessor {
  static [WORKFLOW_SERIALIZE](instance) {
    return { factor: instance.factor };
  }

  static [WORKFLOW_DESERIALIZE](data) {
    return new DataProcessor(data.factor);
  }

  constructor(factor) {
    this.factor = factor;
  }

  get result() {
    'use step';
    return this.factor * 42;
  }

  async multiply(value) {
    'use step';
    return value * this.factor;
  }
}
