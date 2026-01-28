import type { Command, ExecResult } from '../../types.js';

export const trueCommand: Command = {
  name: 'true',

  async execute(): Promise<ExecResult> {
    return { stdout: '', stderr: '', exitCode: 0 };
  },
};

export const falseCommand: Command = {
  name: 'false',

  async execute(): Promise<ExecResult> {
    return { stdout: '', stderr: '', exitCode: 1 };
  },
};
