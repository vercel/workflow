import cp from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(cp.exec);

interface PackageJson {
  name: string;
  version: string;
  private?: boolean;
  description?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface PackedPackage {
  name: string;
  escapedName: string;
  version: string;
  description?: string;
  sizeBytes: number;
}

const rootDir = fileURLToPath(new URL('../../', import.meta.url));
const packagesDir = path.join(rootDir, 'packages');
const outDir = fileURLToPath(new URL('../public', import.meta.url));

const FEATURED_PACKAGE = 'workflow';

async function main() {
  const sha = await getSha();
  const localBranch = await getLocalBranch();

  // Ensure output directory exists
  await fs.mkdir(outDir, { recursive: true });

  // Scan the packages directory for all packages
  const packageDirs = await fs.readdir(packagesDir);
  const packages: Array<{
    name: string;
    dir: string;
    packageJson: PackageJson;
    originalContent: string;
  }> = [];

  for (const packageDir of packageDirs) {
    const dir = path.join(packagesDir, packageDir);
    const packageJsonPath = path.join(dir, 'package.json');

    try {
      const stat = await fs.stat(packageJsonPath);
      if (!stat.isFile()) continue;
    } catch {
      continue; // Skip directories without package.json
    }

    const originalContent = await fs.readFile(packageJsonPath, 'utf8');
    const packageJson: PackageJson = JSON.parse(originalContent);

    // Skip private packages
    if (packageJson.private) continue;

    packages.push({
      name: packageJson.name,
      dir,
      packageJson,
      originalContent,
    });
  }

  // Create a set of all package names for dependency resolution
  const packageNames = new Set(packages.map((p) => p.name));
  const packed: PackedPackage[] = [];

  for (const { name, dir, packageJson, originalContent } of packages) {
    const packageJsonPath = path.join(dir, 'package.json');

    // Create modified package.json with preview version
    const modifiedPackageJson: PackageJson = JSON.parse(
      JSON.stringify(packageJson)
    );
    const previewVersion = `${packageJson.version}-${sha}`;
    modifiedPackageJson.version = previewVersion;

    // Update workspace dependencies to use preview tarball URLs
    const updateDeps = (deps: Record<string, string> | undefined) => {
      if (!deps) return;
      for (const depName of Object.keys(deps)) {
        if (packageNames.has(depName)) {
          const escapedName = depName.replace(/^@(.+)\//, '$1-');
          deps[depName] =
            `https://${process.env.VERCEL_URL}/${escapedName}.tgz`;
        }
      }
    };

    updateDeps(modifiedPackageJson.dependencies);
    updateDeps(modifiedPackageJson.devDependencies);
    updateDeps(modifiedPackageJson.peerDependencies);

    // Write modified package.json
    await fs.writeFile(
      packageJsonPath,
      JSON.stringify(modifiedPackageJson, null, 2)
    );

    try {
      // Pack the package
      await exec(`pnpm pack --out="${outDir}/%s.tgz"`, { cwd: dir });

      const escapedName = name.replace(/^@(.+)\//, '$1-');
      const tgzPath = path.join(outDir, `${escapedName}.tgz`);
      const stat = await fs.stat(tgzPath);

      packed.push({
        name,
        escapedName,
        version: previewVersion,
        description: packageJson.description,
        sizeBytes: stat.size,
      });
      console.log(`Packed ${name} (${formatBytes(stat.size)})`);
    } finally {
      // Always restore original package.json (preserves trailing newline /
      // exact byte content of the source file)
      await fs.writeFile(packageJsonPath, originalContent);
    }
  }

  await writeIndexHtml(packed, sha, localBranch);

  console.log(
    `\nSuccessfully packed ${packed.length} preview packages to ${outDir}`
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

interface BuildContext {
  sha: string;
  shortSha: string;
  branch?: string;
  pr?: string;
  repoUrl?: string;
  commitUrl?: string;
  prUrl?: string;
  branchUrl?: string;
  builtAt: string;
}

function getBuildContext(sha: string, localBranch?: string): BuildContext {
  const fullSha = process.env.VERCEL_GIT_COMMIT_SHA || sha;
  const shortSha = (process.env.VERCEL_GIT_COMMIT_SHA || sha).slice(0, 7);
  const branch = process.env.VERCEL_GIT_COMMIT_REF || localBranch;
  const pr = process.env.VERCEL_GIT_PULL_REQUEST_ID;
  const owner = process.env.VERCEL_GIT_REPO_OWNER;
  const slug = process.env.VERCEL_GIT_REPO_SLUG;
  const provider = process.env.VERCEL_GIT_PROVIDER;

  let repoUrl: string | undefined;
  let commitUrl: string | undefined;
  let prUrl: string | undefined;
  let branchUrl: string | undefined;

  if (owner && slug && (!provider || provider === 'github')) {
    repoUrl = `https://github.com/${owner}/${slug}`;
    commitUrl = `${repoUrl}/commit/${fullSha}`;
    if (branch) branchUrl = `${repoUrl}/tree/${branch}`;
    if (pr) prUrl = `${repoUrl}/pull/${pr}`;
  }

  return {
    sha: fullSha,
    shortSha,
    branch,
    pr,
    repoUrl,
    commitUrl,
    prUrl,
    branchUrl,
    builtAt: new Date().toISOString(),
  };
}

async function writeIndexHtml(
  packages: PackedPackage[],
  sha: string,
  localBranch?: string
): Promise<void> {
  // Use the actual deployment URL when running on Vercel, otherwise build
  // commands relative to the page so they remain useful when the file is
  // viewed via a non-Vercel host or directly from disk.
  const baseUrlExpr = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : '';

  const ctx = getBuildContext(sha, localBranch);

  // Featured (workflow) first, then the rest sorted alphabetically
  const featured = packages.find((p) => p.name === FEATURED_PACKAGE);
  const others = packages
    .filter((p) => p.name !== FEATURED_PACKAGE)
    .sort((a, b) => a.name.localeCompare(b.name));

  const totalSize = packages.reduce((sum, p) => sum + p.sizeBytes, 0);

  // Build a JSON catalog the page-side script can use to switch package managers.
  const catalog = packages.map((p) => ({
    name: p.name,
    escapedName: p.escapedName,
    version: p.version,
    description: p.description,
    sizeBytes: p.sizeBytes,
    sizeLabel: formatBytes(p.sizeBytes),
    url: `${baseUrlExpr}/${p.escapedName}.tgz`,
  }));

  const featuredHtml = featured ? renderFeatured(featured, baseUrlExpr) : '';
  const rowsHtml = others.map((p) => renderRow(p, baseUrlExpr)).join('\n');

  const metaBits: string[] = [];
  if (ctx.commitUrl) {
    metaBits.push(
      `<a class="chip" href="${escapeHtml(ctx.commitUrl)}" target="_blank" rel="noopener">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M11.93 8.5a4 4 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4 4 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5Zm-1.43-.75a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"/></svg>
        <code>${escapeHtml(ctx.shortSha)}</code>
      </a>`
    );
  } else {
    metaBits.push(
      `<span class="chip"><code>${escapeHtml(ctx.shortSha)}</code></span>`
    );
  }
  if (ctx.branch) {
    const branchInner = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v.628a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v2.146A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/></svg> ${escapeHtml(ctx.branch)}`;
    metaBits.push(
      ctx.branchUrl
        ? `<a class="chip" href="${escapeHtml(ctx.branchUrl)}" target="_blank" rel="noopener">${branchInner}</a>`
        : `<span class="chip">${branchInner}</span>`
    );
  }
  if (ctx.pr && ctx.prUrl) {
    metaBits.push(
      `<a class="chip" href="${escapeHtml(ctx.prUrl)}" target="_blank" rel="noopener">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854v1.523h.5A2.5 2.5 0 0 1 13 4.877v5.252a2.251 2.251 0 1 1-1.5 0V4.877a1 1 0 0 0-1-1H10v1.522a.25.25 0 0 1-.427.177L7.177 3.18a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"/></svg>
        PR #${escapeHtml(ctx.pr)}
      </a>`
    );
  }
  metaBits.push(
    `<span class="chip"><time datetime="${escapeHtml(ctx.builtAt)}">${escapeHtml(ctx.builtAt)}</time></span>`
  );
  metaBits.push(
    `<span class="chip">${escapeHtml(String(packages.length))} packages · ${escapeHtml(formatBytes(totalSize))}</span>`
  );

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Workflow SDK preview tarballs</title>
    <meta name="description" content="Preview tarballs for the Workflow SDK, built from ${escapeHtml(ctx.shortSha)}." />
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='black'/%3E%3Cpath d='M16 8 L24 24 L8 24 Z' fill='white'/%3E%3C/svg%3E" />
    <style>
      :root {
        color-scheme: light dark;
        --bg: #ffffff;
        --bg-elevated: #fafafa;
        --bg-hover: #f5f5f5;
        --fg: #0a0a0a;
        --fg-muted: #666666;
        --fg-subtle: #999999;
        --border: #eaeaea;
        --border-strong: #d4d4d4;
        --accent: #0070f3;
        --accent-fg: #ffffff;
        --code-bg: #f5f5f5;
        --shadow: 0 1px 2px rgba(0, 0, 0, 0.04), 0 4px 12px rgba(0, 0, 0, 0.04);
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #0a0a0a;
          --bg-elevated: #111111;
          --bg-hover: #1a1a1a;
          --fg: #ededed;
          --fg-muted: #a1a1a1;
          --fg-subtle: #666666;
          --border: #1f1f1f;
          --border-strong: #2a2a2a;
          --accent: #3291ff;
          --accent-fg: #ffffff;
          --code-bg: #161616;
          --shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 4px 12px rgba(0, 0, 0, 0.3);
        }
      }
      * { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; }
      body {
        font-family: 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        background: var(--bg);
        color: var(--fg);
        line-height: 1.5;
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
      }
      .container { max-width: 1040px; margin: 0 auto; padding: 2.5rem 1.5rem 5rem; }
      header.page { margin-bottom: 2.5rem; }
      h1 {
        font-size: 2rem;
        font-weight: 600;
        letter-spacing: -0.02em;
        margin: 0 0 0.5rem;
      }
      .lede {
        color: var(--fg-muted);
        font-size: 1rem;
        margin: 0 0 1.25rem;
        max-width: 60ch;
      }
      .meta-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        align-items: center;
      }
      .chip {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        padding: 0.3rem 0.65rem;
        background: var(--bg-elevated);
        border: 1px solid var(--border);
        border-radius: 999px;
        font-size: 0.8rem;
        color: var(--fg-muted);
        text-decoration: none;
        transition: background 0.15s, border-color 0.15s, color 0.15s;
      }
      a.chip:hover { background: var(--bg-hover); border-color: var(--border-strong); color: var(--fg); }
      .chip code { background: transparent; padding: 0; font-size: 0.8rem; }

      details.about {
        margin: 1.5rem 0 0;
        background: var(--bg-elevated);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 0.75rem 1rem;
      }
      details.about summary {
        cursor: pointer;
        font-weight: 500;
        font-size: 0.9rem;
        list-style: none;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        color: var(--fg);
      }
      details.about summary::-webkit-details-marker { display: none; }
      details.about summary::before {
        content: '▸';
        font-size: 0.7rem;
        color: var(--fg-muted);
        transition: transform 0.15s;
      }
      details.about[open] summary::before { transform: rotate(90deg); }
      details.about p { margin: 0.75rem 0 0; color: var(--fg-muted); font-size: 0.9rem; }
      details.about p + p { margin-top: 0.5rem; }
      details.about code { background: var(--code-bg); padding: 0.1rem 0.35rem; border-radius: 4px; font-size: 0.85rem; }

      .controls {
        display: flex;
        gap: 1rem;
        align-items: center;
        margin: 2rem 0 1rem;
        flex-wrap: wrap;
      }
      .pm-tabs {
        display: inline-flex;
        background: var(--bg-elevated);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 3px;
        gap: 2px;
      }
      .pm-tab {
        appearance: none;
        background: transparent;
        border: 0;
        padding: 0.4rem 0.85rem;
        font-family: inherit;
        font-size: 0.85rem;
        font-weight: 500;
        color: var(--fg-muted);
        border-radius: 6px;
        cursor: pointer;
        transition: background 0.15s, color 0.15s;
      }
      .pm-tab:hover { color: var(--fg); }
      .pm-tab[aria-selected='true'] {
        background: var(--bg);
        color: var(--fg);
        box-shadow: var(--shadow);
      }
      @media (prefers-color-scheme: dark) {
        .pm-tab[aria-selected='true'] { background: var(--bg-hover); }
      }
      .search {
        flex: 1;
        min-width: 200px;
        position: relative;
      }
      .search input {
        width: 100%;
        padding: 0.55rem 0.85rem 0.55rem 2.25rem;
        font-family: inherit;
        font-size: 0.9rem;
        background: var(--bg-elevated);
        border: 1px solid var(--border);
        color: var(--fg);
        border-radius: 8px;
        outline: none;
        transition: border-color 0.15s, background 0.15s;
      }
      .search input:focus { border-color: var(--accent); background: var(--bg); }
      .search svg {
        position: absolute;
        left: 0.75rem;
        top: 50%;
        transform: translateY(-50%);
        color: var(--fg-subtle);
        pointer-events: none;
      }

      /* Featured card */
      .featured {
        background: var(--bg-elevated);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 1.5rem;
        margin-bottom: 2.5rem;
        position: relative;
        overflow: hidden;
      }
      .featured::before {
        content: '';
        position: absolute;
        inset: 0;
        background: radial-gradient(circle at top right, rgba(0, 112, 243, 0.06), transparent 60%);
        pointer-events: none;
      }
      .featured-header {
        display: flex;
        align-items: baseline;
        flex-wrap: wrap;
        gap: 0.75rem;
        margin-bottom: 0.5rem;
      }
      .featured-badge {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        padding: 0.2rem 0.55rem;
        font-size: 0.7rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        background: var(--accent);
        color: var(--accent-fg);
        border-radius: 4px;
      }
      .featured-name {
        font-size: 1.5rem;
        font-weight: 600;
        font-family: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
        letter-spacing: -0.01em;
      }
      .featured-version, .featured-size {
        color: var(--fg-muted);
        font-size: 0.85rem;
        font-family: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      .featured-desc {
        color: var(--fg-muted);
        font-size: 0.95rem;
        margin: 0 0 1.25rem;
        position: relative;
      }
      .install-block {
        display: flex;
        gap: 0.5rem;
        align-items: stretch;
        position: relative;
      }
      .install-cmd {
        flex: 1;
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 0.75rem 1rem;
        font-family: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.9rem;
        overflow-x: auto;
        white-space: nowrap;
        color: var(--fg);
      }
      .install-cmd::-webkit-scrollbar { height: 4px; }
      .install-cmd::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 2px; }
      .copy-btn, .download-btn {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        padding: 0 1rem;
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 8px;
        font-family: inherit;
        font-size: 0.85rem;
        font-weight: 500;
        color: var(--fg);
        cursor: pointer;
        text-decoration: none;
        transition: background 0.15s, border-color 0.15s;
      }
      .copy-btn:hover, .download-btn:hover { background: var(--bg-hover); border-color: var(--border-strong); }
      .copy-btn[data-copied='true'] { color: #16a34a; border-color: #16a34a; }
      @media (prefers-color-scheme: dark) {
        .copy-btn[data-copied='true'] { color: #4ade80; border-color: #4ade80; }
      }

      /* Other packages section */
      .section-title {
        font-size: 0.85rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--fg-muted);
        margin: 0 0 0.75rem;
      }
      .pkg-list {
        border: 1px solid var(--border);
        border-radius: 12px;
        overflow: hidden;
        background: var(--bg-elevated);
      }
      .pkg-row {
        display: grid;
        grid-template-columns: minmax(0, 1.2fr) minmax(0, 2fr) auto;
        align-items: center;
        gap: 1rem;
        padding: 0.85rem 1.25rem;
        border-bottom: 1px solid var(--border);
        transition: background 0.1s;
      }
      .pkg-row:last-child { border-bottom: 0; }
      .pkg-row:hover { background: var(--bg-hover); }
      .pkg-row[hidden] { display: none; }
      .pkg-info { min-width: 0; }
      .pkg-name {
        font-family: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.9rem;
        font-weight: 500;
        color: var(--fg);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .pkg-meta {
        font-size: 0.75rem;
        color: var(--fg-subtle);
        font-family: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
        margin-top: 0.15rem;
      }
      .pkg-cmd {
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 0.45rem 0.7rem;
        font-family: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.8rem;
        overflow-x: auto;
        white-space: nowrap;
        color: var(--fg);
        min-width: 0;
      }
      .pkg-actions {
        display: flex;
        gap: 0.4rem;
      }
      .icon-btn {
        appearance: none;
        background: transparent;
        border: 1px solid var(--border);
        border-radius: 6px;
        width: 32px;
        height: 32px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: var(--fg-muted);
        cursor: pointer;
        transition: background 0.15s, color 0.15s, border-color 0.15s;
        text-decoration: none;
      }
      .icon-btn:hover { background: var(--bg-hover); color: var(--fg); border-color: var(--border-strong); }
      .icon-btn[data-copied='true'] { color: #16a34a; border-color: #16a34a; }
      @media (prefers-color-scheme: dark) {
        .icon-btn[data-copied='true'] { color: #4ade80; border-color: #4ade80; }
      }

      .empty {
        padding: 2rem 1.25rem;
        text-align: center;
        color: var(--fg-muted);
        font-size: 0.9rem;
      }

      footer.page {
        margin-top: 3rem;
        padding-top: 1.5rem;
        border-top: 1px solid var(--border);
        font-size: 0.8rem;
        color: var(--fg-subtle);
      }

      @media (max-width: 720px) {
        .container { padding: 1.5rem 1rem 3rem; }
        h1 { font-size: 1.5rem; }
        .featured-name { font-size: 1.2rem; }
        .install-block { flex-direction: column; }
        .copy-btn, .download-btn { padding: 0.55rem 1rem; justify-content: center; }
        .pkg-row {
          grid-template-columns: 1fr;
          gap: 0.5rem;
        }
        .pkg-actions { justify-content: flex-end; }
      }
    </style>
  </head>
  <body>
    <div class="container">
      <header class="page">
        <h1>Workflow SDK preview tarballs</h1>
        <p class="lede">Pre-release builds of every public package, packed straight from the latest commit. Drop one into a project to test before publish.</p>
        <div class="meta-chips">
          ${metaBits.join('\n          ')}
        </div>
        <details class="about">
          <summary>What is this?</summary>
          <p>Each commit on the <code>workflow</code> repo produces a deployment that builds and serves a tarball for every public package under <code>packages/*</code>. Versions are rewritten to <code>&lt;version&gt;-&lt;sha&gt;</code> and workspace dependencies are rewritten to point at sibling tarballs on this same deployment, so installing a single tarball pulls in the rest transitively.</p>
          <p>Use these to verify a fix in a downstream project before publishing to npm. Every tarball URL is a stable, immutable artifact tied to a specific commit.</p>
        </details>
      </header>

      ${featuredHtml}

      <h2 class="section-title">Other packages</h2>
      <div class="controls">
        <div class="pm-tabs" role="tablist" aria-label="Package manager">
          <button class="pm-tab" role="tab" data-pm="pnpm" aria-selected="true">pnpm</button>
          <button class="pm-tab" role="tab" data-pm="npm" aria-selected="false">npm</button>
          <button class="pm-tab" role="tab" data-pm="yarn" aria-selected="false">yarn</button>
          <button class="pm-tab" role="tab" data-pm="bun" aria-selected="false">bun</button>
        </div>
        <label class="search">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Zm-.82 4.74a6 6 0 1 1 1.06-1.06l3.04 3.04a.75.75 0 1 1-1.06 1.06l-3.04-3.04Z"/></svg>
          <input type="search" id="search" placeholder="Filter packages…" autocomplete="off" />
        </label>
      </div>
      <div class="pkg-list" id="pkg-list">
${rowsHtml}
        <div class="empty" id="empty" hidden>No packages match that filter.</div>
      </div>

      <footer class="page">
        Built ${ctx.commitUrl ? `from <a href="${escapeHtml(ctx.commitUrl)}" target="_blank" rel="noopener">${escapeHtml(ctx.shortSha)}</a>` : `from <code>${escapeHtml(ctx.shortSha)}</code>`} · ${escapeHtml(packages.length.toString())} packages totaling ${escapeHtml(formatBytes(totalSize))}
      </footer>
    </div>
    <script id="catalog" type="application/json">${escapeHtml(JSON.stringify(catalog))}</script>
    <script>
      (function () {
        const catalog = JSON.parse(document.getElementById('catalog').textContent);
        const byEscaped = new Map(catalog.map((p) => [p.escapedName, p]));
        const installPrefix = { pnpm: 'pnpm i', npm: 'npm i', yarn: 'yarn add', bun: 'bun add' };
        let activePm = 'pnpm';

        function buildCmd(pm, url) { return installPrefix[pm] + ' ' + url; }

        function applyPm(pm) {
          activePm = pm;
          document.querySelectorAll('.pm-tab').forEach((tab) => {
            tab.setAttribute('aria-selected', String(tab.dataset.pm === pm));
          });
          document.querySelectorAll('[data-install-cmd]').forEach((el) => {
            const escaped = el.dataset.installCmd;
            const pkg = byEscaped.get(escaped);
            if (pkg) el.textContent = buildCmd(pm, pkg.url);
          });
        }

        document.querySelectorAll('.pm-tab').forEach((tab) => {
          tab.addEventListener('click', () => applyPm(tab.dataset.pm));
        });

        async function copyToClipboard(text, button) {
          try {
            await navigator.clipboard.writeText(text);
          } catch {
            const ta = document.createElement('textarea');
            ta.value = text; document.body.appendChild(ta); ta.select();
            try { document.execCommand('copy'); } finally { ta.remove(); }
          }
          if (!button) return;
          const original = button.dataset.label || button.textContent;
          button.dataset.label = original;
          button.dataset.copied = 'true';
          const labelEl = button.querySelector('.copy-label');
          if (labelEl) labelEl.textContent = 'Copied';
          setTimeout(() => {
            button.dataset.copied = 'false';
            if (labelEl) labelEl.textContent = original;
          }, 1500);
        }

        document.addEventListener('click', (e) => {
          const btn = e.target.closest('[data-copy-target]');
          if (!btn) return;
          const targetEl = document.getElementById(btn.dataset.copyTarget);
          if (!targetEl) return;
          copyToClipboard(targetEl.textContent || '', btn);
        });

        const search = document.getElementById('search');
        const rows = Array.from(document.querySelectorAll('.pkg-row'));
        const empty = document.getElementById('empty');
        function applyFilter() {
          const q = search.value.trim().toLowerCase();
          let visible = 0;
          rows.forEach((row) => {
            const name = (row.dataset.name || '').toLowerCase();
            const match = !q || name.includes(q);
            row.hidden = !match;
            if (match) visible++;
          });
          empty.hidden = visible !== 0;
        }
        search.addEventListener('input', applyFilter);

        // Keyboard shortcut: '/' focuses search
        document.addEventListener('keydown', (e) => {
          if (e.key === '/' && document.activeElement !== search) {
            e.preventDefault();
            search.focus();
            search.select();
          }
        });
      })();
    </script>
  </body>
</html>
`;

  await fs.writeFile(path.join(outDir, 'index.html'), html);
}

function renderFeatured(pkg: PackedPackage, baseUrl: string): string {
  const url = `${baseUrl}/${pkg.escapedName}.tgz`;
  const cmd = `pnpm i ${url}`;
  return `<section class="featured">
        <div class="featured-header">
          <span class="featured-badge">Main package</span>
          <span class="featured-name">${escapeHtml(pkg.name)}</span>
          <span class="featured-version">v${escapeHtml(pkg.version)}</span>
          <span class="featured-size">· ${escapeHtml(formatBytes(pkg.sizeBytes))}</span>
        </div>
        ${pkg.description ? `<p class="featured-desc">${escapeHtml(pkg.description)}</p>` : ''}
        <div class="install-block">
          <code class="install-cmd" id="featured-cmd" data-install-cmd="${escapeHtml(pkg.escapedName)}">${escapeHtml(cmd)}</code>
          <button type="button" class="copy-btn" data-copy-target="featured-cmd" aria-label="Copy install command">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path fill="currentColor" d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>
            <span class="copy-label">Copy</span>
          </button>
          <a class="download-btn" href="${escapeHtml(url)}" download aria-label="Download tarball">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14Z"/><path fill="currentColor" d="M7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.969a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 6.78a.75.75 0 0 1 1.06-1.06l1.97 1.969Z"/></svg>
            <span>Download</span>
          </a>
        </div>
      </section>`;
}

function renderRow(pkg: PackedPackage, baseUrl: string): string {
  const url = `${baseUrl}/${pkg.escapedName}.tgz`;
  const cmd = `pnpm i ${url}`;
  const cmdId = `cmd-${pkg.escapedName}`;
  return `        <div class="pkg-row" data-name="${escapeHtml(pkg.name)}">
          <div class="pkg-info">
            <div class="pkg-name">${escapeHtml(pkg.name)}</div>
            <div class="pkg-meta">v${escapeHtml(pkg.version)} · ${escapeHtml(formatBytes(pkg.sizeBytes))}</div>
          </div>
          <code class="pkg-cmd" id="${escapeHtml(cmdId)}" data-install-cmd="${escapeHtml(pkg.escapedName)}">${escapeHtml(cmd)}</code>
          <div class="pkg-actions">
            <button type="button" class="icon-btn" data-copy-target="${escapeHtml(cmdId)}" aria-label="Copy install command for ${escapeHtml(pkg.name)}">
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path fill="currentColor" d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>
            </button>
            <a class="icon-btn" href="${escapeHtml(url)}" download aria-label="Download tarball for ${escapeHtml(pkg.name)}">
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14Z"/><path fill="currentColor" d="M7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.969a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 6.78a.75.75 0 0 1 1.06-1.06l1.97 1.969Z"/></svg>
            </a>
          </div>
        </div>`;
}

async function getLocalBranch(): Promise<string | undefined> {
  try {
    const { stdout } = await exec('git rev-parse --abbrev-ref HEAD', {
      cwd: rootDir,
    });
    const branch = stdout.trim();
    return branch && branch !== 'HEAD' ? branch : undefined;
  } catch {
    return undefined;
  }
}

async function getSha(): Promise<string> {
  try {
    const { stdout } = await exec('git rev-parse --short HEAD', {
      cwd: rootDir,
    });
    return stdout.trim();
  } catch (error) {
    console.error('Failed to get git SHA:', error);
    console.log('Using "local" as the SHA.');
    return 'local';
  }
}

main().catch((err) => {
  console.error('Error running pack:', err);
  process.exit(1);
});
