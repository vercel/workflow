/**__internal_workflows{"workflows":{"input.js":{"JobRunner.execute":{"workflowId":"workflow//./input//JobRunner.execute"},"JobRunner.runJob":{"workflowId":"workflow//./input//JobRunner.runJob"}}}}*/;
export class JobRunner {
    static async runJob(jobId) {
        const result = await processJob(jobId);
        return result;
    }
    static async execute(config) {
        return await runTask(config);
    }
    // Regular static method (no directive)
    static getVersion() {
        return '1.0.0';
    }
}
JobRunner.runJob.workflowId = "workflow//./input//JobRunner.runJob";
globalThis.__private_workflows.set("workflow//./input//JobRunner.runJob", JobRunner.runJob);
JobRunner.execute.workflowId = "workflow//./input//JobRunner.execute";
globalThis.__private_workflows.set("workflow//./input//JobRunner.execute", JobRunner.execute);
