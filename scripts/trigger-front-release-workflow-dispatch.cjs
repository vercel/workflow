module.exports = async ({ github }) => {
  const [owner, repo] = process.env.FRONT_REPO.split('/');

  try {
    await github.rest.actions.createWorkflowDispatch({
      owner,
      repo,
      workflow_id: process.env.FRONT_WORKFLOW_ID,
      ref: 'main',
      inputs: {
        mode: process.env.MODE,
        source_repo: process.env.SOURCE_REPO,
        source_pr_number: process.env.SOURCE_PR_NUMBER,
        source_pr_url: process.env.SOURCE_PR_URL,
        workflow_version: process.env.WORKFLOW_VERSION,
        docs_deployment_url: process.env.DOCS_DEPLOYMENT_URL,
      },
    });
  } catch (error) {
    console.error(
      'Failed to trigger front-end release workflow dispatch with the following context:',
      {
        owner,
        repo,
        FRONT_WORKFLOW_ID: process.env.FRONT_WORKFLOW_ID,
        MODE: process.env.MODE,
        SOURCE_REPO: process.env.SOURCE_REPO,
        SOURCE_PR_NUMBER: process.env.SOURCE_PR_NUMBER,
        SOURCE_PR_URL: process.env.SOURCE_PR_URL,
        WORKFLOW_VERSION: process.env.WORKFLOW_VERSION,
        DOCS_DEPLOYMENT_URL: process.env.DOCS_DEPLOYMENT_URL,
      }
    );
    console.error('Original error when calling github.rest.actions.createWorkflowDispatch:', error);
    throw new Error(
      'Error triggering front-end release workflow dispatch. See logs for environment context and original error.'
    );
  }
};
