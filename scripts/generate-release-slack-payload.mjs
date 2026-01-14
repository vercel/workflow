#!/usr/bin/env node
/**
 * Generate a Slack Incoming Webhook payload for the latest Workflow release.
 *
 * It reuses the existing release-note generator (scripts/generate-release-notes.mjs)
 * and converts its Markdown-ish body into Slack mrkdwn blocks.
 *
 * Usage:
 *   node scripts/generate-release-slack-payload.mjs
 *
 * Environment variables:
 *   PUBLISHED_PACKAGES - forwarded to scripts/generate-release-notes.mjs so the
 *                       payload matches the exact set of packages published.
 */

import { spawnSync } from 'node:child_process';

const GITHUB_REPO = 'vercel/workflow';

const SLACK_SECTION_TEXT_LIMIT = 2900; // Slack section text limit is 3000 chars; keep buffer.
const SLACK_BLOCK_LIMIT = 50;

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

const releaseNotes = runReleaseNotes();
const payload = buildSlackPayload(releaseNotes);
console.log(JSON.stringify(payload));
