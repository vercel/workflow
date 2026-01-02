import {
  accessSync,
  constants,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

/** Package name for version tracking */
export const PACKAGE_NAME = '@workflow/world-local';

/** Current package version - imported at build time */
export const PACKAGE_VERSION = '4.0.1-beta.20';

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
  console.log(
    `[world-local] Upgrading from version ${formatVersion(oldVersion)} to ${formatVersion(newVersion)}`
  );
  // Future: Add migration logic here when needed
}

/**
 * Ensures the data directory exists and is writable.
 * Creates the directory if it doesn't exist.
 *
 * @param dataDir - The path to the data directory
 * @throws {DataDirAccessError} If the directory cannot be created or accessed
 */
export function ensureDataDir(dataDir: string): void {
  const absolutePath = path.resolve(dataDir);

  // Try to create the directory if it doesn't exist
  try {
    mkdirSync(absolutePath, { recursive: true });
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
    accessSync(absolutePath, constants.R_OK);
  } catch (error: unknown) {
    const nodeError = error as NodeJS.ErrnoException;
    throw new DataDirAccessError(
      `Data directory "${absolutePath}" is not readable: ${nodeError.message}`,
      absolutePath,
      nodeError.code
    );
  }

  // Verify the directory is writable by attempting to write a temp file
  const testFile = path.join(
    absolutePath,
    `.workflow-write-test-${Date.now()}`
  );
  try {
    writeFileSync(testFile, '');
    unlinkSync(testFile);
  } catch (error: unknown) {
    const nodeError = error as NodeJS.ErrnoException;
    throw new DataDirAccessError(
      `Data directory "${absolutePath}" is not writable: ${nodeError.message}`,
      absolutePath,
      nodeError.code
    );
  }
}

/**
 * Reads the version from the data directory's version file.
 *
 * @param dataDir - Path to the data directory
 * @returns The parsed version info, or null if the file doesn't exist
 */
function readVersionFile(dataDir: string): {
  packageName: string;
  version: ParsedVersion;
} | null {
  const versionFilePath = path.join(path.resolve(dataDir), VERSION_FILENAME);

  try {
    const content = readFileSync(versionFilePath, 'utf-8');
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
function writeVersionFile(dataDir: string, version: ParsedVersion): void {
  const versionFilePath = path.join(path.resolve(dataDir), VERSION_FILENAME);
  const content = formatVersionFile(PACKAGE_NAME, version);
  writeFileSync(versionFilePath, content);
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
export function initDataDir(dataDir: string): void {
  // First ensure the directory exists and is accessible
  ensureDataDir(dataDir);

  const currentVersion = parseVersion(PACKAGE_VERSION);

  // Read existing version file
  const existingVersionInfo = readVersionFile(dataDir);

  if (existingVersionInfo === null) {
    // New data directory - write the current version
    writeVersionFile(dataDir, currentVersion);
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
    writeVersionFile(dataDir, currentVersion);
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
        `Please downgrade to ${PACKAGE_NAME}@${downgradeTarget}`
    );

    throw error;
  }
}
