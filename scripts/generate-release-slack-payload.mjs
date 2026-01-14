#!/usr/bin/env node
/**
 * Generate and/or post a Slack message for the latest Workflow release.
 *
 * It reuses the existing release-note generator (`scripts/generate-release-notes.mjs`)
 * and converts its Markdown-ish body into Slack mrkdwn blocks.
 *
 * Usage:
 *   # Print the Slack API payload JSON to stdout (no network call)
 *   node scripts/generate-release-slack-payload.mjs --print
 *
 *   # Post to Slack via Web API (requires env vars below)
 *   node scripts/generate-release-slack-payload.mjs --post
 *
 * Environment variables:
 *   PUBLISHED_PACKAGES - forwarded to scripts/generate-release-notes.mjs so the
 *                       payload matches the exact set of packages published.
 *
 *   SLACK_BOT_TOKEN   - Slack Bot User OAuth Token (starts with "xoxb-..."),
 *                      used to call `chat.postMessage`
 *   SLACK_RELEASE_CHANNEL_ID  - Slack Channel ID (e.g. "C0123456789")
 *
 * Example output (when run with `--print`):
 *
 *   {
 *     "channel": "C0123456789",
 *     "text": "New release: workflow@4.0.1-beta.46 (workflow@4.0.1-beta.46)",
 *     "blocks": [
 *       {
 *         "type": "header",
 *         "text": { "type": "plain_text", "text": "New release: workflow@4.0.1-beta.46", "emoji": true }
 *       },
 *       {
 *         "type": "section",
 *         "text": { "type": "mrkdwn", "text": "*Release:* <https://github.com/vercel/workflow/releases/tag/workflow%404.0.1-beta.46|workflow@4.0.1-beta.46>" }
 *       },
 *       {
 *         "type": "section",
 *         "text": { "type": "mrkdwn", "text": "*core@4.0.1-beta.46*\n- [#123](https://github.com/vercel/workflow/pull/123) [`abc1234`](https://github.com/vercel/workflow/commit/abc1234) @someone - Fix thing" }
 *       },
 *       {
 *         "type": "section",
 *         "text": { "type": "mrkdwn", "text": "*cli@4.0.1-beta.46*\n- [#124](https://github.com/vercel/workflow/pull/124) [`def5678`](https://github.com/vercel/workflow/commit/def5678) @someoneelse - Improve other thing" }
 *       }
 *     ]
 *   }
 */

import { spawnSync } from 'node:child_process';

const GITHUB_REPO = 'vercel/workflow';

const SLACK_SECTION_TEXT_LIMIT = 2900; // Slack section text limit is 3000 chars; keep buffer.
const SLACK_BLOCK_LIMIT = 50;
const SLACK_API_URL = 'https://slack.com/api/chat.postMessage';

function runReleaseNotes() {
  const result = spawnSync(
    process.execPath,
    ['scripts/generate-release-notes.mjs'],
    {
      encoding: 'utf-8',
      env: process.env,
    }
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `generate-release-notes.mjs failed (exit ${result.status}):\n${result.stderr || ''}`.trim()
    );
  }

  const stdout = (result.stdout || '').trim();
  if (!stdout) {
    throw new Error('generate-release-notes.mjs produced no output');
  }

  return JSON.parse(stdout);
}

function toSlackMrkdwn(body) {
  // Convert `## heading` to `*heading*` for Slack.
  return body
    .split('\n')
    .map((line) => {
      if (line.startsWith('## ')) return `*${line.slice(3)}*`;
      return line;
    })
    .join('\n')
    .trim();
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

function buildSlackPayload({ tag, title, body }) {
  const releaseUrl = `https://github.com/${GITHUB_REPO}/releases/tag/${encodeURIComponent(tag)}`;
  const mrkdwn = toSlackMrkdwn(body || '');

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `New release: ${title}`, emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Release:* <${releaseUrl}|${tag}>`,
      },
    },
  ];

  if (mrkdwn) {
    const chunks = chunkByLines(mrkdwn, SLACK_SECTION_TEXT_LIMIT);

    for (const chunk of chunks) {
      // Keep a few blocks for header/links/truncation notice.
      if (blocks.length >= SLACK_BLOCK_LIMIT - 1) break;
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: chunk },
      });
    }

    if (chunks.length > 0 && blocks.length >= SLACK_BLOCK_LIMIT - 1) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `_(truncated — see full notes: <${releaseUrl}|${tag}>)_`,
        },
      });
    }
  } else {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `No release notes were generated. See: <${releaseUrl}|${tag}>`,
      },
    });
  }

  return {
    text: `New release: ${title} (${tag})`,
    blocks,
  };
}

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
    // Keep stdout help minimal to avoid polluting CI logs.
    console.log(
      [
        'Usage:',
        '  node scripts/generate-release-slack-payload.mjs --print',
        '  node scripts/generate-release-slack-payload.mjs --post',
        '',
        'Env (for --post): SLACK_BOT_TOKEN, SLACK_RELEASE_CHANNEL_ID',
      ].join('\n')
    );
    return;
  }

  const releaseNotes = runReleaseNotes();
  const content = buildSlackPayload(releaseNotes);

  const channel = process.env.SLACK_RELEASE_CHANNEL_ID;
  const message = { channel, ...content };

  if (wantsPrint) {
    console.log(JSON.stringify(message));
  }

  if (wantsPost) {
    const token = requireEnv('SLACK_BOT_TOKEN');
    const realChannel = requireEnv('SLACK_RELEASE_CHANNEL_ID');
    const result = await postToSlack({
      token,
      message: { ...message, channel: realChannel },
    });

    // Print a tiny confirmation that won't leak secrets.
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

await main();
