import cp from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

const exec = promisify(cp.exec);

interface PackageJson {
  name: string;
  version: string;
  private?: boolean;
  description?: string;
  scripts?: Record<string, string>;
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
const generatedVersionFiles = [
  'src/version.ts',
  'dist/version.js',
  'dist/version.d.ts',
];

interface FileSnapshot {
  path: string;
  content: string;
}

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

    const versionFileSnapshots: FileSnapshot[] = [];

    try {
      await fs.writeFile(
        packageJsonPath,
        JSON.stringify(modifiedPackageJson, null, 2)
      );
      await updateGeneratedVersionFiles(
        dir,
        packageJson,
        previewVersion,
        versionFileSnapshots
      );
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
      await restoreFiles(versionFileSnapshots);
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

async function updateGeneratedVersionFiles(
  packageDir: string,
  packageJson: PackageJson,
  version: string,
  snapshots: FileSnapshot[]
): Promise<void> {
  if (!usesGeneratedVersionFile(packageJson)) {
    return;
  }

  for (const relativePath of generatedVersionFiles) {
    const filePath = path.join(packageDir, relativePath);
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }

    snapshots.push({ path: filePath, content });
    await fs.writeFile(filePath, renderGeneratedVersionFile(filePath, version));
  }
}

function usesGeneratedVersionFile(packageJson: PackageJson): boolean {
  return Object.values(packageJson.scripts ?? {}).some(
    (script) =>
      script.includes('genversion') && script.includes('src/version.ts')
  );
}

function renderGeneratedVersionFile(filePath: string, version: string): string {
  if (filePath.endsWith('.d.ts')) {
    return `export declare const version: ${JSON.stringify(version)};\n`;
  }
  return `export const version = ${JSON.stringify(version)};\n`;
}

async function restoreFiles(snapshots: FileSnapshot[]): Promise<void> {
  for (const snapshot of snapshots.slice().reverse()) {
    await fs.writeFile(snapshot.path, snapshot.content);
  }
}

/**
 * List regular files inside a `.tgz` tarball, returning `{path, size}` for
 * each entry. Implemented as an in-process tar reader so the result is
 * identical on macOS (BSD tar) and Linux (GNU tar) — `tar -tvzf` formats
 * its verbose output differently on each, and parsing it is fragile.
 *
 * We unzip the whole tarball into memory (npm pack outputs are small) and
 * walk 512-byte blocks. Each entry is one 512-byte ustar header followed
 * by the file content rounded up to 512 bytes. We only emit regular files
 * (typeflag `0` or NUL); directories, symlinks, and pax/long-name
 * extension entries are consumed but not emitted.
 */
async function listTarballFiles(tgzPath: string): Promise<TarballFile[]> {
  const compressed = await fs.readFile(tgzPath);
  const buf = zlib.gunzipSync(compressed);
  const files: TarballFile[] = [];
  let offset = 0;
  let pendingLongName: string | undefined;

  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    // The end of an archive is marked by two consecutive zero blocks.
    if (header.every((b) => b === 0)) break;

    const name = readNullTerminatedString(header, 0, 100);
    const sizeOctal = readNullTerminatedString(header, 124, 12).trim();
    const size = sizeOctal ? Number.parseInt(sizeOctal, 8) : 0;
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const prefix = readNullTerminatedString(header, 345, 155);
    const contentBlocks = Math.ceil(size / 512);

    offset += 512;

    if (typeflag === 'L') {
      // GNU long-name entry: the next `size` bytes are the path of the
      // following entry. Read it and stash for the next iteration.
      pendingLongName = buf
        .subarray(offset, offset + size)
        .toString('utf8')
        .replace(/\0+$/, '');
      offset += contentBlocks * 512;
      continue;
    }

    if (typeflag === 'x' || typeflag === 'g') {
      // pax extended / global headers — skip.
      offset += contentBlocks * 512;
      continue;
    }

    const fullName = pendingLongName ?? (prefix ? `${prefix}/${name}` : name);
    pendingLongName = undefined;

    // typeflag '0' or NUL = regular file.
    if (typeflag === '0' || typeflag === '\0') {
      if (fullName) files.push({ path: fullName, size });
    }

    offset += contentBlocks * 512;
  }

  files.sort((a, b) => b.size - a.size);
  return files;
}

function readNullTerminatedString(
  buf: Buffer,
  offset: number,
  len: number
): string {
  const slice = buf.subarray(offset, offset + len);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? len : end).toString('utf8');
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
