/**
 * Runs before every @workflow/core unit test file (see `vitest.config.ts`).
 *
 * Off Vercel, the runtime builds a run's URLs from the port its process
 * listens on (`getPortLazy`), on every workflow replay and every step. A test
 * process listens on none, so the lookup finds nothing, caches nothing, and
 * asks the OS again on the next call: it reads `/proc` on Linux, and spawns
 * `lsof` on macOS and `netstat` on Windows, where one call takes up to a
 * second on a CI runner. A fan-out of a hundred background steps spent most
 * of its 60s test budget there. Answer "no port" at once, as the OS would:
 * URLs keep their `localhost:3000` fallback. The tests of the lookup itself
 * reset it (`resetPortCacheForTesting`).
 */
import { setPortResolverForTesting } from './src/runtime/get-port-lazy.js';

setPortResolverForTesting(async () => undefined);
