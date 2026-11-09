/**__internal_workflows{"workflows":{"input.js":{"digest":{"workflowId":"workflow//./input//digest","schedule":[{"cron":"0 9 * * 1-5","name":"weekday-digest"},{"cron":"0 11 * * 0,6","jitter":15,"name":"weekend-digest"}]},"nightlyReport":{"workflowId":"workflow//./input//nightlyReport","schedule":{"cron":"0 2 * * *","jitter":5,"timezone":"America/New_York"}},"unscheduled":{"workflowId":"workflow//./input//unscheduled"}}}}*/;
export async function nightlyReport(run) {
    return run.scheduledAt;
}
nightlyReport.workflowId = "workflow//./input//nightlyReport";
globalThis.__private_workflows.set("workflow//./input//nightlyReport", nightlyReport);
nightlyReport.experimental_schedule = {
    cron: '0 2 * * *',
    timezone: 'America/New_York',
    jitter: 5
};
export const digest = async (run)=>{
    return run.name;
};
digest.workflowId = "workflow//./input//digest";
globalThis.__private_workflows.set("workflow//./input//digest", digest);
digest.experimental_schedule = [
    {
        cron: '0 9 * * 1-5',
        name: 'weekday-digest'
    },
    {
        cron: `0 11 * * 0,6`,
        name: 'weekend-digest',
        jitter: 15
    }
];
export async function unscheduled() {}
unscheduled.workflowId = "workflow//./input//unscheduled";
globalThis.__private_workflows.set("workflow//./input//unscheduled", unscheduled);
