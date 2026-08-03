import chalk from 'chalk';
import { logger } from '../config/log.js';

interface VercelTeam {
  id: string;
  slug: string;
}

/**
 * Fetch team information from Vercel API
 * Timeout: 5 seconds - falls back to local UI if the request fails or times out
 */
export async function fetchTeamInfo(
  teamId: string,
  authToken: string
): Promise<{ teamSlug: string } | null> {
  try {
    // Create an AbortController with a 5 second timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`https://api.vercel.com/v2/teams/${teamId}`, {
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
      signal: controller.signal,
    });

    // Clear the timeout if the request completes successfully
    clearTimeout(timeoutId);

    if (response.status === 401 || response.status === 403) {
      logger.error(
        chalk.red(
          `Authentication failed (${response.status}): Unable to access team information`
        )
      );
      logger.warn(
        chalk.yellow(
          '\nPlease ensure you are logged in and have access to the team:'
        )
      );
      logger.warn(chalk.yellow('  Run `vercel login` to authenticate'));
      return null;
    }

    if (!response.ok) {
      logger.debug(
        `Failed to fetch team info: ${response.status} ${response.statusText}`
      );
      return null;
    }

    const team = (await response.json()) as VercelTeam;
    return {
      teamSlug: team.slug,
    };
  } catch (error) {
    // Handle both timeout and other errors - fall back to local UI
    if (error instanceof Error && error.name === 'AbortError') {
      logger.debug(
        'Vercel API request timed out after 5 seconds, falling back to local UI'
      );
    } else {
      logger.debug(`Error fetching team info: ${error}`);
    }
    return null;
  }
}

/**
 * Get the Vercel dashboard URL for workflows.
 *
 * Format: https://vercel.com/<teamSlug>/<projectSlug>/workflows/runs/<runId>?environment=<env>
 * (the older `/observability/workflows` route is no longer used).
 */
export function getVercelDashboardUrl(
  teamSlug: string,
  projectName: string,
  resource: string,
  id?: string,
  environment = 'production'
): string {
  const base = `https://vercel.com/${teamSlug}/${projectName}/workflows`;
  const env = `environment=${environment}`;

  // Add resource-specific path segments
  if (resource === 'run' && id) {
    return `${base}/runs/${id}?${env}`;
  }
  if (id) {
    return `${base}?${resource}Id=${id}&${env}`;
  }
  return `${base}?${env}`;
}
