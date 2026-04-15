import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';
import { getWorld } from './world.js';
import { importKey } from './encryption.js';

export class Run {
  static [WORKFLOW_SERIALIZE](instance) {
    return { id: instance.id };
  }

  static [WORKFLOW_DESERIALIZE](data) {
    return new Run(data.id);
  }

  // Public field — should be kept
  id;

  // Native private field — only referenced by #getEncryptionKey
  #encryptionKeyPromise = null;

  // Native private field — referenced by toString (public), should survive
  #label = 'run';

  // Native private method — only called by stripped step methods
  async #getEncryptionKey() {
    if (!this.#encryptionKeyPromise) {
      this.#encryptionKeyPromise = importKey(this.id);
    }
    return this.#encryptionKeyPromise;
  }

  constructor(id) {
    this.id = id;
  }

  get value() {
    'use step';
    return this.#getEncryptionKey().then(() => getWorld().get(this.id));
  }

  async cancel() {
    'use step';
    const key = await this.#getEncryptionKey();
    await getWorld().cancel(this.id, key);
  }

  toString() {
    return `Run(${this.id}, ${this.#label})`;
  }
}
