/**
 * A serializable class whose only serde marker is an imported computed key.
 *
 * This file must not contain a workflow directive, an `@workflow/serde`
 * import, or a `Symbol.for(...)` serde key. The `[WORKFLOW_SERIALIZE]` keys
 * below are then the only thing that tells a bundler to run the workflow
 * transform on it, which is the `@ai-sdk/openai` shape from
 * https://github.com/vercel/workflow/issues/4897. Under Turbopack, if the
 * loader's content condition misses that key, the class is never registered
 * in the step bundle and steps fail with `Class "..." not found`.
 */

import {
  WORKFLOW_DESERIALIZE,
  WORKFLOW_SERIALIZE,
} from './serde-imported-keys';

export class Temperature {
  celsius: number;

  constructor(celsius: number) {
    this.celsius = celsius;
  }

  static [WORKFLOW_SERIALIZE](instance: Temperature) {
    return { celsius: instance.celsius };
  }

  static [WORKFLOW_DESERIALIZE](data: { celsius: number }) {
    return new Temperature(data.celsius);
  }

  toFahrenheit(): number {
    return (this.celsius * 9) / 5 + 32;
  }

  warmer(by: number): Temperature {
    return new Temperature(this.celsius + by);
  }
}
