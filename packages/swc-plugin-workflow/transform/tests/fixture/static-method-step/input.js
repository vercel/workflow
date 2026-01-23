export class MyService {
  static async process(data) {
    'use step';
    return data.value * 2;
  }

  static async transform(input, factor) {
    'use step';
    return input * factor;
  }

  // Regular static method (no directive)
  static regularMethod() {
    return 'regular';
  }
}

