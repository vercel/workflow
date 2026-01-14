// Test custom serialization with imported symbols from '@workflow/serde'
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';

// Class using imported symbols
export class Vector {
  constructor(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  static [WORKFLOW_SERIALIZE](instance) {
    return { x: instance.x, y: instance.y, z: instance.z };
  }

  static [WORKFLOW_DESERIALIZE](data) {
    return new Vector(data.x, data.y, data.z);
  }
}

// Class using renamed imports
import { WORKFLOW_SERIALIZE as WS, WORKFLOW_DESERIALIZE as WD } from '@workflow/serde';

export class Color {
  constructor(r, g, b) {
    this.r = r;
    this.g = g;
    this.b = b;
  }

  static [WS](instance) {
    return { r: instance.r, g: instance.g, b: instance.b };
  }

  static [WD](data) {
    return new Color(data.r, data.g, data.b);
  }
}
