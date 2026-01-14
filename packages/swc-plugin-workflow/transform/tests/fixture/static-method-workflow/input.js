export class JobRunner {
  static async runJob(jobId) {
    'use workflow';
    const result = await processJob(jobId);
    return result;
  }

  static async execute(config) {
    'use workflow';
    return await runTask(config);
  }

  // Regular static method (no directive)
  static getVersion() {
    return '1.0.0';
  }
}

