import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';
import { getWorld } from './world.js';
import { importKey } from './encryption.js';
/**__internal_workflows{"steps":{"input.ts":{"Run#cancel":{"stepId":"step//./input//Run#cancel"},"Run#value":{"stepId":"step//./input//Run#value"}}},"classes":{"input.ts":{"Run":{"classId":"class//./input//Run"}}}}*/;
export class Run {
    static [WORKFLOW_SERIALIZE](instance: Run) {
        return {
            id: instance.id
        };
    }
    static [WORKFLOW_DESERIALIZE](data: {
        id: string;
    }) {
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
    constructor(id: string){
        this.id = id;
    }
    // Step getter — references private members, will be stripped
    get value(): Promise<any> {
        return this.getEncryptionKey().then(()=>getWorld().get(this.id));
    }
    // Step method — references private members, will be stripped
    async cancel(): Promise<void> {
        const key = await this.getEncryptionKey();
        await getWorld().cancel(this.id, key);
    }
    // Non-step public method — should be kept
    toString(): string {
        return `Run(${this.id})`;
    }
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "cancel",
        configurable: true
    });
})(Run.prototype["cancel"], "step//./input//Run#cancel");
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "value",
        configurable: true
    });
})(Object.getOwnPropertyDescriptor(Run.prototype, "value").get, "step//./input//Run#value");
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
