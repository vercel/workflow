import {
  type Credentials,
  CredentialsStore,
} from '@vercel/cli-auth/credentials-store.js';
import { OAuth } from '@vercel/cli-auth/oauth.js';
import { getUserAgent } from '@vercel/cli-auth/user-agent.js';
import { logger } from '../config/log.js';

const VERCEL_ISSUER = new URL('https://vercel.com');
const VERCEL_CLI_CLIENT_ID = 'cl_HYyOPBNtFMfHhaUn9L4QPfTZz6TP47bp';
const CREDENTIALS_DIR = 'com.vercel.cli';

const store = CredentialsStore(CREDENTIALS_DIR);

/**
 * Reads the auth token, refreshing it via OAuth if expired.
 *
 * Uses `@vercel/cli-auth` to:
 * 1. Read credentials from disk (`auth.json`)
 * 2. Check if the access token is expired
 * 3. If expired, use the refresh token to obtain a new access token
 * 4. Persist the updated credentials back to disk
 *
 * Returns the valid access token, or `null` if credentials are
 * missing or the refresh fails.
 */
export async function getAuthToken(): Promise<string | null> {
  let credentials: Credentials;
  try {
    credentials = store.get();
  } catch {
    return null;
  }
  if (!credentials?.token) {
    return null;
  }

  // If there's no expiration info, assume the token is valid
  // (e.g. legacy tokens without OAuth)
  if (typeof credentials.expiresAt !== 'number') {
    return credentials.token;
  }

  const nowInSeconds = Math.floor(Date.now() / 1000);
  if (credentials.expiresAt >= nowInSeconds) {
    // Token is still valid
    return credentials.token;
  }

  // Token is expired — attempt refresh
  if (!credentials.refreshToken) {
    logger.debug('Auth token expired and no refresh token available');
    return null;
  }

  logger.debug('Auth token expired, refreshing via OAuth...');
  try {
    const userAgent = getUserAgent({
      name: '@workflow/cli',
      version: '0.0.0',
    });

    const oauth = OAuth({
      issuer: VERCEL_ISSUER,
      clientId: VERCEL_CLI_CLIENT_ID,
      userAgent,
    });
    const client = await oauth.init();
    const tokenSet = await client.refreshToken(credentials.refreshToken);

    const updatedCredentials = {
      ...credentials,
      token: tokenSet.access_token,
      expiresAt: Math.floor(Date.now() / 1000) + tokenSet.expires_in,
      ...(tokenSet.refresh_token
        ? { refreshToken: tokenSet.refresh_token }
        : {}),
    };

    store.update(updatedCredentials);
    logger.debug('Auth token refreshed successfully');

    return tokenSet.access_token;
  } catch (error) {
    logger.debug('Failed to refresh auth token:', error);
    return null;
  }
}
