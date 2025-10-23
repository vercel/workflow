import { Flags } from '@oclif/core';
import { BaseCommand } from '../base.js';

export default class Dev extends BaseCommand {
  static description =
    'Start development server with file watching (Coming soon)';

  static examples = ['$ workflow dev', '$ workflow dev --port 3001'];

  static flags = {
    port: Flags.integer({
      char: 'p',
      description: 'port to run dev server on',
      default: 3000,
    }),
    target: Flags.string({
      char: 't',
      description: 'build target for development',
      options: ['vercel-static', 'vercel-build-output-api'],
      default: 'vercel-static',
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Dev);

    this.logInfo('🚧 Development server is coming soon!');
    this.logInfo('');
    this.logInfo('This command will provide:');
    this.logInfo('• File watching');
    this.logInfo('• Development server for local workflows');
    this.logInfo('• Better error messages and debugging');
    this.logInfo('');
    this.logInfo(`Configured to run on port: ${flags.port}`);
    this.logInfo(`Build target: ${flags.target}`);
    this.logInfo('');
    this.logInfo('For now, use: workflow build --target <target>');
  }
}
