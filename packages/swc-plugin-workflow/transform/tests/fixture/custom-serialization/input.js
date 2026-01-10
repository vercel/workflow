// Class with custom serialization methods using symbols
export class Point {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }

  static [Symbol.for('workflow-serialize')](instance) {
    return { x: instance.x, y: instance.y };
  }

  static [Symbol.for('workflow-deserialize')](data) {
    return new Point(data.x, data.y);
  }
}

// Regular class without serialization (should not be registered)
export class RegularClass {
  constructor(value) {
    this.value = value;
  }
}

// Class with only serialize (not deserialize) - should not be registered
export class OnlySerialize {
  static [Symbol.for('workflow-serialize')](instance) {
    return { value: instance.value };
  }
}
