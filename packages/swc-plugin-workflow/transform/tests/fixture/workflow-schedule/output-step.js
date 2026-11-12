/**__internal_workflows{"workflows":{"input.js":{"digest":{"workflowId":"workflow//./input//digest","schedule":[{"cron":"0 9 * * 1-5","name":"weekday-digest"},{"cron":"0 11 * * 0,6","jitter":15,"name":"weekend-digest"}]},"nightlyReport":{"workflowId":"workflow//./input//nightlyReport","schedule":{"cron":"0 2 * * *","jitter":5,"timezone":"America/New_York"}},"unscheduled":{"workflowId":"workflow//./input//unscheduled"}}}}*/;
export async function nightlyReport(run) {
    throw new Error("You attempted to execute workflow nightlyReport function directly. To start a workflow, use start(nightlyReport) from workflow/api");
}
nightlyReport.workflowId = "workflow//./input//nightlyReport";
nightlyReport.experimental_schedule = {
    cron: '0 2 * * *',
    timezone: 'America/New_York',
    jitter: 5
};
export const digest = async (run)=>{
    throw new Error("You attempted to execute workflow digest function directly. To start a workflow, use start(digest) from workflow/api");
};
digest.workflowId = "workflow//./input//digest";
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
export async function unscheduled() {
    throw new Error("You attempted to execute workflow unscheduled function directly. To start a workflow, use start(unscheduled) from workflow/api");
}
unscheduled.workflowId = "workflow//./input//unscheduled";
