module.exports = async ({ github, context }) => {
  const pr = await github.rest.pulls.get({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: context.issue.number
  });
  
  return {
    head_ref: pr.data.head.ref,
    head_sha: pr.data.head.sha,
    head_repo_full_name: pr.data.head.repo.full_name,
    base_ref: pr.data.base.ref,
    title: pr.data.title,
    number: pr.data.number,
    user: pr.data.user.login
  };
};
