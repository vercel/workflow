import { randomBytes } from 'node:crypto';
import {
  access,
  constants,
  mkdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { debugLog, globalSingleton } from '@workflow/utils';

/** Package name - hardcoded since it doesn't change */
const PACKAGE_NAME = '@workflow/world-local';

interface PackageInfo {
  name: string;
  version: string;
}

// On `globalThis` rather than at module scope so several copies of this file
// in one process share the resolved manifest (see `globalSingleton`).
const packageInfo = globalSingleton(
  '@workflow/world-local//packageInfo',
  1,
  () => ({ cached: null as PackageInfo | null })
);

/**
 * Get the directory path for this module.
 * Works in ESM and falls back to a constant in CJS contexts (which shouldn't happen)
 */
function getModuleDir(): string | null {
  // In bundled CJS contexts, import.meta.url may be undefined or empty
  if (typeof import.meta.url === 'string' && import.meta.url) {
    return path.dirname(fileURLToPath(import.meta.url));
  }
  return null;
}

/**
 * Returns the package name and version from package.json.
 * The result is cached after the first read.
 *
 * In bundled contexts where package.json cannot be read,
 * returns 'bundled' as the version.
 */
export async function getPackageInfo(): Promise<PackageInfo> {
  if (packageInfo.cached) {
    return packageInfo.cached;
  }

  const moduleDir = getModuleDir();
  if (moduleDir) {
    try {
      const content = await readFile(
        path.join(moduleDir, '../package.json'),
        'utf-8'
      );
      packageInfo.cached = JSON.parse(content) as PackageInfo;
      return packageInfo.cached;
    } catch {
      // Fall through to bundled fallback
    }
  }

  // Bundled context - package.json not accessible
  packageInfo.cached = {
    name: PACKAGE_NAME,
    version: 'bundled',
  };
  return packageInfo.cached;
}

/** Filename for storing version information in the data directory */
const VERSION_FILENAME = 'version.txt';

/**
 * Represents a parsed semantic version with optional prerelease tag.
 */
export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
  raw: string;
}

/**
 * Error thrown when the data directory cannot be accessed or created.
 */
export class DataDirAccessError extends Error {
  readonly dataDir: string;
  readonly code?: string;

  constructor(message: string, dataDir: string, code?: string) {
    super(message);
    this.name = 'DataDirAccessError';
    this.dataDir = dataDir;
    this.code = code;
  }
}

/**
 * Error thrown when data directory version is incompatible.
 */
export class DataDirVersionError extends Error {
  readonly oldVersion: ParsedVersion;
  readonly newVersion: ParsedVersion;
  readonly suggestedVersion?: string;

  constructor(
    message: string,
    oldVersion: ParsedVersion,
    newVersion: ParsedVersion,
    suggestedVersion?: string
  ) {
    super(message);
    this.name = 'DataDirVersionError';
    this.oldVersion = oldVersion;
    this.newVersion = newVersion;
    this.suggestedVersion = suggestedVersion;
  }
}

/**
 * Parses a version string into its components.
 *
 * @param versionString - Version string like "4.0.1" or "4.0.1-beta.20"
 * @returns Parsed version object with major, minor, patch, and optional prerelease
 */
export function parseVersion(versionString: string): ParsedVersion {
  // Match: major.minor.patch with optional prerelease
  const match = versionString.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);

  if (!match) {
    throw new Error(`Invalid version string: "${versionString}"`);
  }

  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4],
    raw: versionString,
  };
}

/**
 * Formats a parsed version back to a string.
 */
export function formatVersion(version: ParsedVersion): string {
  const base = `${version.major}.${version.minor}.${version.patch}`;
  return version.prerelease ? `${base}-${version.prerelease}` : base;
}

/**
 * Parses the version file content to extract package name and version.
 *
 * @param content - Content like "@workflow/world-local@4.0.1-beta.20"
 * @returns Object with packageName and version
 */
export function parseVersionFile(content: string): {
  packageName: string;
  version: ParsedVersion;
} {
  const trimmed = content.trim();
  const lastAtIndex = trimmed.lastIndexOf('@');

  if (lastAtIndex <= 0) {
    throw new Error(`Invalid version file content: "${content}"`);
  }

  const packageName = trimmed.substring(0, lastAtIndex);
  const versionString = trimmed.substring(lastAtIndex + 1);

  return {
    packageName,
    version: parseVersion(versionString),
  };
}

/**
 * Formats the version file content.
 */
export function formatVersionFile(
  packageName: string,
  version: ParsedVersion
): string {
  return `${packageName}@${formatVersion(version)}`;
}

/**
 * Handles version upgrades between old and new versions.
 * This function is called when the data directory was created with a different version.
 *
 * @param oldVersion - The version that created the data directory
 * @param newVersion - The current package version
 * @throws {DataDirVersionError} If the versions are incompatible
 */
export function upgradeVersion(
  oldVersion: ParsedVersion,
  newVersion: ParsedVersion
): void {
  // stderr: CLI commands print JSON on stdout.
  console.warn(
    `[world-local] Upgrading from version ${formatVersion(oldVersion)} to ${formatVersion(newVersion)}`
  );
}

/**
 * Ensures the data directory exists and is writable.
 * Creates the directory if it doesn't exist, and its `.gitignore` if it has
 * none.
 *
 * @param dataDir - The path to the data directory
 * @throws {DataDirAccessError} If the directory cannot be created or accessed
 */
export async function ensureDataDir(dataDir: string): Promise<void> {
  const absolutePath = path.resolve(dataDir);

  // Try to create the directory if it doesn't exist
  try {
    await mkdir(absolutePath, { recursive: true });
  } catch (error: unknown) {
    const nodeError = error as NodeJS.ErrnoException;
    // EEXIST is fine - directory already exists
    if (nodeError.code !== 'EEXIST') {
      throw new DataDirAccessError(
        `Failed to create data directory "${absolutePath}": ${nodeError.message}`,
        absolutePath,
        nodeError.code
      );
    }
  }

  // Verify the directory is accessible (readable)
  try {
    await access(absolutePath, constants.R_OK);
  } catch (error: unknown) {
    const nodeError = error as NodeJS.ErrnoException;
    throw new DataDirAccessError(
      `Data directory "${absolutePath}" is not readable: ${nodeError.message}`,
      absolutePath,
      nodeError.code
    );
  }

  // Verify the directory is writable by attempting to write a temp file.
  // Its name is unique per call: concurrent checks of one directory (a World
  // writing its queue auth key while start() initializes the directory, or
  // two processes) must not share a file, because on Windows unlinking a file
  // another call still has open fails with EPERM.
  const testFile = path.join(
    absolutePath,
    `.workflow-write-test-${process.pid}-${randomBytes(6).toString('hex')}`
  );
  try {
    await writeFile(testFile, '');
    // Clean up test file. ENOENT during cleanup is harmless (may race
    // with another process performing the same check concurrently)
    await unlink(testFile).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
    });
  } catch (error: unknown) {
    const nodeError = error as NodeJS.ErrnoException;
    throw new DataDirAccessError(
      `Data directory "${absolutePath}" is not writable: ${nodeError.message}`,
      absolutePath,
      nodeError.code
    );
  }

  // A `.gitignore` that ignores everything in the directory, run data and the
  // queue auth key alike, whenever there is none. `wx` never overwrites one
  // that is already there, and a failure here never fails the World.
  await writeFile(path.join(absolutePath, '.gitignore'), '*\n', {
    flag: 'wx',
  }).catch(() => {});
}

/**
 * Reads the version from the data directory's version file.
 *
 * @param dataDir - Path to the data directory
 * @returns The parsed version info, or null if the file doesn't exist
 */
async function readVersionFile(dataDir: string): Promise<{
  packageName: string;
  version: ParsedVersion;
} | null> {
  const versionFilePath = path.join(path.resolve(dataDir), VERSION_FILENAME);

  try {
    const content = await readFile(versionFilePath, 'utf-8');
    return parseVersionFile(content);
  } catch (error: unknown) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/**
 * Writes the current version to the data directory's version file.
 *
 * @param dataDir - Path to the data directory
 * @param version - The version to write
 */
async function writeVersionFile(
  dataDir: string,
  version: ParsedVersion
): Promise<void> {
  const versionFilePath = path.join(path.resolve(dataDir), VERSION_FILENAME);
  const packageInfo = await getPackageInfo();
  const content = formatVersionFile(packageInfo.name, version);
  await writeFile(versionFilePath, content);
}

/**
 * What earlier releases stored as JSON files, one per entity. This release
 * stores everything in `world.db` and neither reads nor deletes them.
 */
const LEGACY_ENTRIES = [
  'runs',
  'events',
  'steps',
  'hooks',
  'waits',
  'streams',
  'snapshots',
  '.locks',
];

async function legacyEntriesIn(dataDir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of LEGACY_ENTRIES) {
    try {
      if ((await stat(path.join(dataDir, entry))).isDirectory()) {
        found.push(entry);
      }
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      throw error;
    }
  }
  return found;
}

/**
 * @deprecated No longer thrown: `initDataDir` leaves the JSON data of
 * earlier releases in place and never refuses a data directory for it. Kept
 * so imports of it keep compiling.
 */
export class DataDirLayoutError extends Error {
  readonly dataDir: string;
  readonly files: string[];

  constructor(dataDir: string, files: string[]) {
    super(
      `[world-local] ${path.resolve(dataDir)} holds files this version does not read (${files.slice(0, 5).join(', ')}).`
    );
    this.name = 'DataDirLayoutError';
    this.dataDir = dataDir;
    this.files = files;
  }
}

/**
 * Gets the suggested downgrade version based on the old version.
 * If a specific version is suggested in the error, use that.
 * Otherwise, suggest the previous minor version if patch is 0,
 * or previous major version if minor is also 0.
 */
function getSuggestedDowngradeVersion(
  oldVersion: ParsedVersion,
  suggestedVersion?: string
): string {
  if (suggestedVersion) {
    return suggestedVersion;
  }

  // Suggest the old version as the downgrade target
  return formatVersion(oldVersion);
}

/**
 * Initializes the data directory, ensuring it exists, is accessible,
 * and handles version compatibility.
 *
 * @param dataDir - The path to the data directory
 * @throws {DataDirAccessError} If the directory cannot be created or accessed
 */
export async function initDataDir(dataDir: string): Promise<void> {
  // First ensure the directory exists and is accessible
  await ensureDataDir(dataDir);

  // Run data written by earlier releases (one JSON file per entity) is not
  // migrated, and not deleted either: it stays where it is, unread, for the
  // user to keep or remove. This release only uses `world.db`.
  const legacy = await legacyEntriesIn(dataDir);
  if (legacy.length > 0) {
    debugLog(
      `[world-local] ${path.resolve(dataDir)} holds run data of an earlier release (${legacy.join(', ')}); it is left in place and not read`
    );
  }
  // Said once, when the data directory moves to this version (the version
  // file is rewritten then), so an upgrade explains why earlier runs are
  // gone from the CLI and the web UI.
  const noticeLegacy = () => {
    if (legacy.length === 0) return;
    console.info(
      `[world-local] Runs recorded by an earlier version of @workflow/world-local are no longer read (this version keeps its data in ${path.join(path.resolve(dataDir), 'world.db')}), so the CLI and the web UI do not list them. ` +
        `Their files are still in ${legacy.map((entry) => path.join(path.resolve(dataDir), entry)).join(', ')}, and can be deleted.`
    );
  };

  const packageInfo = await getPackageInfo();
  const currentVersion = parseVersion(packageInfo.version);

  // Read existing version file
  const existingVersionInfo = await readVersionFile(dataDir);

  if (existingVersionInfo === null) {
    // New data directory - write the current version
    await writeVersionFile(dataDir, currentVersion);
    noticeLegacy();
    return;
  }

  const { version: oldVersion } = existingVersionInfo;

  // Check if versions are the same (no upgrade needed)
  if (formatVersion(oldVersion) === formatVersion(currentVersion)) {
    return;
  }

  // Attempt upgrade
  try {
    upgradeVersion(oldVersion, currentVersion);
    // Upgrade succeeded - write the new version
    await writeVersionFile(dataDir, currentVersion);
    noticeLegacy();
  } catch (error: unknown) {
    const suggestedVersion =
      error instanceof DataDirVersionError ? error.suggestedVersion : undefined;

    const downgradeTarget = getSuggestedDowngradeVersion(
      oldVersion,
      suggestedVersion
    );

    console.error(
      `[world-local] Failed to upgrade data directory from version ${formatVersion(oldVersion)} to ${formatVersion(currentVersion)}:`,
      error instanceof Error ? error.message : error
    );
    console.error(
      `[world-local] Data is not compatible with the current version. ` +
        `Please downgrade to ${packageInfo.name}@${downgradeTarget}`
    );

    throw error;
  }
}
