/**
 * Registry of known world packages that the UI can work with.
 *
 * This file defines the metadata for worlds that can be selected in the
 * configuration UI. Worlds are dynamically loaded at runtime - they don't
 * need to be direct dependencies of the web package.
 */

export interface KnownWorld {
  /** Unique identifier used in the UI and query params */
  id: string;
  /** Human-readable display name */
  displayName: string;
  /** npm package name (or null for built-in worlds) */
  packageName: string | null;
  /** Short description of the world */
  description: string;
  /** Whether this world is bundled with @workflow/core */
  isBuiltIn: boolean;
}

/**
 * List of known worlds that can be configured in the UI.
 *
 * Built-in worlds (local, vercel) are always available as they're bundled
 * with @workflow/core. Third-party worlds need to be installed separately.
 */
export const KNOWN_WORLDS: KnownWorld[] = [
  {
    id: 'local',
    displayName: 'Local',
    packageName: null,
    description:
      'Local file-based storage with no dependencies, ideal for development',
    isBuiltIn: true,
  },
  {
    id: 'vercel',
    displayName: 'Vercel',
    packageName: null,
    description: 'Vercel-managed storage and queue',
    isBuiltIn: true,
  },
  {
    id: 'postgres',
    displayName: 'PostgreSQL',
    packageName: '@workflow/world-postgres',
    description: 'PostgreSQL-based storage with pg-boss queue',
    isBuiltIn: false,
  },
];
