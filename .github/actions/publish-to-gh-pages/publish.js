// Publishes files from a local directory to `destination-dir` on a
// target branch using the GraphQL `createCommitOnBranch` mutation.
// GitHub signs the resulting commit with its internal key, which is
// required because the repo's enterprise-level ruleset rejects unsigned
// pushes on every ref (including gh-pages).
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ github, context, core }) => {
  const sourceDir = process.env.SOURCE_DIR;
  const destDir = (process.env.DEST_DIR || '').replace(/^\/+|\/+$/g, '');
  const branch = process.env.BRANCH;
  const message = process.env.COMMIT_MESSAGE;
  const { owner, repo } = context.repo;

  if (!fs.existsSync(sourceDir)) {
    core.warning(
      `Source directory "${sourceDir}" does not exist; nothing to publish.`
    );
    return;
  }

  const additions = [];
  const walk = (dir, rel = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, next);
      } else if (entry.isFile()) {
        const contents = fs.readFileSync(abs).toString('base64');
        additions.push({
          path: destDir ? `${destDir}/${next}` : next,
          contents,
        });
      }
    }
  };
  walk(sourceDir);

  if (additions.length === 0) {
    core.warning(
      `Source directory "${sourceDir}" has no files; nothing to publish.`
    );
    return;
  }

  // CommitMessage GraphQL input wants headline (first line) + body
  // (everything after the first blank line).
  const firstNewline = message.indexOf('\n');
  let headline;
  let body;
  if (firstNewline === -1) {
    headline = message;
    body = '';
  } else {
    headline = message.slice(0, firstNewline);
    const rest = message.slice(firstNewline + 1);
    body = rest.startsWith('\n') ? rest.slice(1) : rest;
  }

  const mutation = `
    mutation($input: CreateCommitOnBranchInput!) {
      createCommitOnBranch(input: $input) {
        commit { oid url }
      }
    }
  `;

  // Retry once on `expectedHeadOid` mismatch — possible if another
  // workflow run pushes to the same branch between our ref read and
  // the mutation.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { data: ref } = await github.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${branch}`,
    });
    const expectedHeadOid = ref.object.sha;

    try {
      const result = await github.graphql(mutation, {
        input: {
          branch: {
            repositoryNameWithOwner: `${owner}/${repo}`,
            branchName: branch,
          },
          expectedHeadOid,
          message: { headline, body },
          fileChanges: { additions },
        },
      });
      const { oid, url } = result.createCommitOnBranch.commit;
      core.info(`Created signed commit ${oid} on ${branch} (${url})`);
      return;
    } catch (err) {
      const errs = Array.isArray(err.errors) ? err.errors : [];
      const conflicted =
        errs.some((e) => /expected.*head/i.test(e.message || '')) ||
        /expected.*head/i.test(err.message || '');
      if (conflicted && attempt === 1) {
        core.warning(
          `Branch ${branch} HEAD moved during publish; retrying once.`
        );
        continue;
      }
      throw err;
    }
  }
};
