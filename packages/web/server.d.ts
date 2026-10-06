import type { Server } from 'srvx';

/**
 * Start the standalone observability UI server on `port` (defaults to `PORT`, then 3000),
 * and resolve once it is listening.
 */
export function startServer(port?: number): Promise<Server>;
