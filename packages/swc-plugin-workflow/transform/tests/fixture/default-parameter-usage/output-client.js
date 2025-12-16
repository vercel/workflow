/**__internal_workflows{"workflows":{"input.js":{"myWorkflow":{"workflowId":"workflow//input.js//myWorkflow"}}}}*/;
// Test case for functions used in default parameter values
// The createDefaultDownloadFunction should NOT be removed by DCE
const createDefaultDownloadFunction = (download = defaultDownload)=>(requestedDownloads)=>Promise.all(requestedDownloads.map(async (r)=>r.isUrlSupportedByModel ? null : download(r)));
async function defaultDownload(request) {
    return fetch(request.url);
}
// This function uses createDefaultDownloadFunction in a default parameter value
// DCE must NOT remove createDefaultDownloadFunction
async function convertToLanguageModelPrompt({ prompt, supportedUrls, download = createDefaultDownloadFunction() }) {
    return {
        prompt,
        supportedUrls,
        download
    };
}
export async function myWorkflow(input) {
    throw new Error("You attempted to execute workflow myWorkflow function directly. To start a workflow, use start(myWorkflow) from workflow/api");
}
myWorkflow.workflowId = "workflow//input.js//myWorkflow";
