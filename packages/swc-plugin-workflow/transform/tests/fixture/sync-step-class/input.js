// Test sync step functions in class contexts

export class Service {
  // Sync static step method
  static getConfig() {
    'use step';
    return { timeout: 30000 };
  }

  // Async static step method (for comparison)
  static async fetchData(url) {
    'use step';
    return { url };
  }

  // Async static workflow method that calls sync and async steps
  static async run() {
    'use workflow';
    const config = await Service.getConfig();
    const data = await Service.fetchData('/api');
    return { config, data };
  }
}

// Sync function expression with var
export var syncFnExpr = function process(data) {
  'use step';
  return data * 2;
};

// Sync function expression with let
export let syncFnExprLet = function transform(input) {
  'use step';
  return String(input);
};
