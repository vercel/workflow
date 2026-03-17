module.exports = async ({ github }) => {
  const [owner, repo] = process.env.FRONT_REPO.split('/');

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
};
