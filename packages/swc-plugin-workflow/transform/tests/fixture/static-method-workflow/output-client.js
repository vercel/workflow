/**__internal_workflows{"workflows":{"workflow//./input//JobRunner.execute":{"name":"JobRunner.execute","source":"input.js"},"workflow//./input//JobRunner.runJob":{"name":"JobRunner.runJob","source":"input.js"}}}*/;
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
JobRunner.runJob.workflowId = "workflow//./input//JobRunner.runJob";
JobRunner.execute.workflowId = "workflow//./input//JobRunner.execute";
