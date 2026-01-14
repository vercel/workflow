/**__internal_workflows{"workflows":{"input.js":{"JobRunner.execute":{"workflowId":"workflow//input.js//JobRunner.execute"},"JobRunner.runJob":{"workflowId":"workflow//input.js//JobRunner.runJob"}}}}*/;
export class JobRunner {
    static async runJob(jobId) {
        throw new Error("You attempted to execute workflow JobRunner.runJob function directly. To start a workflow, use start(workflow) from workflow/api");
    }
    static async execute(config) {
        throw new Error("You attempted to execute workflow JobRunner.execute function directly. To start a workflow, use start(workflow) from workflow/api");
    }
    // Regular static method (no directive)
    static getVersion() {
        return '1.0.0';
    }
}
JobRunner.runJob.workflowId = "workflow//input.js//JobRunner.runJob";
JobRunner.execute.workflowId = "workflow//input.js//JobRunner.execute";
