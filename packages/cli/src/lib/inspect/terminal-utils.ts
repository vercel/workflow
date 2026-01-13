/**
 * Utilities for terminal display and environment detection
 */

/**
 * Check if running in CI environment
 */
export const isCI = (): boolean => {
  return !!(
    process.env.CI ||
    process.env.CONTINUOUS_INTEGRATION ||
    process.env.BUILD_NUMBER ||
    process.env.GITHUB_ACTIONS ||
    process.env.GITLAB_CI ||
    process.env.CIRCLECI ||
    process.env.TRAVIS ||
    process.env.JENKINS_URL ||
    process.env.BUILDKITE ||
    process.env.TF_BUILD
  );
};

/**
 * Check if running in an interactive terminal
 */
export const isInteractive = (): boolean => {
  return !isCI() && !!process.stdout.isTTY;
};

/**
 * Get the current terminal width
 */
export const getTerminalWidth = (): number => {
  return process.stdout.columns || 80; // Default to 80 if not available
};

/**
 * Calculate display settings based on terminal width
 */
export interface DisplaySettings {
  showRelativeDates: boolean;
  dataFieldWidth: number;
  abbreviateStatus: boolean;
  namesTruncateLength: number;
  truncateIdsToLastChars: boolean;
  hideCompletedAt: boolean;
}

export const getDisplaySettings = (
  terminalWidth: number,
  withData: boolean,
  isRunTable: boolean = true
): DisplaySettings => {
  // Base widths from actual measurements (without data fields)
  const baseWidth = (isRunTable ? 140 : 170) + (withData ? 32 : 0);

  // Initialize with defaults
  const settings: DisplaySettings = {
    showRelativeDates: !withData, // Disabled by default when withData is true
    dataFieldWidth: 15,
    abbreviateStatus: false,
    namesTruncateLength: 40,
    truncateIdsToLastChars: false,
    hideCompletedAt: false,
  };

  // If terminal width is sufficient, return defaults
  if (terminalWidth >= baseWidth) {
    return settings;
  }

  // Progressive degradation avenues
  let availableWidth = baseWidth;

  // Disable relative dates (save 34 characters)
  if (settings.showRelativeDates && terminalWidth < availableWidth) {
    settings.showRelativeDates = false;
    availableWidth -= 34;
  }

  // Reduce data field width if withData is set (save 20 characters from 2*10)
  if (
    withData &&
    settings.dataFieldWidth === 15 &&
    terminalWidth < availableWidth
  ) {
    settings.dataFieldWidth = 5;
    availableWidth -= 20;
  }

  // Abbreviate status and set header to "S" (save 8 characters)
  if (terminalWidth < availableWidth) {
    settings.abbreviateStatus = true;
    availableWidth -= 8;
  }

  // Trim names from 40 to 20 characters (save 20 characters)
  if (settings.namesTruncateLength === 40 && terminalWidth < availableWidth) {
    settings.namesTruncateLength = 20;
    availableWidth -= 20;
  }

  // Hide completedAt column (save 23 characters)
  if (terminalWidth < availableWidth) {
    settings.hideCompletedAt = true;
    availableWidth -= 23;
  }

  // Trim IDs to last 4 characters
  if (terminalWidth < availableWidth) {
    settings.truncateIdsToLastChars = true;
    availableWidth -= isRunTable ? 24 : 48;
  }

  return settings;
};

/**
 * Format status with optional abbreviation
 */
export const formatStatus = (status: string, abbreviated: boolean): string => {
  if (!abbreviated) {
    return status;
  }

  // Abbreviate to first letter
  const abbrevMap: Record<string, string> = {
    running: 'R',
    completed: 'C',
    failed: 'F',
    cancelled: 'X',
    pending: 'P',
  };

  return abbrevMap[status.toLowerCase()] || status.charAt(0).toUpperCase();
};

/**
 * Format ISO date without T and Z characters
 */
export const formatISODate = (date: Date): string => {
  const isoString = date.toISOString();
  // Replace T with space and remove Z
  return isoString.replace('T', ' ').replace('Z', '');
};
