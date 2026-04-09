import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';
import { getWorld } from './world.js';
import { importKey } from './encryption.js';

export class Run {
  static [WORKFLOW_SERIALIZE](instance: Run) {
    return { id: instance.id };
  }

  static [WORKFLOW_DESERIALIZE](data: { id: string }) {
    return new Run(data.id);
  }

  id: string;

  // TS private field — only referenced by stripped methods
  private encryptionKeyPromise: Promise<any> | null = null;

  // TS private method — only called by stripped getters/methods
  private async getEncryptionKey(): Promise<any> {
    if (!this.encryptionKeyPromise) {
      this.encryptionKeyPromise = importKey(this.id);
    }
    return this.encryptionKeyPromise;
  }

  // Public field — should always be kept
  public name: string = '';

  constructor(id: string) {
    this.id = id;
  }

  // Step getter — references private members, will be stripped
  get value(): Promise<any> {
    'use step';
    return this.getEncryptionKey().then(() => getWorld().get(this.id));
  }

  // Step method — references private members, will be stripped
  async cancel(): Promise<void> {
    'use step';
    const key = await this.getEncryptionKey();
    await getWorld().cancel(this.id, key);
  }

  // Non-step public method — should be kept
  toString(): string {
    return `Run(${this.id})`;
  }
}
