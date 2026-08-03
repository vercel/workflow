// Custom changelog generator that wraps `@changesets/changelog-github`.
//
// Why this exists
// ---------------
// Our backport workflow (.github/workflows/backport.yml) replays commits
// from `main` onto `stable` using GitHub's GraphQL `createCommitOnBranch`
// mutation so the resulting commits are signed by GitHub's internal key.
// A consequence is that the backport commit, and the PR that wraps it,
// are both attributed to `github-actions[bot]` — not the original author.
//
// `@changesets/changelog-github` resolves the author/PR of a changeset
// commit via the GraphQL `associatedPullRequests` field. For commits that
// landed on `stable` via the backport flow, that resolves to the backport
// PR (e.g. "Backport #2046: ...") authored by `github-actions[bot]`, and
// the rendered changelog ends up with "Thanks @github-actions!".
//
// What this wrapper does
// ----------------------
// 1. For each changeset commit, look up its associated PR title and body.
// 2. Detect backport PRs by matching the title (`Backport #N: ...`) or
//    body (`Automated backport of #N to \`stable\``) — both formats are
//    produced by .github/workflows/backport.yml.
// 3. When a backport PR is detected, inject `pr: <originalPR>` and
//    `commit: <backportSha>` lines into the changeset summary before
//    handing off to the upstream changelog generator. Those lines are a
//    documented `@changesets/changelog-github` feature
//    (https://github.com/changesets/changesets/blob/main/packages/changelog-github/README.md#usage)
//    and trigger a PR-number-based lookup, which attributes the entry to
//    the original PR's author while keeping the commit link pointing at
//    the backport commit on the release branch.
// 4. Falls back to plain delegation when no backport is detected, when
//    the commit has no associated PR, or when any lookup fails — we never
//    want a flaky network call to break `pnpm changeset version`.
// 5. Caps how many entries resolve concurrently so the upstream
//    `@changesets/get-github-info` DataLoader (created with no
//    `maxBatchSize`) splits its lookups across several small GraphQL
//    queries instead of one oversized query. With a large release backlog
//    (hundreds of changesets), a single batched query grows past what
//    GitHub's GraphQL endpoint will reliably serve — it returns a
//    truncated/gzip-broken body (which `node-fetch@2` surfaces as
//    `ERR_STREAM_PREMATURE_CLOSE`) or a 502, aborting the whole release.
// 6. Wraps the upstream delegation in a try/catch with a network-free
//    fallback line, so a transient failure on one batch degrades a single
//    entry instead of failing the release. This finally extends point 4's
//    "never let a network call break the release" promise to the
//    delegation path, which previously bypassed it.
//
// Note: this file is loaded by `@changesets/apply-release-plan` via a
// synchronous `require()`. Node 22.12+ supports `require()`'ing ESM
// modules with static imports, which we rely on (the release workflow
// uses Node 24). If you add a dynamic import or a top-level await here,
// the loader will throw.

import changelogGithub from '@changesets/changelog-github';

const upstream = changelogGithub.default ?? changelogGithub;

// Max number of upstream changelog lines resolved at once. `get-github-info`
// folds every `getInfo` call made within a single tick into one GraphQL
// query (its DataLoader has no `maxBatchSize`), so this directly bounds the
// batch size — and thus the query/response size — to something GitHub can
// serve reliably. Empirically, batches of this size resolve well within
// GitHub's limits while batches of a few hundred commits do not.
const UPSTREAM_CONCURRENCY = 25;

// Minimal promise concurrency limiter (avoids adding a dependency to a file
// that must be `require()`-able as ESM by the changesets loader). Limiting
// concurrency here is what splits the DataLoader batch across several ticks.
function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    active--;
    if (queue.length > 0) queue.shift()();
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      const run = () => {
        active++;
        fn().then(resolve, reject).finally(next);
      };
      if (active < max) run();
      else queue.push(run);
    });
}

const limitUpstream = createLimiter(UPSTREAM_CONCURRENCY);

// Network-free changelog lines, used only when the upstream GitHub-backed
// generator throws. They mirror `@changesets/changelog-github`'s output
// shape but drop the PR/author attribution we can't resolve offline; the
// commit link is constructed from the SHA without a network call.
function offlineCommitLink(repo, commit) {
  if (!commit) return '';
  const short = commit.slice(0, 7);
  return repo
    ? ` [\`${short}\`](https://github.com/${repo}/commit/${commit})`
    : ` \`${short}\``;
}

function offlineReleaseLine(changeset, options) {
  const [firstLine, ...futureLines] = (changeset.summary ?? '')
    .split('\n')
    .map((l) => l.trimEnd());
  const prefix = offlineCommitLink(options?.repo, changeset.commit);
  return `\n\n-${prefix ? `${prefix} -` : ''} ${firstLine}\n${futureLines
    .map((l) => `  ${l}`)
    .join('\n')}`;
}

function offlineDependencyReleaseLine(changesets, dependenciesUpdated, options) {
  if (dependenciesUpdated.length === 0) return '';
  const links = changesets
    .map((cs) => offlineCommitLink(options?.repo, cs.commit).trim())
    .filter(Boolean)
    .join(', ');
  const changesetLink = `- Updated dependencies${links ? ` [${links}]` : ''}:`;
  const updated = dependenciesUpdated.map(
    (dependency) => `  - ${dependency.name}@${dependency.newVersion}`,
  );
  return [changesetLink, ...updated].join('\n');
}

// Match the PR titles and bodies produced by .github/workflows/backport.yml.
// Title examples:
//   "Backport #2046: Report corrupted event logs distinctly"
//   "Backport a1b2c3d: <subject>"  (when no source PR was associated)
// Body examples:
//   "Automated backport of #2046 to `stable` ..."
//   "Automated backport of a1b2c3def456 to `stable` ..."
const BACKPORT_TITLE_PR_RE = /^Backport\s+#(\d+):/i;
const BACKPORT_BODY_PR_RE = /Automated\s+backport\s+of\s+#(\d+)\s+to\s+`stable`/i;

function readEnv() {
  return {
    GITHUB_GRAPHQL_URL:
      process.env.GITHUB_GRAPHQL_URL || 'https://api.github.com/graphql',
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  };
}

// Lightweight in-process cache so multiple changesets pointing at the
// same commit don't trigger duplicate GraphQL lookups. The values are
// promises so concurrent callers share a single in-flight request.
const commitLookupCache = new Map();
const prLookupCache = new Map();

// Defensive error formatter — we don't want a non-Error throw (e.g.
// `throw null`, or a non-conforming Error from a transport polyfill) to
// turn a benign GitHub lookup failure into a hard crash inside the catch
// block itself.
function formatError(err) {
  return err instanceof Error ? err.message : String(err);
}

async function githubGraphql(query) {
  const { GITHUB_GRAPHQL_URL, GITHUB_TOKEN } = readEnv();
  if (!GITHUB_TOKEN) {
    // No token means the upstream `getInfo` call would have failed too —
    // let it surface the error so behavior is consistent with the
    // unwrapped generator.
    return null;
  }
  const res = await fetch(GITHUB_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    throw new Error(
      `GitHub GraphQL request failed: ${res.status} ${res.statusText}`,
    );
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error(
      `GitHub GraphQL request returned errors: ${JSON.stringify(json.errors)}`,
    );
  }
  return json.data;
}

// Returns the associated PR (number, title, body) for a commit, or null
// if no PR is associated / the lookup failed.
function lookupCommitPR(repo, commit) {
  const cacheKey = `${repo}@${commit}`;
  if (!commitLookupCache.has(cacheKey)) {
    commitLookupCache.set(
      cacheKey,
      (async () => {
        const [owner, name] = repo.split('/');
        const query = `
          query {
            repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
              object(expression: ${JSON.stringify(commit)}) {
                ... on Commit {
                  associatedPullRequests(first: 10) {
                    nodes {
                      number
                      title
                      body
                      mergedAt
                    }
                  }
                }
              }
            }
          }
        `;
        try {
          const data = await githubGraphql(query);
          const nodes =
            data?.repository?.object?.associatedPullRequests?.nodes ?? [];
          if (nodes.length === 0) return null;
          // Only consider *merged* PRs — open PRs that happen to share
          // a commit (e.g. a draft backport branched off the same SHA)
          // shouldn't influence attribution. Then sort ascending by
          // `mergedAt` (oldest first) to match `@changesets/get-github-info`'s
          // selection logic: the oldest merged PR is the one that *first*
          // introduced the commit to the repository.
          const merged = nodes
            .filter((n) => n.mergedAt !== null)
            .sort((a, b) =>
              new Date(a.mergedAt) > new Date(b.mergedAt) ? 1 : -1,
            );
          if (merged.length === 0) return null;
          return merged[0];
        } catch (err) {
          console.warn(
            `[changelog] failed to look up associated PR for ${commit}: ${formatError(err)}`,
          );
          return null;
        }
      })(),
    );
  }
  return commitLookupCache.get(cacheKey);
}

// Returns { number, title, body } for a PR number, or null if the lookup
// failed.
function lookupPR(repo, prNumber) {
  const cacheKey = `${repo}#${prNumber}`;
  if (!prLookupCache.has(cacheKey)) {
    prLookupCache.set(
      cacheKey,
      (async () => {
        const [owner, name] = repo.split('/');
        const query = `
          query {
            repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
              pullRequest(number: ${prNumber}) {
                number
                title
                body
              }
            }
          }
        `;
        try {
          const data = await githubGraphql(query);
          return data?.repository?.pullRequest ?? null;
        } catch (err) {
          console.warn(
            `[changelog] failed to look up PR #${prNumber}: ${formatError(err)}`,
          );
          return null;
        }
      })(),
    );
  }
  return prLookupCache.get(cacheKey);
}

// Returns the original PR number if `pr` is a backport PR, else null.
// Recurses one level in case of unusual chains (a backport of a backport),
// bounded so we can never loop on cycles in the PR graph.
async function resolveOriginalPR(repo, pr, depth = 0) {
  if (!pr || depth > 3) return null;
  const titleMatch = pr.title?.match(BACKPORT_TITLE_PR_RE);
  const bodyMatch = pr.body?.match(BACKPORT_BODY_PR_RE);
  const originalPRNumber = titleMatch
    ? Number(titleMatch[1])
    : bodyMatch
      ? Number(bodyMatch[1])
      : null;
  if (!originalPRNumber || originalPRNumber === pr.number) return null;
  const originalPR = await lookupPR(repo, originalPRNumber);
  if (!originalPR) return originalPRNumber; // best-effort: still attribute
  // If the "original" is itself a backport (unusual but defensible),
  // peel one more layer.
  const deeper = await resolveOriginalPR(repo, originalPR, depth + 1);
  return deeper ?? originalPR.number;
}

// Mutate a changeset summary by injecting `pr:`, `commit:` lines if and
// only if the commit's associated PR is a backport. Returns a new
// changeset object (does not modify the caller's input).
async function maybeRewriteChangesetForBackport(changeset, options) {
  if (!changeset.commit) return changeset;
  if (!options || !options.repo) return changeset;

  // Don't rewrite if the user already supplied explicit `pr:` / `commit:`
  // / `author:` directives in the summary — they win.
  const summary = changeset.summary ?? '';
  if (
    /^\s*(?:pr|pull|pull\s+request|commit|author|user):/im.test(summary)
  ) {
    return changeset;
  }

  const pr = await lookupCommitPR(options.repo, changeset.commit);
  if (!pr) return changeset;

  const originalPRNumber = await resolveOriginalPR(options.repo, pr);
  if (!originalPRNumber) return changeset;

  // Inject directives at the top of the summary. The upstream parser
  // strips them out before rendering the body, so they won't appear in
  // the final changelog.
  const rewrittenSummary =
    `pr: #${originalPRNumber}\n` +
    `commit: ${changeset.commit}\n` +
    summary;

  return { ...changeset, summary: rewrittenSummary };
}

export async function getDependencyReleaseLine(
  changesets,
  dependenciesUpdated,
  options,
) {
  // For the dependency-updates roll-up line, the upstream generator
  // only renders commit links (no "Thanks" attribution), so we don't
  // need any rewriting here.
  try {
    return await limitUpstream(() =>
      upstream.getDependencyReleaseLine(
        changesets,
        dependenciesUpdated,
        options,
      ),
    );
  } catch (err) {
    console.warn(
      `[changelog] upstream getDependencyReleaseLine failed, using offline fallback: ${formatError(err)}`,
    );
    return offlineDependencyReleaseLine(
      changesets,
      dependenciesUpdated,
      options,
    );
  }
}

export async function getReleaseLine(changeset, type, options) {
  const rewritten = await maybeRewriteChangesetForBackport(changeset, options);
  try {
    return await limitUpstream(() =>
      upstream.getReleaseLine(rewritten, type, options),
    );
  } catch (err) {
    console.warn(
      `[changelog] upstream getReleaseLine failed, using offline fallback: ${formatError(err)}`,
    );
    // Use the ORIGINAL changeset, not `rewritten`. The backport rewrite
    // prepends `pr:`/`commit:` directive lines that the upstream generator
    // strips before rendering — but `offlineReleaseLine` renders the summary
    // verbatim, so feeding it `rewritten` would leak those directives into
    // the changelog (the entry title would become literally `pr: #N`). The
    // rewrite only touches `summary`; `changeset.commit` is unchanged, so the
    // offline commit link is identical either way.
    return offlineReleaseLine(changeset, options);
  }
}
