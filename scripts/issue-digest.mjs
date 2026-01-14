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
 *   ISSUE_DIGEST_COUNT - number of issues to include
 */

const SLACK_API_URL = 'https://slack.com/api/chat.postMessage';
const SLACK_SECTION_TEXT_LIMIT = 2900; // Slack section text limit is 3000 chars; keep buffer.
const SLACK_BLOCK_LIMIT = 50;

const ISSUE_LIMIT = 10;
const DEFAULT_DIGEST_INTERVAL_DAYS = 7;

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

  const headers = {
    // Include reactions payload for issues (`reactions.total_count`, `reactions['+1']`, etc).
    Accept:
      'application/vnd.github+json, application/vnd.github.squirrel-girl-preview+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'workflow-issue-digest',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, { headers });

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = json?.message ? `: ${json.message}` : '';
    throw new Error(`GitHub API error (${res.status} ${res.statusText})${msg}`);
  }

  const issues = Array.isArray(json) ? json : [];
  const onlyIssues = issues.filter((i) => i && !i.pull_request);
  return onlyIssues.slice(0, count);
}

function formatShortDateUTC(date) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function daysAgoUTC(now, created) {
  const ms = now.getTime() - created.getTime();
  if (ms <= 0) return 0;
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

function countEmojiReactionsOnIssue(issue) {
  const reactions = issue?.reactions;
  if (!reactions || typeof reactions !== 'object') return 0;
  const total = reactions.total_count;
  return Number.isFinite(total) ? total : 0;
}

function countThumbsUp(issue) {
  const reactions = issue?.reactions;
  if (!reactions || typeof reactions !== 'object') return 0;
  const n = reactions['+1'];
  return Number.isFinite(n) ? n : 0;
}

async function fetchCommentsSince({
  owner,
  repo,
  issueNumber,
  sinceISO,
  token,
}) {
  const baseUrl = new URL(
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`
  );
  baseUrl.searchParams.set('since', sinceISO);
  baseUrl.searchParams.set('per_page', '100');

  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'workflow-issue-digest',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let total = 0;
  for (let page = 1; page <= 10; page++) {
    const url = new URL(baseUrl);
    url.searchParams.set('page', String(page));

    const res = await fetch(url, { headers });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = json?.message ? `: ${json.message}` : '';
      throw new Error(
        `GitHub API error (${res.status} ${res.statusText}) fetching comments for #${issueNumber}${msg}`
      );
    }

    const pageItems = Array.isArray(json) ? json : [];
    total += pageItems.length;
    if (pageItems.length < 100) break;
  }

  return total;
}

function scoreIssue({
  intervalDays,
  createdAtDaysAgo,
  commentsSinceInterval,
  emojiReactions,
}) {
  return (
    intervalDays -
    createdAtDaysAgo +
    2 * commentsSinceInterval +
    0.5 * emojiReactions
  );
}

function buildSlackPayload({
  repoFullName,
  issues,
  digestIntervalDays,
  totalEligible,
}) {
  const shownCount = issues.length;
  const title = `Top ${shownCount} issues (last ${digestIntervalDays}d) in ${repoFullName}`;

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
      const issueUrl =
        issue.html_url || `https://github.com/${repoFullName}/issues/${num}`;
      const titleText = String(issue.title ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      const createdAt = issue.created_at ? new Date(issue.created_at) : null;
      const dateText = createdAt ? formatShortDateUTC(createdAt) : '';
      const commentsSince = issue._commentsSinceInterval ?? 0;
      const thumbsUp = countThumbsUp(issue);
      const author = issue.user?.login || 'unknown';

      // Example:
      // Jan 12 - 3 :speech_balloon: / 0 :thumbsup: - <...|#777> by someGitAuthor - Streaming timeouts
      const issueRef = `<${issueUrl}|#${num}>`;
      return `${dateText} - ${commentsSince} :speech_balloon: / ${thumbsUp} :thumbsup: - ${issueRef} by ${author} - ${titleText}`.trim();
    });

    const chunks = chunkByLines(
      issueLines.join('\n'),
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

  if (totalEligible > ISSUE_LIMIT) {
    const remaining = totalEligible - ISSUE_LIMIT;
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `…and *${remaining}* more issues created in the last ${digestIntervalDays} days.`,
      },
    });
  }

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

  const digestIntervalDays = clampInt(
    process.env.DIGEST_INTERVAL_DAYS ?? String(DEFAULT_DIGEST_INTERVAL_DAYS),
    { min: 1, max: 30, fallback: DEFAULT_DIGEST_INTERVAL_DAYS }
  );

  // Token is optional locally (public repo), but workflow will provide `${{ github.token }}`.
  const ghToken = process.env.GITHUB_TOKEN;

  // Over-fetch so scoring has enough candidates even after filtering to the interval.
  const candidateIssues = await fetchLatestIssues({
    owner,
    repo,
    count: Math.max(ISSUE_LIMIT * 4, 50),
    token: ghToken,
  });

  const now = new Date();
  const sinceDate = new Date(
    now.getTime() - digestIntervalDays * 24 * 60 * 60 * 1000
  );
  const sinceISO = sinceDate.toISOString();

  const eligible = candidateIssues.filter((issue) => {
    if (!issue?.created_at) return false;
    const created = new Date(issue.created_at);
    return created >= sinceDate;
  });

  // For scoring we need comments since interval + reaction emoji count.
  const enriched = [];
  for (const issue of eligible) {
    const created = new Date(issue.created_at);
    const createdAtDaysAgo = daysAgoUTC(now, created);
    const commentsSinceInterval = await fetchCommentsSince({
      owner,
      repo,
      issueNumber: issue.number,
      sinceISO,
      token: ghToken,
    });
    const emojiReactions = countEmojiReactionsOnIssue(issue);
    const points = scoreIssue({
      intervalDays: digestIntervalDays,
      createdAtDaysAgo,
      commentsSinceInterval,
      emojiReactions,
    });

    enriched.push({
      ...issue,
      _points: points,
      _createdAtDaysAgo: createdAtDaysAgo,
      _commentsSinceInterval: commentsSinceInterval,
      _emojiReactions: emojiReactions,
    });
  }

  enriched.sort((a, b) => {
    if (b._points !== a._points) return b._points - a._points;
    const bCreated = b.created_at ? new Date(b.created_at).getTime() : 0;
    const aCreated = a.created_at ? new Date(a.created_at).getTime() : 0;
    if (bCreated !== aCreated) return bCreated - aCreated;
    return (b._commentsSinceInterval ?? 0) - (a._commentsSinceInterval ?? 0);
  });

  const top = enriched.slice(0, ISSUE_LIMIT);

  const content = buildSlackPayload({
    repoFullName,
    issues: top,
    digestIntervalDays,
    totalEligible: enriched.length,
  });

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
