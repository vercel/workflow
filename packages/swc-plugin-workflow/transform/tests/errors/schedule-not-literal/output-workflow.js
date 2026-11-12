/**__internal_workflows{"workflows":{"input.js":{"nightlyReport":{"workflowId":"workflow//./input//nightlyReport"}}}}*/;
const CRON = '0 2 * * *';
export async function nightlyReport() {}
nightlyReport.workflowId = "workflow//./input//nightlyReport";
globalThis.__private_workflows.set("workflow//./input//nightlyReport", nightlyReport);
nightlyReport.experimental_schedule = {
    cron: CRON
};
