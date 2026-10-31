module.exports = async ({ github, context, core, exec }, prDetails) => {
  const timestamp = new Date().getTime();
  const ciBranchName = `ci-test/${prDetails.number}-${timestamp}`;
  
  // Add remote for the external fork if it's from a fork
  if (prDetails.head_repo_full_name !== `${context.repo.owner}/${context.repo.repo}`) {
    await exec.exec('git', ['remote', 'add', 'external', `https://github.com/${prDetails.head_repo_full_name}.git`]);
    await exec.exec('git', ['fetch', 'external', prDetails.head_ref]);
    await exec.exec('git', ['checkout', '-b', ciBranchName, `external/${prDetails.head_ref}`]);
  } else {
    await exec.exec('git', ['fetch', 'origin', prDetails.head_ref]);
    await exec.exec('git', ['checkout', '-b', ciBranchName, `origin/${prDetails.head_ref}`]);
  }
  
  // Push the new branch to origin
  await exec.exec('git', ['push', 'origin', ciBranchName]);
  
  // Create a draft PR
  const newPR = await github.rest.pulls.create({
    owner: context.repo.owner,
    repo: context.repo.repo,
    title: `[CI Test] ${prDetails.title}`,
    head: ciBranchName,
    base: prDetails.base_ref,
    body: `🤖 **Automated CI Test PR**

This is an automated PR created to run CI tests for PR #${prDetails.number} by @${prDetails.user}.

**Original PR:** #${prDetails.number}
**Triggered by:** @${context.actor}
**Source branch:** \`${prDetails.head_ref}\`
**Source SHA:** \`${prDetails.head_sha}\`

⚠️ **This PR will be automatically closed once CI completes.** Do not merge this PR.

---
_This PR was created in response to the \`/run-ci\` command in #${prDetails.number}_`,
    draft: true
  });
  
  // Comment on the original PR
  await github.rest.issues.createComment({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: context.issue.number,
    body: `✅ CI test triggered by @${context.actor}!

CI is now running in draft PR #${newPR.data.number}. You can monitor the progress there.

Once the tests complete, you can review the results and the draft PR will be automatically closed.`
  });
  
  // Add label to the new PR
  await github.rest.issues.addLabels({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: newPR.data.number,
    labels: ['ci-test', 'automated']
  });
  
  core.setOutput('ci_pr_number', newPR.data.number);
  core.setOutput('ci_branch_name', ciBranchName);
};
