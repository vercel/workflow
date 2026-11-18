/**
 * A serializable class in its own module, for the inline-start serde check
 * (`inline_serde.ts`). No workflow directive here: the class reaches a
 * per-workflow inline entry only through the app's shared serde prelude, and
 * the workflow VM must still revive it.
 */
export class InlinePoint {
  x: number;
  y: number;

  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }

  static [Symbol.for('workflow-serialize')](instance: InlinePoint) {
    return { x: instance.x, y: instance.y };
  }

  static [Symbol.for('workflow-deserialize')](data: { x: number; y: number }) {
    return new InlinePoint(data.x, data.y);
  }

  sum(): number {
    return this.x + this.y;
  }
}
