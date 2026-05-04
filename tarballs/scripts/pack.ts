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

export interface TarballFile {
  path: string;
  size: number;
}

export interface PackedPackage {
  name: string;
  escapedName: string;
  version: string;
  description?: string;
  tarballSizeBytes: number;
  unpackedSizeBytes: number;
  fileCount: number;
  files: TarballFile[];
  url: string;
}

export interface BuildContext {
  fullSha: string;
  shortSha: string;
  branch?: string;
  pr?: string;
  repoUrl?: string;
  commitUrl?: string;
  branchUrl?: string;
  prUrl?: string;
  builtAt: string;
}

export interface Catalog {
  build: BuildContext;
  packages: PackedPackage[];
}

const rootDir = fileURLToPath(new URL('../../', import.meta.url));
const packagesDir = path.join(rootDir, 'packages');
const outDir = fileURLToPath(new URL('../public', import.meta.url));

async function main() {
  const sha = await getSha();
  const localBranch = await getLocalBranch();

  await fs.mkdir(outDir, { recursive: true });

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
      continue;
    }

    const originalContent = await fs.readFile(packageJsonPath, 'utf8');
    const packageJson: PackageJson = JSON.parse(originalContent);

    if (packageJson.private) continue;

    packages.push({
      name: packageJson.name,
      dir,
      packageJson,
      originalContent,
    });
  }

  const packageNames = new Set(packages.map((p) => p.name));
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : '';
  const packed: PackedPackage[] = [];

  for (const { name, dir, packageJson, originalContent } of packages) {
    const packageJsonPath = path.join(dir, 'package.json');

    const modifiedPackageJson: PackageJson = JSON.parse(
      JSON.stringify(packageJson)
    );
    const previewVersion = `${packageJson.version}-${sha}`;
    modifiedPackageJson.version = previewVersion;

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

    await fs.writeFile(
      packageJsonPath,
      JSON.stringify(modifiedPackageJson, null, 2)
    );

    try {
      await exec(`pnpm pack --out="${outDir}/%s.tgz"`, { cwd: dir });

      const escapedName = name.replace(/^@(.+)\//, '$1-');
      const tgzPath = path.join(outDir, `${escapedName}.tgz`);
      const stat = await fs.stat(tgzPath);
      const files = await listTarballFiles(tgzPath);
      const unpackedSizeBytes = files.reduce((sum, f) => sum + f.size, 0);

      packed.push({
        name,
        escapedName,
        version: previewVersion,
        description: packageJson.description,
        tarballSizeBytes: stat.size,
        unpackedSizeBytes,
        fileCount: files.length,
        files,
        url: `${baseUrl}/${escapedName}.tgz`,
      });
      console.log(
        `Packed ${name} (${formatBytes(stat.size)} → ${formatBytes(unpackedSizeBytes)} unpacked, ${files.length} files)`
      );
    } finally {
      await fs.writeFile(packageJsonPath, originalContent);
    }
  }

  const catalog: Catalog = {
    build: getBuildContext(sha, localBranch),
    packages: packed,
  };

  await fs.writeFile(
    path.join(outDir, 'catalog.json'),
    JSON.stringify(catalog, null, 2)
  );

  console.log(
    `\nPacked ${packed.length} packages into ${outDir} and wrote catalog.json`
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

/**
 * List the contents of a tarball as `{path, size}` entries by parsing the
 * verbose output of `tar -tvzf`. Each line looks roughly like:
 *
 *   -rw-r--r--  0 root   root      1234 Jan  1 00:00 package/dist/index.js
 *
 * We only care about regular files (lines starting with `-`), so symlinks
 * and directories are filtered out.
 */
async function listTarballFiles(tgzPath: string): Promise<TarballFile[]> {
  const { stdout } = await exec(`tar -tvzf "${tgzPath}"`, {
    maxBuffer: 64 * 1024 * 1024,
  });
  const files: TarballFile[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line || !line.startsWith('-')) continue;
    // Split on whitespace, expect: mode links owner group size date time path
    const parts = line.split(/\s+/);
    if (parts.length < 9) continue;
    const size = Number.parseInt(parts[4] ?? '', 10);
    if (!Number.isFinite(size)) continue;
    // Path may contain spaces — rejoin everything from index 8 onwards.
    const filePath = parts.slice(8).join(' ');
    files.push({ path: filePath, size });
  }
  files.sort((a, b) => b.size - a.size);
  return files;
}

function getBuildContext(sha: string, localBranch?: string): BuildContext {
  const fullSha = process.env.VERCEL_GIT_COMMIT_SHA || sha;
  const shortSha = fullSha.slice(0, 7);
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
    fullSha,
    shortSha,
    branch,
    pr,
    repoUrl,
    commitUrl,
    branchUrl,
    prUrl,
    builtAt: new Date().toISOString(),
  };
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
