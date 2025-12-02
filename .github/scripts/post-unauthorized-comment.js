module.exports = async ({ github, context, core }) => {
  await github.rest.issues.createComment({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: context.issue.number,
    body: '❌ Only repository admins and maintainers can trigger CI runs. You have insufficient permissions.'
  });
  core.setFailed('Insufficient permissions to trigger CI');
};
