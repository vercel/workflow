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
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const rootDir = fileURLToPath(new URL('../../', import.meta.url));
const packagesDir = path.join(rootDir, 'packages');
const outDir = fileURLToPath(new URL('../public', import.meta.url));

async function main() {
  const sha = await getSha();

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

  for (const { name, dir, packageJson, originalContent } of packages) {
    const packageJsonPath = path.join(dir, 'package.json');

    // Create modified package.json with preview version
    const modifiedPackageJson: PackageJson = JSON.parse(
      JSON.stringify(packageJson)
    );
    modifiedPackageJson.version += `-${sha}`;

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
      console.log(`Packed ${name}`);
    } finally {
      // Always restore original package.json (preserves trailing newline /
      // exact byte content of the source file)
      await fs.writeFile(packageJsonPath, originalContent);
    }
  }

  await writeIndexHtml(packages.map((p) => p.name).sort(), sha);

  console.log(
    `\nSuccessfully packed ${packages.length} preview packages to ${outDir}`
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

async function writeIndexHtml(
  packageNames: string[],
  sha: string
): Promise<void> {
  // Use the actual deployment URL when running on Vercel, otherwise build
  // commands relative to the page so they remain useful when the file is
  // viewed via a non-Vercel host or directly from disk.
  const baseUrlExpr = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : '';

  const rows = packageNames
    .map((name) => {
      const escapedName = name.replace(/^@(.+)\//, '$1-');
      const installCmd = `pnpm i ${baseUrlExpr}/${escapedName}.tgz`;
      return `        <tr>
          <td><code>${escapeHtml(name)}</code></td>
          <td>
            <code id="cmd-${escapeHtml(escapedName)}">${escapeHtml(installCmd)}</code>
            <button class="copy" data-target="cmd-${escapeHtml(escapedName)}" type="button">copy</button>
          </td>
        </tr>`;
    })
    .join('\n');

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Workflow SDK preview tarballs</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        max-width: 960px;
        margin: 2rem auto;
        padding: 0 1rem;
        line-height: 1.5;
      }
      h1 { margin-bottom: 0.25rem; }
      .meta { color: #666; font-size: 0.9rem; margin-bottom: 1.5rem; }
      table { border-collapse: collapse; width: 100%; }
      th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #ddd; vertical-align: top; }
      th { font-weight: 600; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; color: #555; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9rem; }
      button.copy {
        margin-left: 0.5rem; padding: 0.1rem 0.5rem; font-size: 0.75rem;
        border: 1px solid #888; background: transparent; cursor: pointer; border-radius: 3px;
      }
      button.copy:hover { background: rgba(0,0,0,0.05); }
    </style>
  </head>
  <body>
    <h1>Workflow SDK preview tarballs</h1>
    <p class="meta">Built from <code>${escapeHtml(sha)}</code>. Drop one of these install commands into a project to test pre-release builds.</p>
    <table>
      <thead><tr><th>Package</th><th>Install</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
    <script>
      for (const button of document.querySelectorAll('button.copy')) {
        button.addEventListener('click', () => {
          const target = document.getElementById(button.dataset.target);
          if (!target) return;
          navigator.clipboard.writeText(target.textContent || '').then(() => {
            const original = button.textContent;
            button.textContent = 'copied';
            setTimeout(() => { button.textContent = original; }, 1500);
          });
        });
      }
    </script>
  </body>
</html>
`;

  await fs.writeFile(path.join(outDir, 'index.html'), html);
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
