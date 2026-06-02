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

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

const INSTALL_PREFIX: Record<PackageManager, string> = {
  pnpm: 'pnpm i',
  npm: 'npm i',
  yarn: 'yarn add',
  bun: 'bun add',
};

export function buildInstallCommand(pm: PackageManager, url: string): string {
  return `${INSTALL_PREFIX[pm]} ${url}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}
