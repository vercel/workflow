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

// /**
//  * Check if the Vercel dashboard workflows page is available
//  */
// export async function checkVercelDashboardAvailable(
//   teamSlug: string,
//   projectName: string,
//   authToken: string
// ): Promise<boolean> {
//   try {
//     const dashboardUrl = `https://vercel.com/${teamSlug}/${projectName}/ai/workflows`;
//     logger.debug(`Checking Vercel dashboard availability: ${dashboardUrl}`);

//     const response = await fetch(dashboardUrl, {
//       method: 'HEAD',
//       redirect: 'follow',
//       headers: {
//         Authorization: `Bearer ${authToken}`,
//       },
//     });

//     // Consider 2xx and 3xx as success
//     const isAvailable = response.status >= 200 && response.status < 400;
//     logger.debug(
//       `Dashboard check result: ${response.status} - ${isAvailable ? 'available' : 'not available'}`
//     );

//     return isAvailable;
//   } catch (error) {
//     logger.debug(`Error checking dashboard availability: ${error}`);
//     return false;
//   }
// }

/**
 * Get the Vercel dashboard URL for workflows
 */
export function getVercelDashboardUrl(
  teamSlug: string,
  projectName: string,
  resource: string,
  id?: string
): string {
  let url = `https://vercel.com/${teamSlug}/${projectName}/observability/workflows`;

  // Add resource-specific path segments
  if (resource === 'run' && id) {
    url += `/runs/${id}?environment=production`;
  } else if (id) {
    url += `?${resource}Id=${id}`;
  }

  return url;
}
