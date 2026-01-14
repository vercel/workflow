#!/usr/bin/env node
/**
 * Issue digest for `vercel/workflow`.
 *
 * This intentionally mirrors the existing Slack posting approach used by
 * `scripts/generate-release-slack-payload.mjs`: a small Node script that calls
 * Slack's `chat.postMessage` via `fetch` (no extra dependencies).
 *
 * Usage:
 *   # Print the Slack API payload JSON to stdout (no network call)
 *   node scripts/issue-digest.mjs --print
 *
 *   # Post to Slack via Web API (requires env vars below)
 *   node scripts/issue-digest.mjs --post
 *
 * Environment variables:
 *   GITHUB_TOKEN - GitHub token with access to read issues (GitHub Actions: `${{ github.token }}`)
 *
 *   SLACK_BOT_TOKEN - Slack Bot User OAuth Token (starts with "xoxb-..."), used to call `chat.postMessage`
 *   SLACK_ISSUE_SUMMARY_CHANNEL_ID - Slack Channel ID (e.g. "C0123456789")
 *
 * Optional:
 *   ISSUE_DIGEST_REPO  - repo to query in `owner/repo` form (default: "vercel/workflow")
 *   ISSUE_DIGEST_COUNT - number of issues to include (default: "10")
 */

const SLACK_API_URL = 'https://slack.com/api/chat.postMessage';
const SLACK_SECTION_TEXT_LIMIT = 2900; // Slack section text limit is 3000 chars; keep buffer.
const SLACK_BLOCK_LIMIT = 50;

function parseArgs(argv) {
  const args = new Set(argv.slice(2));
  const wantsPost = args.has('--post');
  const wantsPrint = args.has('--print') || (!wantsPost && !args.has('--help'));
  const wantsHelp = args.has('--help') || args.has('-h');
  return { wantsPost, wantsPrint, wantsHelp };
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parseRepo(repo) {
  const [owner, name] = String(repo || '').split('/');
  if (!owner || !name)
    throw new Error(
      `Invalid ISSUE_DIGEST_REPO (expected "owner/repo"): ${repo}`
    );
  return { owner, repo: name };
}

function clampInt(value, { min, max, fallback }) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function chunkByLines(text, limit) {
  const lines = text.split('\n');
  const chunks = [];
  let current = '';

  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;

    if (next.length <= limit) {
      current = next;
      continue;
    }

    if (current) chunks.push(current);

    // If a single line is too long, hard-split it.
    if (line.length > limit) {
      for (let i = 0; i < line.length; i += limit) {
        chunks.push(line.slice(i, i + limit));
      }
      current = '';
      continue;
    }

    current = line;
  }

  if (current) chunks.push(current);
  return chunks.filter((c) => c.trim().length > 0);
}

async function fetchLatestIssues({ owner, repo, count, token }) {
  // GitHub issues list includes PRs; over-fetch a bit then filter.
  const perPage = clampInt(count + 20, { min: 10, max: 100, fallback: 30 });
  const url = new URL(`https://api.github.com/repos/${owner}/${repo}/issues`);
  url.searchParams.set('state', 'open');
  url.searchParams.set('sort', 'created');
  url.searchParams.set('direction', 'desc');
  url.searchParams.set('per_page', String(perPage));

  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'workflow-issue-digest',
    },
  });

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = json?.message ? `: ${json.message}` : '';
    throw new Error(`GitHub API error (${res.status} ${res.statusText})${msg}`);
  }

  const issues = Array.isArray(json) ? json : [];
  const onlyIssues = issues.filter((i) => i && !i.pull_request);
  return onlyIssues.slice(0, count);
}

function buildSlackPayload({ repoFullName, issues }) {
  const title = `Top ${issues.length} latest issues in ${repoFullName}`;
  const now = new Date().toUTCString();

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: title, emoji: true },
    },
    { type: 'divider' },
  ];

  if (issues.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: 'No open issues found.' },
    });
  } else {
    const issueLines = issues.map((issue) => {
      const num = issue.number;
      const url = issue.html_url;
      const textTitle = String(issue.title ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      const comments = issue.comments ?? 0;
      const userLogin = issue.user?.login;
      const authorText = userLogin
        ? `Author: <https://github.com/${userLogin}|@${userLogin}>`
        : 'Author: unknown';
      const created = issue.created_at
        ? new Date(issue.created_at).toISOString().slice(0, 10)
        : '';

      const metaParts = [
        `Comments: ${comments}`,
        authorText,
        created ? `Created: ${created}` : null,
      ].filter(Boolean);

      return `*<${url}|#${num}>* ${textTitle}\n${metaParts.join(' • ')}`;
    });

    const chunks = chunkByLines(
      issueLines.join('\n\n'),
      SLACK_SECTION_TEXT_LIMIT
    );

    for (const chunk of chunks) {
      // Leave room for divider + context + possible truncation notice.
      if (blocks.length >= SLACK_BLOCK_LIMIT - 3) break;
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: chunk },
      });
    }

    if (chunks.length > 0 && blocks.length >= SLACK_BLOCK_LIMIT - 3) {
      const repoUrl = `https://github.com/${repoFullName}/issues`;
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `_(truncated — see all issues: <${repoUrl}|${repoFullName}>)_`,
        },
      });
    }
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `Last updated: ${now}` }],
  });

  return { text: title, blocks };
}

async function postToSlack({ token, message }) {
  const res = await fetch(SLACK_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(message),
  });

  const json = await res.json().catch(() => null);

  if (!res.ok) {
    throw new Error(`Slack API HTTP error: ${res.status} ${res.statusText}`);
  }
  if (!json || json.ok !== true) {
    const err = json?.error ? `: ${json.error}` : '';
    throw new Error(`Slack API chat.postMessage failed${err}`);
  }

  return json;
}

async function main() {
  const { wantsHelp, wantsPost, wantsPrint } = parseArgs(process.argv);

  if (wantsHelp) {
    console.log(
      [
        'Usage:',
        '  node scripts/issue-digest.mjs --print',
        '  node scripts/issue-digest.mjs --post',
        '',
        'Env (for --post): SLACK_BOT_TOKEN, SLACK_ISSUE_SUMMARY_CHANNEL_ID, GITHUB_TOKEN',
      ].join('\n')
    );
    return;
  }

  const repoFullName = process.env.ISSUE_DIGEST_REPO || 'vercel/workflow';
  const { owner, repo } = parseRepo(repoFullName);
  const count = clampInt(process.env.ISSUE_DIGEST_COUNT ?? '10', {
    min: 1,
    max: 25,
    fallback: 10,
  });

  const ghToken = requireEnv('GITHUB_TOKEN');
  const issues = await fetchLatestIssues({
    owner,
    repo,
    count,
    token: ghToken,
  });

  const content = buildSlackPayload({ repoFullName, issues });

  if (wantsPrint || wantsPost) {
    const channel = requireEnv('SLACK_ISSUE_SUMMARY_CHANNEL_ID');
    const message = { channel, ...content };

    if (wantsPrint) {
      console.log(JSON.stringify(message));
    }

    if (wantsPost) {
      const slackToken = requireEnv('SLACK_BOT_TOKEN');
      const result = await postToSlack({
        token: slackToken,
        message,
      });

      console.log(
        JSON.stringify({
          ok: true,
          channel: result.channel,
          ts: result.ts,
          message: 'posted',
        })
      );
    }
  }
}

await main();
