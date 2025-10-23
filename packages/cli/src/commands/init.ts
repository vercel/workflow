import { Flags } from '@oclif/core';
import { BaseCommand } from '../base.js';

export default class Init extends BaseCommand {
  static description = 'Initialize a new workflow project (Coming soon)';

  static examples = [
    '$ workflow init',
    '$ workflow init --template nextjs',
    '$ workflow init --yes',
  ];

  static flags = {
    template: Flags.string({
      description: 'template to use',
      options: ['basic', 'nextjs', 'express'],
    }),
    yes: Flags.boolean({
      char: 'y',
      description: 'skip prompts and use defaults',
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Init);

    this.logInfo('🚧 Project initialization is coming soon!');
    this.logInfo('');
    this.logInfo('This command will provide:');
    this.logInfo('• Interactive project setup');
    this.logInfo('• Multiple project templates');
    this.logInfo('• Automatic configuration file generation');
    this.logInfo('• Dependency installation');
    this.logInfo('• Example workflows and steps');
    this.logInfo('Or we might do a create-workflow-app package');
    this.logInfo('');

    if (flags.template) {
      this.logInfo(`Selected template: ${flags.template}`);
    }

    if (flags.yes) {
      this.logInfo('Auto-accept mode enabled');
    }

    this.logInfo('');
    this.logInfo(
      'For now, manually create your workflow files in a ./workflows directory'
    );
  }
}
