import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';
import { getWorld } from './world.js';
import { importKey } from './encryption.js';
/**__internal_workflows{"steps":{"input.js":{"Run#cancel":{"stepId":"step//./input//Run#cancel"},"Run#value":{"stepId":"step//./input//Run#value"}}},"classes":{"input.js":{"Run":{"classId":"class//./input//Run"}}}}*/;
export class Run {
    static [WORKFLOW_SERIALIZE](instance) {
        return {
            id: instance.id
        };
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
    constructor(id){
        this.id = id;
    }
    get value() {
        return this.#getEncryptionKey().then(()=>getWorld().get(this.id));
    }
    async cancel() {
        const key = await this.#getEncryptionKey();
        await getWorld().cancel(this.id, key);
    }
    toString() {
        return `Run(${this.id}, ${this.#label})`;
    }
}
(function(__wf_cls, __wf_id) {
    var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_cls);
    Object.defineProperty(__wf_cls, "classId", {
        value: __wf_id,
        writable: false,
        enumerable: false,
        configurable: false
    });
})(Run, "class//./input//Run");
