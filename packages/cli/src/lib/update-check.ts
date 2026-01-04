import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { logger } from './config/log.js';

// Constants
const PACKAGE_NAME = '@workflow/cli';
const NPM_REGISTRY = 'https://registry.npmjs.org';
const CACHE_DURATION_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const REQUEST_TIMEOUT_MS = 5000;

interface VersionCheckResult {
  currentVersion: string;
  latestVersion?: string;
  needsUpdate: boolean;
}

interface CachedVersionData {
  currentVersion: string;
  latestVersion: string;
  timestamp: number;
}

/**
 * Compare two semver versions including pre-release tags
 * Returns true if version a is greater than version b
 */
function compareVersions(a: string, b: string): boolean {
  const parseVersion = (v: string) => {
    const [base, prerelease] = v.split('-');
    const parts = base.split('.').map(Number);
    return { parts, prerelease };
  };

  const versionA = parseVersion(a);
  const versionB = parseVersion(b);

  // Compare major, minor, patch
  for (let i = 0; i < 3; i++) {
    if (versionA.parts[i] > versionB.parts[i]) return true;
    if (versionA.parts[i] < versionB.parts[i]) return false;
  }

  // If versions are equal up to patch level, check prerelease
  // No prerelease is considered greater than prerelease
  if (!versionA.prerelease && versionB.prerelease) return true;
  if (versionA.prerelease && !versionB.prerelease) return false;

  // Both have prereleases or both don't - they're equal
  if (versionA.prerelease && versionB.prerelease) {
    return versionA.prerelease > versionB.prerelease;
  }

  return false;
}

/**
 * Fetch the latest version from npm registry
 */
async function fetchLatestVersion(
  currentVersion: string
): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const url = `${NPM_REGISTRY}/${PACKAGE_NAME}`;
    logger.debug(`Checking for updates at ${url}`);

    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      logger.debug(
        `Failed to fetch package info: ${response.status} ${response.statusText}`
      );
      return null;
    }

    const data = (await response.json()) as {
      'dist-tags': { [tag: string]: string };
    };

    // Always use 'latest' tag - even beta versions are published as latest
    const latestVersion = data['dist-tags']['latest'];
    if (!latestVersion) {
      logger.debug('No latest version found in registry');
      return null;
    }

    logger.debug(`Current: ${currentVersion}, Latest: ${latestVersion}`);
    return latestVersion;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      logger.debug('Version check timed out after 5 seconds');
    } else {
      logger.debug(`Error fetching version: ${error}`);
    }
    return null;
  }
}

/**
 * Check if there's a new version available
 * Returns the current and latest version if an update is available
 */
export async function checkForUpdate(
  currentVersion: string
): Promise<VersionCheckResult> {
  const latestVersion = await fetchLatestVersion(currentVersion);

  if (!latestVersion) {
    return {
      currentVersion,
      needsUpdate: false,
    };
  }

  const needsUpdate = compareVersions(latestVersion, currentVersion);

  return {
    currentVersion,
    latestVersion,
    needsUpdate,
  };
}

/**
 * Read cached version data from file
 */
async function readCache(cacheFile: string): Promise<CachedVersionData | null> {
  try {
    const content = await readFile(cacheFile, 'utf-8');
    const data = JSON.parse(content) as CachedVersionData;
    return data;
  } catch {
    return null;
  }
}

/**
 * Write version data to cache file
 */
async function writeCache(
  cacheFile: string,
  data: CachedVersionData
): Promise<void> {
  try {
    await mkdir(dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, JSON.stringify(data, null, 2));
  } catch (error) {
    logger.debug(`Failed to write version cache: ${error}`);
  }
}

/**
 * Check if cache is still valid
 */
async function isCacheValid(
  cacheFile: string,
  currentVersion: string
): Promise<boolean> {
  try {
    const cached = await readCache(cacheFile);
    if (!cached) return false;

    // Cache is invalid if version changed
    if (cached.currentVersion !== currentVersion) {
      logger.debug('Version changed, cache invalidated');
      return false;
    }

    // Check if cache is still fresh
    const now = Date.now();
    const age = now - cached.timestamp;
    const isValid = age < CACHE_DURATION_MS;

    if (!isValid) {
      logger.debug(
        `Cache expired (age: ${Math.floor(age / 1000 / 60)} minutes)`
      );
    }

    return isValid;
  } catch {
    return false;
  }
}

/**
 * Check for updates with filesystem caching
 * Cache is valid unless the local version changes
 */
export async function checkForUpdateCached(
  currentVersion: string,
  cacheFile: string
): Promise<VersionCheckResult> {
  // Check if cache is valid
  if (await isCacheValid(cacheFile, currentVersion)) {
    logger.debug('Using cached version check result');
    const cached = await readCache(cacheFile);
    if (cached) {
      return {
        currentVersion: cached.currentVersion,
        latestVersion: cached.latestVersion,
        needsUpdate: compareVersions(
          cached.latestVersion,
          cached.currentVersion
        ),
      };
    }
  }

  // Perform fresh check
  logger.debug('Performing fresh version check');
  const result = await checkForUpdate(currentVersion);

  // Cache the result if we got a latest version
  if (result.latestVersion) {
    await writeCache(cacheFile, {
      currentVersion: result.currentVersion,
      latestVersion: result.latestVersion,
      timestamp: Date.now(),
    });
  }

  return result;
}
