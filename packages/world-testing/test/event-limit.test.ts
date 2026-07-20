import { eventLimit } from '../src/event-limit.mjs';

// Local-only: enforcement needs a world that returns `maxEvents` on the
// run_started response. The Local World does (via WORKFLOW_MAX_EVENTS); the
// Postgres world doesn't yet, so this is not part of the shared createTestSuite.
eventLimit('local');
