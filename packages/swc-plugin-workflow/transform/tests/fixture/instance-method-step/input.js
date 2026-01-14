import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@vercel/workflow';

export class Calculator {
  static [WORKFLOW_SERIALIZE](instance) {
    return { multiplier: instance.multiplier };
  }

  static [WORKFLOW_DESERIALIZE](data) {
    return new Calculator(data.multiplier);
  }

  constructor(multiplier) {
    this.multiplier = multiplier;
  }

  async multiply(value) {
    'use step';
    return value * this.multiplier;
  }

  async add(a, b) {
    'use step';
    return a + b + this.multiplier;
  }
}
