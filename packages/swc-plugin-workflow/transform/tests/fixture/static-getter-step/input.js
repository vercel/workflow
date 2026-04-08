export class Config {
  static get timeout() {
    'use step';
    return 30000;
  }

  static async process(data) {
    'use step';
    return data * 2;
  }
}
